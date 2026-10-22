import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { isWin } from './platform';
import { loadState } from './store';

/**
 * Per-launch session storage for the Pi-compatible CLIs (Pi and OMP).
 *
 * Every Pi/OMP launch gets a directory of its own; the CLI is pointed at it
 * with `--session-dir`, so the transcripts a launch produces can ONLY appear
 * in that directory. That directory is the process-scoped ownership signal
 * the sessions watcher adopts by: a file in the directory belongs to the
 * session that owns the directory — no cwd matching, no timestamp freshness
 * window, no cross-tab ambiguity.
 *
 * The directory is derived from the UI session id (deterministic), so it
 * survives a restart without any persisted mapping: a resumed tab recomputes
 * the same directory and finds its own transcripts there. A sidecar
 * (`.finevibe.json`) records the launch's profile/cwd so global session
 * search can surface these transcripts with the right profile.
 *
 * Retention: dirs under a base are swept by pruneLaunchSessionDirs() —
 * at most once per base per process, deferred off the spawn path — when
 * EVERY timestamp they expose (sidecar `createdAt`, newest transcript,
 * dir mtime) is older than LAUNCH_SESSION_RETENTION_MS. The sweep NEVER
 * deletes a dir registered with protectLaunchSessionDir(): a resumed
 * tab's dir is pre-existing and fully expired (its transcript lives in
 * the 30-60-day window), so without that exclusion the sweep scheduled
 * by the launch which resumes the tab deletes the transcript's only
 * copy (these dirs never enter the CLI store; docs/session-lifecycle.md).
 *
 * Legacy transcripts (default agent dir, profile trees, external CLI runs)
 * stay exactly where they are — nothing is moved or deleted; discovery
 * covers both locations.
 */

export type LaunchSessionProvider = 'pi' | 'omp';

/** A UI session id becomes a directory name; it must not escape the base dir. */
const UI_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Base directory holding every per-launch session dir for one provider. */
export function launchSessionBaseDir(providerId: LaunchSessionProvider): string {
  return path.join(app.getPath('userData'), providerId === 'pi' ? 'pi-sessions' : 'omp-sessions');
}

/**
 * The exclusive per-launch session dir for one UI session. Unsafe id
 * characters are sanitized (never thrown — a weird id must not break a
 * spawn); the result is always inside the provider's base dir.
 *
 * S1-10: a bare sanitizer collapse is not injective — 'a:b' and 'a/b'
 * both map to 'a_b', and two concurrent sessions with colliding spellings
 * would share one "exclusive" dir (interleaved transcripts, crossed watcher
 * attribution, prune treating them as one). A rewritten id carries an
 * FNV-1a hash of the raw id; app-generated uuid ids match the regex and
 * keep their historical spelling.
 */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function launchSessionDir(providerId: LaunchSessionProvider, uiSessionId: string): string {
  const safe = UI_SESSION_ID_RE.test(uiSessionId)
    ? uiSessionId
    : `${uiSessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 119)}-${fnv1aHex(uiSessionId)}` || 'session';
  return path.join(launchSessionBaseDir(providerId), safe);
}

/**
 * Retention window for per-launch dirs. A launch's transcripts are the only
 * thing inside, and global search surfaces them by mtime, so a dir with no
 * activity for 30 days is dead weight: unbounded growth on disk plus ~2 sync
 * syscalls per dir on EVERY global session search (docs/performance.md).
 */
export const LAUNCH_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Upper bound on dirs examined per prune pass. scout-2: a candidate costs
 * ~5-6 sync syscalls (lstat + sidecar read + transcript readdir + per-jsonl
 * lstat), so the cap is sized for a bounded sweep, not the whole tree —
 * expired dirs beyond it converge over consecutive launches (documented
 * below). */
const PRUNE_SCAN_LIMIT = 200;

let pruneScanLimit = PRUNE_SCAN_LIMIT;

/** @internal Test-only: lower the per-pass scan bound; null restores the default. */
export function _setPruneScanLimitForTesting(limit: number | null): void {
  pruneScanLimit = limit ?? PRUNE_SCAN_LIMIT;
}

/** Bases already swept this process — pruning runs at most once per base. */
const prunedBases = new Set<string>();

/**
 * P1-16: per-launch dirs the sweep must never delete. Every Pi/OMP launch
 * registers its target dir here via ensureLaunchSessionDir BEFORE the sweep
 * it schedules can run; for a resume the target is the session's
 * pre-existing dir, whose transcript is the only copy. Protection lives for
 * the process — the sweep runs at most once per base per process, so one
 * registration per launch is enough.
 */
const protectedLaunchDirs = new Set<string>();

/** Sweep-identity key: absolute, case-folded on Windows (case-insensitive FS). */
function launchDirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return isWin ? resolved.toLowerCase() : resolved;
}

/** Exclude a per-launch dir from the retention sweep for this process. */
export function protectLaunchSessionDir(dir: string): void {
  protectedLaunchDirs.add(launchDirKey(dir));
}

/** Create the per-launch dir (and its base) so the CLI never races us. */
export function ensureLaunchSessionDir(sessionDir: string): void {
  // Called on every Pi/OMP start/resume, strictly before the CLI is spawned,
  // so the first call is the earliest hook that is guaranteed to run in a
  // process that launches these CLIs.
  // P1-16: protect the target BEFORE the sweep is scheduled. On a resume
  // this dir is pre-existing and past the retention window; the sweep this
  // call defers to the next macrotask used to delete it — and with it the
  // resumed session's only transcript copy.
  protectLaunchSessionDir(sessionDir);
  pruneLaunchSessionDirsOnce(path.dirname(sessionDir));
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch {
    // The CLI creates the dir on its first write; the watcher tolerates a
    // missing dir (empty listing) until it appears.
  }
}

function pruneLaunchSessionDirsOnce(base: string): void {
  if (prunedBases.has(base)) return;
  prunedBases.add(base);
  // scout-2 P2: the prune used to run SYNCHRONOUSLY on the spawn path — at
  // the scan bound that is thousands of sync syscalls between the user
  // pressing Enter and the CLI spawning. Retention is best-effort and the
  // spawn path is not; defer to the next macrotask, off the spawn, and
  // keep the sweep bounded (PRUNE_SCAN_LIMIT).
  setImmediate(() => {
    try {
      pruneLaunchSessionDirs(base);
    } catch {
      // Retention is best-effort; a failed sweep costs disk, never a launch.
    }
  });
}

/**
 * Delete per-launch dirs under `base` with no activity inside the retention
 * window. Returns the number removed.
 *
 * A dir is expired only when EVERY timestamp it exposes is older than the
 * window: the sidecar's `createdAt`, the newest `*.jsonl` mtime, and the dir's
 * own mtime (the last-activity proxy for dirs written before the sidecar
 * existed, and for dirs whose CLI never produced a transcript). Unknown ages
 * are never treated as expired.
 *
 * Safety: entries are lstat'ed, never stat'ed, so a symlinked dir is skipped
 * rather than followed, and every removal path is built by joining `base` with
 * one readdir name, i.e. it is strictly under `base`.
 *
 * Scan bound: at most `pruneScanLimit` dirs are examined per pass. On an
 * over-limit base the scan is ordered by dir mtime ascending (P2-57), so the
 * dirs it CAN examine are the oldest ones — the deletion candidates. By the
 * AND rule above a dir with an in-window mtime is undeletable, so the
 * unexamined mtime tail can only be young dirs; expired dirs that overflow
 * the bound are collected by the next launch's pass. Cost: one extra lstat
 * per dir (one syscall, no recursion), incurred only on over-limit bases.
 */
export function pruneLaunchSessionDirs(base: string, now = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return 0;
  }
  const cutoff = now - LAUNCH_SESSION_RETENTION_MS;
  let removed = 0;
  const scan = names.length > pruneScanLimit ? oldestDirsFirst(base, names) : names;
  for (const name of scan.slice(0, pruneScanLimit)) {
    const dir = path.join(base, name);
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    // P1-16: the dir of a live (or just-resumed) launch is never expired —
    // its launch, not its mtimes, owns it.
    if (protectedLaunchDirs.has(launchDirKey(dir))) continue;
    const created = Date.parse(readLaunchSessionMeta(dir)?.createdAt ?? '');
    const newest = newestTranscriptMtime(dir);
    // 0 = "no transcripts" sentinel from newestTranscriptMtime(); a real mtime
    // is always > 0, so it must not read as a (very old) age.
    const ages = [created, newest, dirStat.mtimeMs].filter(a => Number.isFinite(a) && a > 0);
    if (!ages.length || ages.some(a => a > cutoff)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Locked by the CLI on Windows, or vanished — retry next launch.
    }
  }
  return removed;
}

/**
 * readdir names whose dirs exist, ordered by mtime ascending (oldest first);
 * non-dirs and entries that vanish between readdir and lstat go last, so
 * they never displace an examination slot — the loop's lstat rules skip them
 * unchanged. One lstat per name — see the scan-bound note above.
 */
function oldestDirsFirst(base: string, names: string[]): string[] {
  const dated: Array<[name: string, mtimeMs: number]> = [];
  const rest: string[] = [];
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(base, name));
      if (st.isDirectory()) dated.push([name, st.mtimeMs]);
      else rest.push(name);
    } catch {
      rest.push(name);
    }
  }
  dated.sort((a, b) => a[1] - b[1]);
  return dated.map(([name]) => name).concat(rest);
}

/** Newest `*.jsonl` mtime in a dir; 0 when there are none. Symlinks ignored. */
function newestTranscriptMtime(dir: string): number {
  let newest = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const st = fs.lstatSync(path.join(dir, name));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return newest;
}

/** Async twin of newestTranscriptMtime() for the per-search listing (PA-19). */
async function newestTranscriptMtimeAsync(dir: string): Promise<number> {
  let newest = 0;
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const st = await fs.promises.lstat(path.join(dir, name));
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return newest;
}

export interface LaunchSessionMeta {
  providerId: LaunchSessionProvider;
  /** Project cwd the launch ran in. */
  cwd: string;
  /** Pinned profile config dir; undefined = the provider's default agent dir. */
  configDir?: string;
  createdAt: string;
}

const META_FILENAME = '.finevibe.json';

/** Record the launch's identity next to its transcripts (best-effort). */
export function writeLaunchSessionMeta(sessionDir: string, meta: LaunchSessionMeta): void {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, META_FILENAME), JSON.stringify(meta));
  } catch {
    // Without the sidecar, global search shows these transcripts under the
    // default profile — degraded, not broken.
  }
}

/** Read a per-launch dir's sidecar; null when absent or malformed. */
export function readLaunchSessionMeta(sessionDir: string): LaunchSessionMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, META_FILENAME), 'utf-8'));
    return normalizeMeta(raw);
  } catch {
    return null;
  }
}

function normalizeMeta(raw: unknown): LaunchSessionMeta | null {
  if (typeof (raw as LaunchSessionMeta)?.cwd !== 'string' || !(raw as LaunchSessionMeta).cwd) return null;
  const r = raw as Record<string, unknown>;
  return {
    providerId: r.providerId === 'omp' ? 'omp' : 'pi',
    cwd: r.cwd as string,
    configDir: typeof r.configDir === 'string' && r.configDir ? r.configDir : undefined,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
  };
}

// PA-19: the sidecar is written once at launch, but pi/OMP discovery used to
// readFileSync it per retained dir per search. Memoize per dir keyed by the
// dir's mtime: the listing already lstats every dir for the retention window,
// so a re-read costs one tuple compare. Any write into the dir (sidecar,
// transcript) bumps its mtime and conservatively invalidates the entry.
const metaCache = new Map<string, { dirMtimeMs: number; meta: LaunchSessionMeta | null }>();
const META_CACHE_MAX = 4000;

/**
 * Async, memoized sidecar read for global search. `dirMtimeMs` — the lstat
 * mtime the caller already paid for — is the cache key; stat is the fallback.
 */
export async function readLaunchSessionMetaCached(sessionDir: string, dirMtimeMs?: number): Promise<LaunchSessionMeta | null> {
  let mtimeMs = dirMtimeMs;
  if (mtimeMs === undefined) {
    try {
      mtimeMs = (await fs.promises.stat(sessionDir)).mtimeMs;
    } catch {
      return null;
    }
  }
  const hit = metaCache.get(sessionDir);
  if (hit && hit.dirMtimeMs === mtimeMs) {
    // S1-09: re-insert on hit — the eviction below drops the oldest
    // INSERTION, so without this the hottest dirs (recent launches,
    // scanned by every search) are evicted first at saturation.
    metaCache.delete(sessionDir);
    metaCache.set(sessionDir, hit);
    return hit.meta;
  }
  let meta: LaunchSessionMeta | null = null;
  try {
    meta = normalizeMeta(JSON.parse(await fs.promises.readFile(path.join(sessionDir, META_FILENAME), 'utf-8')));
  } catch {
    meta = null;
  }
  if (metaCache.size >= META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(sessionDir, { dirMtimeMs: mtimeMs, meta });
  return meta;
}

/**
 * Per-launch session dirs under `base` that are inside the retention window,
 * with the lstat mtime the retention gate already paid for (the meta cache
 * key, PA-19).
 *
 * Runs on every global session search, so dirs with no recent activity are
 * filtered here by the same rule pruneLaunchSessionDirs() deletes on: their
 * transcripts are all older than the window, so search could only surface
 * entries retention is about to remove — while paying a stat per dir for
 * thousands of them. All fs calls are async (PA-19): the old readdirSync +
 * lstatSync sweep blocked main for hundreds of ms per query.
 */
export async function listLaunchSessionDirs(base: string, maxAgeMs = LAUNCH_SESSION_RETENTION_MS): Promise<Array<{ dir: string; mtimeMs: number }>> {
  let names: string[];
  try {
    names = await fs.promises.readdir(base);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const out: Array<{ dir: string; mtimeMs: number }> = [];
  // S1-06: PA-19 made the syscalls async but kept the loop serial — at
  // AV-inflated stat costs a few hundred retained dirs serialized into
  // seconds of discovery latency per debounced search. Batch them (4
  // concurrent, the search permit-pool bound); lstat stays per-dir.
  const BATCH = 4;
  for (let i = 0; i < names.length; i += BATCH) {
    const settled = await Promise.all(names.slice(i, i + BATCH).map(async (name): Promise<{ dir: string; mtimeMs: number } | null> => {
      const dir = path.join(base, name);
      try {
        // lstat, not stat: a symlink in the search path is never followed.
        const st = await fs.promises.lstat(dir);
        if (!st.isDirectory()) return null;
        if (st.mtimeMs > cutoff) return { dir, mtimeMs: st.mtimeMs };
        return (await newestTranscriptMtimeAsync(dir)) > cutoff ? { dir, mtimeMs: st.mtimeMs } : null;
      } catch {
        // Vanished between readdir and stat — skip.
        return null;
      }
    }));
    for (const r of settled) if (r) out.push(r);
  }
  return out;
}

/**
 * The profile id a config dir belongs to (for search descriptors), so a
 * transcript found in a per-launch dir resumes against the right login.
 * undefined = the default agent dir (or an unknown dir — never a guess).
 */
export function profileIdForConfigDir(providerId: LaunchSessionProvider, configDir: string | undefined): string | undefined {
  if (!configDir) return undefined;
  const resolved = path.resolve(configDir);
  try {
    for (const profile of loadState().profiles ?? []) {
      if (profile.providerId === providerId && path.resolve(profile.configDir) === resolved) {
        return profile.id;
      }
    }
  } catch {
    // Profiles unavailable — default profile.
  }
  return undefined;
}
