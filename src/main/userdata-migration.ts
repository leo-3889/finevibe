import * as fs from 'fs';
import * as path from 'path';

// One-time data migration for the vibeyard -> finevibe identity cutover
// (4fc533c on this tree). Two trees changed names and both carry user data:
//   - the renderer state tree: `~/.vibeyard/state.json` (+ profiles, mcp) ->
//     `~/.finevibe/...` (store.ts STATE_DIR);
//   - Electron userData: `%APPDATA%/Vibeyard` (packaged productName) or
//     `%APPDATA%/vibeyard` (dev package name) -> the current userData dir
//     (Chromium state, browser partitions, probe cache).
// An install updating across the cutover would otherwise resolve fresh empty
// dirs and start with no projects, history, cookies, or cache.
//
// Contract (mirrors the f61453b-lineage migration this replaces):
//   COPY first, never move: rollback stays possible and a partially copied
//   tree is recoverable by re-running. Retirement (A3, retireLegacyUserData)
//   then closes the lifecycle - copy -> verify -> retire: every clean pass
//   records the copy in a userData ledger (file count + bytes), and the
//   legacy userData tree is deleted only after a 30-day grace, a
//   destination integrity check (dest subtree file count >= the recorded
//   count) and with no opt-out file present. Pre-ledger copies (fileCount
//   -1) are never auto-retired. The HOME tree (`~/.vibeyard`, still read by
//   legacy-import.ts's project importer) is outside retirement entirely.
//   Destination wins: a file that already exists at the destination is never
//   overwritten (the app may have written newer data under the new name).
//   Browser partitions keyed by the OLD prefix (`vibeyard-browser-iso-*`)
//   are never opened by the new app - they are purged (not copied).
//   Per-file failure (locked Chromium leveldb/cookie files when a legacy
//   instance is still running) is recorded and the walk continues.
//   A marker file at each destination makes the migration a no-op on every
//   later launch (no re-walk of a 10k-file Chromium tree at boot).

const MARKER = '.finevibe-migrated';
const LEGACY_HOME_DIR = '.vibeyard';
/** Packaged `app.getName()` was the productName; dev launches used the package name. */
const LEGACY_APP_DATA_DIRS = ['Vibeyard', 'vibeyard'];
/** Old browser-partition prefix; the new app keys partitions by `finevibe-browser-iso-`. */
const STALE_PARTITION_PREFIXES = ['vibeyard-browser-iso-', 'vibeyard-browser-'];

/** A3: ledger of completed migrations, kept in userData (retirement input). */
const LEDGER_FILE = '.finevibe-migrations.json';
/** A3: how long a migrated legacy tree must sit untouched before retirement. */
export const RETIRE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** A3: presence of this userData file disables retirement entirely. */
const OPT_OUT_FILE = 'retire-legacy-user-data.off';
/** A3: audit log of retirement attempts (getLegacyRetirementStatus reads it). */
const RETIREMENT_LOG = 'legacy-retirement.json';
/** FIFO cap on the retirement audit log (mirrors the C3M-05 cap idiom). */
const MAX_RETIREMENT_LOG_ENTRIES = 50;

export interface TreeMigrationResult {
  /** Legacy source dir, or null when there was nothing to migrate. */
  source: string | null;
  copied: number;
  /** Files not copied: already present at the destination (dest wins). */
  skipped: number;
  /** Stale-partition entries purged (dropped, not copied). */
  purged: number;
  /** Per-file failures (locked files, symlink loops); the walk continues. */
  errors: string[];
  /** A3: total bytes copied, accumulated during the walk (retirement accounting). */
  copiedBytes: number;
  /** A3: the destination marker already existed - copied by an earlier launch. */
  alreadyMigrated: boolean;
}

export interface UserDataMigrationReport {
  home: TreeMigrationResult;
  appData: TreeMigrationResult;
}

export interface UserDataMigrationOptions {
  homedir: string;
  appDataDir: string;
  userDataDir: string;
}

/** A3: one completed migration, recorded in `userData/.finevibe-migrations.json`. */
export interface MigrationLedgerRecord {
  /** Stable id: 'home' (state tree) | 'appData' (userData tree). */
  id: string;
  from: string;
  to: string;
  completedAt: string;
  /**
   * Files the copy put in place (copied + dest-wins skipped; purged stale
   * partitions are not counted). -1 = the copy ran under a code version
   * without ledger accounting: integrity is unverifiable, so the tree is
   * NEVER auto-retired.
   */
  fileCount: number;
  copiedBytes: number;
}

/** A3: one retirement attempt, appended to `userData/legacy-retirement.json`. */
export interface LegacyRetirementEntry {
  id: string;
  from: string;
  at: string;
  outcome: 'removed' | 'kept' | 'unverified' | 'error';
  bytesFreed?: number;
  reason?: string;
}

function emptyResult(source: string | null): TreeMigrationResult {
  return { source, copied: 0, skipped: 0, purged: 0, errors: [], copiedBytes: 0, alreadyMigrated: false };
}

/** Relative path under `root` is a stale legacy browser partition dir. */
function isStalePartitionRel(rel: string): boolean {
  const parts = rel.split(path.sep);
  if (parts.length < 2 || parts[0] !== 'Partitions') return false;
  return STALE_PARTITION_PREFIXES.some((p) => parts[1].startsWith(p));
}

function walkFiles(root: string, rel: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue; // never follow symlinks across trees
    if (entry.isDirectory()) walkFiles(root, entryRel, out);
    else if (entry.isFile()) out.push(entryRel);
  }
}

function copyMissingTree(srcRoot: string, dstRoot: string): TreeMigrationResult {
  const result = emptyResult(srcRoot);
  const files: string[] = [];
  walkFiles(srcRoot, '', files);
  for (const rel of files) {
    if (isStalePartitionRel(rel)) {
      result.purged += 1;
      continue;
    }
    const src = path.join(srcRoot, rel);
    const dst = path.join(dstRoot, rel);
    try {
      if (fs.existsSync(dst)) {
        result.skipped += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      result.copied += 1;
      try {
        result.copiedBytes += fs.statSync(src).size;
      } catch {
        // Byte accounting is best-effort; the file-count integrity gate stands.
      }
    } catch (error) {
      // Locked file (a legacy instance still running) or permission oddity:
      // record and continue - a partial copy is merged by the next launch
      // (the marker below is only written when nothing failed).
      result.errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function migrateTree(srcRoot: string, dstRoot: string): TreeMigrationResult {
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    return emptyResult(null);
  }
  try {
    if (fs.existsSync(path.join(dstRoot, MARKER))) {
      const migrated = emptyResult(srcRoot);
      migrated.alreadyMigrated = true;
      return migrated;
    }
  } catch {
    /* unreadable marker path -> fall through and attempt the merge copy */
  }
  fs.mkdirSync(dstRoot, { recursive: true });
  const result = copyMissingTree(srcRoot, dstRoot);
  if (result.errors.length === 0) {
    try {
      fs.writeFileSync(
        path.join(dstRoot, MARKER),
        `migrated from ${srcRoot} at ${new Date().toISOString()}\n` +
          `copied=${result.copied} skipped=${result.skipped} purged=${result.purged}\n`,
      );
    } catch {
      /* marker failure only costs a re-walk at the next launch */
    }
  }
  return result;
}

function readLedger(userDataDir: string): MigrationLedgerRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, LEDGER_FILE), 'utf8'));
    const list: unknown = Array.isArray(raw?.migrations) ? raw.migrations : [];
    return (list as MigrationLedgerRecord[]).filter(
      (r) =>
        !!r &&
        typeof r.id === 'string' &&
        typeof r.from === 'string' &&
        typeof r.to === 'string' &&
        typeof r.completedAt === 'string' &&
        typeof r.fileCount === 'number',
    );
  } catch {
    return [];
  }
}

function recordMigration(userDataDir: string, record: MigrationLedgerRecord): void {
  try {
    const records = readLedger(userDataDir);
    const i = records.findIndex((r) => r.id === record.id);
    if (i >= 0) records[i] = record;
    else records.push(record);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, LEDGER_FILE),
      JSON.stringify({ migrations: records }, null, 2) + '\n',
    );
  } catch {
    // A ledger failure only costs retirement visibility - the trees stay.
  }
}

/**
 * Ledger one migrateTree outcome (A3). Only clean passes (the marker was
 * written) are recorded; a marker from an older code version is recorded as
 * unverified (`fileCount: -1`) exactly once, dated by the marker's mtime so
 * the grace period measures from the copy that actually ran.
 */
function ledgerTree(
  userDataDir: string,
  id: string,
  from: string,
  to: string,
  result: TreeMigrationResult,
): void {
  if (!result.source || result.errors.length > 0) return;
  if (result.alreadyMigrated) {
    if (readLedger(userDataDir).some((r) => r.id === id)) return;
    let completedAt = new Date().toISOString();
    try {
      completedAt = fs.statSync(path.join(to, MARKER)).mtime.toISOString();
    } catch {
      /* unreadable marker -> grace measured from discovery time */
    }
    recordMigration(userDataDir, { id, from, to, completedAt, fileCount: -1, copiedBytes: -1 });
    return;
  }
  recordMigration(userDataDir, {
    id,
    from,
    to,
    completedAt: new Date().toISOString(),
    fileCount: result.copied + result.skipped,
    copiedBytes: result.copiedBytes,
  });
}

const FOLDS_CASE = process.platform === 'win32';

function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return FOLDS_CASE ? resolved.toLowerCase() : resolved;
}

/** `p` is strictly inside `root` (resolved; case-folded on Windows). */
function pathUnder(root: string, p: string): boolean {
  return pathKey(p).startsWith(pathKey(root) + path.sep);
}

function treeSizeBytes(root: string): number {
  const files: string[] = [];
  walkFiles(root, '', files);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += fs.statSync(path.join(root, rel)).size;
    } catch {
      // Vanished mid-walk; the deletion below does not depend on the total.
    }
  }
  return bytes;
}

/**
 * Copy legacy vibeyard-named user data into the finevibe locations.
 * Pure filesystem code (no electron imports) so it is unit-testable; the
 * caller supplies the resolved Electron paths. Idempotent: the marker file
 * at each destination short-circuits every later launch. Never throws.
 * Every clean pass also records the copy in the userData ledger (A3).
 */
export function migrateLegacyUserData(opts: UserDataMigrationOptions): UserDataMigrationReport {
  const homeSrc = path.join(opts.homedir, LEGACY_HOME_DIR);
  const homeDst = path.join(opts.homedir, '.finevibe');
  const appDataSrc = LEGACY_APP_DATA_DIRS
    .map((name) => path.join(opts.appDataDir, name))
    .find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) ?? null;

  const home = migrateTree(homeSrc, homeDst);
  const appData = appDataSrc ? migrateTree(appDataSrc, opts.userDataDir) : emptyResult(null);
  ledgerTree(opts.userDataDir, 'home', homeSrc, homeDst, home);
  if (appDataSrc) ledgerTree(opts.userDataDir, 'appData', appDataSrc, opts.userDataDir, appData);
  return { home, appData };
}

export interface LegacyRetirementOptions {
  userDataDir: string;
  appDataDir: string;
}

function retireRecord(
  record: MigrationLedgerRecord,
  opts: LegacyRetirementOptions,
  optOut: boolean,
  now: number,
): LegacyRetirementEntry | null {
  const at = new Date(now).toISOString();
  const kept = (reason: string): LegacyRetirementEntry =>
    ({ id: record.id, from: record.from, at, outcome: 'kept', reason });
  // Already retired (or the legacy tree vanished on its own): a true no-op,
  // so the second and every later launch writes nothing.
  if (!fs.existsSync(record.from)) return null;
  // Home-tree guard, structural: retirement only ever reaches trees under
  // appData. `~/.vibeyard` is still READ by legacy-import.ts's project
  // importer and is out of retirement scope entirely — a silent skip, so a
  // home record never churns the audit log on every launch.
  if (!pathUnder(opts.appDataDir, record.from)) return null;
  if (optOut) return kept(`opt-out: ${OPT_OUT_FILE} present in userData`);
  if (record.fileCount < 0) {
    return {
      id: record.id,
      from: record.from,
      at,
      outcome: 'unverified',
      reason: 'copy predates ledger accounting - destination integrity cannot be verified; never auto-retired',
    };
  }
  const completedAt = Date.parse(record.completedAt);
  if (!Number.isFinite(completedAt)) return kept('unparseable completedAt in the ledger record');
  const graceMs = now - completedAt;
  if (graceMs < RETIRE_GRACE_MS) {
    return kept(`grace not elapsed: ${Math.floor(graceMs / 86_400_000)} of 30 days`);
  }
  // Integrity: the destination subtree must still hold at least the file
  // count the copy put in place. Walked once per eligible record (grace-
  // gated, and the tree is gone after removal), never per launch.
  const destFiles: string[] = [];
  walkFiles(record.to, '', destFiles);
  // The migration's own bookkeeping (ledger + opt-out sentinel live at the
  // userData top level, inside `to`) is not copied payload: counting them
  // lets integrity pass on a half-deleted destination.
  const payload = destFiles.filter((f) => f !== LEDGER_FILE && f !== OPT_OUT_FILE);
  if (payload.length < record.fileCount) {
    return kept(
      `integrity: destination holds ${payload.length} files, migration recorded ${record.fileCount}`,
    );
  }
  const bytesFreed = treeSizeBytes(record.from);
  try {
    fs.rmSync(record.from, { recursive: true, force: true });
    return { id: record.id, from: record.from, at, outcome: 'removed', bytesFreed };
  } catch (error) {
    return {
      id: record.id,
      from: record.from,
      at,
      outcome: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A3: retire the legacy userData trees the migration ledger says were
 * copied, once every gate passes per record: 30-day grace from
 * `completedAt`, destination integrity (dest subtree file count >= the
 * recorded count), no `retire-legacy-user-data.off` opt-out in userData,
 * the source strictly under appData, and a verified record (a pre-ledger
 * copy with `fileCount: -1` is only reported 'unverified', never deleted).
 * Removal is `fs.rmSync` recursive; every outcome lands in
 * `userData/legacy-retirement.json`. Call AFTER migrateLegacyUserData at
 * startup. Never throws.
 */
export function retireLegacyUserData(opts: LegacyRetirementOptions): LegacyRetirementEntry[] {
  const now = Date.now();
  const entries: LegacyRetirementEntry[] = [];
  let optOut = false;
  try {
    optOut = fs.existsSync(path.join(opts.userDataDir, OPT_OUT_FILE));
    for (const record of readLedger(opts.userDataDir)) {
      let entry: LegacyRetirementEntry | null;
      try {
        entry = retireRecord(record, opts, optOut, now);
      } catch (error) {
        entry = {
          id: record.id,
          from: record.from,
          at: new Date(now).toISOString(),
          outcome: 'error',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (entry) entries.push(entry);
    }
  } catch {
    /* retirement is best-effort; a failed pass costs disk, never data */
  }
  if (entries.length) appendRetirementLog(opts.userDataDir, entries);
  return entries;
}

function appendRetirementLog(userDataDir: string, entries: LegacyRetirementEntry[]): void {
  try {
    let log: LegacyRetirementEntry[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, RETIREMENT_LOG), 'utf8'));
      if (Array.isArray(raw)) log = raw as LegacyRetirementEntry[];
    } catch {
      /* first write / corrupt log -> start over */
    }
    log = log.concat(entries).slice(-MAX_RETIREMENT_LOG_ENTRIES);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, RETIREMENT_LOG), JSON.stringify(log, null, 2) + '\n');
  } catch {
    /* audit-log failure never costs the deletion */
  }
}

/** The parsed retirement audit log ([] when absent or corrupt). */
export function getLegacyRetirementStatus(userDataDir: string): LegacyRetirementEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, RETIREMENT_LOG), 'utf8'));
    return Array.isArray(raw) ? (raw as LegacyRetirementEntry[]) : [];
  } catch {
    return [];
  }
}
