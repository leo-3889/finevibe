import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
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
 * (`.vibeyard.json`) records the launch's profile/cwd so global session
 * search can surface these transcripts with the right profile.
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
 */
export function launchSessionDir(providerId: LaunchSessionProvider, uiSessionId: string): string {
  const safe = UI_SESSION_ID_RE.test(uiSessionId)
    ? uiSessionId
    : (uiSessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'session');
  return path.join(launchSessionBaseDir(providerId), safe);
}

/**
 * Retention window for per-launch dirs. A launch's transcripts are the only
 * thing inside, and global search surfaces them by mtime, so a dir with no
 * activity for 30 days is dead weight: unbounded growth on disk plus ~2 sync
 * syscalls per dir on EVERY global session search (docs/performance.md).
 */
export const LAUNCH_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Upper bound on dirs examined per prune pass, so startup never stalls on a huge tree. */
const PRUNE_SCAN_LIMIT = 2_000;

/** Bases already swept this process — pruning runs at most once per base. */
const prunedBases = new Set<string>();

/** Create the per-launch dir (and its base) so the CLI never races us. */
export function ensureLaunchSessionDir(sessionDir: string): void {
  // Called on every Pi/OMP start/resume, strictly before the CLI is spawned,
  // so the first call is the earliest hook that is guaranteed to run in a
  // process that launches these CLIs.
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
  try {
    pruneLaunchSessionDirs(base);
  } catch {
    // Retention is best-effort; a failed sweep costs disk, never a launch.
  }
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
  for (const name of names.slice(0, PRUNE_SCAN_LIMIT)) {
    const dir = path.join(base, name);
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
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

export interface LaunchSessionMeta {
  providerId: LaunchSessionProvider;
  /** Project cwd the launch ran in. */
  cwd: string;
  /** Pinned profile config dir; undefined = the provider's default agent dir. */
  configDir?: string;
  createdAt: string;
}

const META_FILENAME = '.vibeyard.json';

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
    if (typeof raw?.cwd !== 'string' || !raw.cwd) return null;
    return {
      providerId: raw.providerId === 'omp' ? 'omp' : 'pi',
      cwd: raw.cwd,
      configDir: typeof raw.configDir === 'string' && raw.configDir ? raw.configDir : undefined,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Per-launch session dirs under `base` that are inside the retention window.
 *
 * Runs on every global session search, so dirs with no recent activity are
 * filtered here by the same rule pruneLaunchSessionDirs() deletes on: their
 * transcripts are all older than the window, so search could only surface
 * entries retention is about to remove — while paying a stat per dir for
 * thousands of them.
 */
export function listLaunchSessionDirs(base: string, maxAgeMs = LAUNCH_SESSION_RETENTION_MS): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const out: string[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    try {
      // lstat, not stat: a symlink in the search path is never followed.
      const st = fs.lstatSync(dir);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs > cutoff) out.push(dir);
      else if (newestTranscriptMtime(dir) > cutoff) out.push(dir);
    } catch {
      // Vanished between readdir and stat — skip.
    }
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
