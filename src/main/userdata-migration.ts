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
//   COPY, never move/delete the legacy trees - rollback stays possible and a
//   partially copied tree is recoverable by re-running.
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

function emptyResult(source: string | null): TreeMigrationResult {
  return { source, copied: 0, skipped: 0, purged: 0, errors: [] };
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
    if (fs.existsSync(path.join(dstRoot, MARKER))) return emptyResult(srcRoot);
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

/**
 * Copy legacy vibeyard-named user data into the finevibe locations.
 * Pure filesystem code (no electron imports) so it is unit-testable; the
 * caller supplies the resolved Electron paths. Idempotent: the marker file
 * at each destination short-circuits every later launch. Never throws.
 */
export function migrateLegacyUserData(opts: UserDataMigrationOptions): UserDataMigrationReport {
  const homeSrc = path.join(opts.homedir, LEGACY_HOME_DIR);
  const homeDst = path.join(opts.homedir, '.finevibe');
  const appDataSrc = LEGACY_APP_DATA_DIRS
    .map((name) => path.join(opts.appDataDir, name))
    .find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory()) ?? null;

  return {
    home: migrateTree(homeSrc, homeDst),
    appData: appDataSrc ? migrateTree(appDataSrc, opts.userDataDir) : emptyResult(null),
  };
}
