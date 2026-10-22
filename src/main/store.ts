import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedState, Preferences, ProjectRecord } from '../shared/types';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState } from '../shared/types';

const STATE_DIR = path.join(os.homedir(), '.finevibe');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Leading-edge throttle window; see saveState. */
const SAVE_THROTTLE_MS = 300;
let lastSaveAt = 0;

// loadState() re-read and re-parsed state.json on every call; state changes
// flow through saveState/saveStateSync, so the parsed result is cached there
// and reused here (fs:* guards and the synchronous startup-prefs channel run
// loadState on hot paths). Tests manipulate fs mocks directly and must call
// invalidateStateCache() between cases.
let stateCache: LoadedState | null = null;

// PA-08: the gate-root memo (per-path canonical cache, whole-list memo and
// the realpath'd CLI config root list — see deriveGateRoots) is fs-derived
// state, so it is dropped here alongside stateCache: the fs mock semantics
// change between cases.
export function invalidateStateCache(): void {
  stateCache = null;
  gateRootCanonicalByPath.clear();
  gateRootMemo = null;
  gateRootRawPaths = null;
  cliConfigRootsCanonical = null;
}

/** The single documented default for a state file that omits `preferences`
 * (P2-84): a `version: 1` file without the field parses verbatim, and
 * `loadState` fills this in exactly once so every consumer reads a present
 * object. Keep in sync with the renderer's `defaultPreferences`. */
export const DEFAULT_PREFERENCES: Preferences = { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en', agentmemoryAutoStart: true, defaultProjectsFolder: '' };

/** State returned by {@link loadState}: `preferences` is guaranteed present
 * by the loader's single normalization step, so main-side consumers never
 * need to guard it. */
export type LoadedState = PersistedState & { preferences: Preferences };

function defaultState(): LoadedState {
  return {
    version: 1,
    projects: [],
    activeProjectId: null,
    preferences: { ...DEFAULT_PREFERENCES },
  };
}

// Startup recovery reads state.json and its .tmp sibling. writeStateAtomically
// fsyncs the temp file *before* the rename, so a crash with the data durable
// and the rename not yet durable leaves state.json at the PREVIOUS save and
// .tmp at the newest one. Reading state.json there silently loses the newest
// snapshot, and the first save opens .tmp with 'w' and destroys it. So when
// both parse, the newer mtime wins; the consumed .tmp is always unlinked,
// because a stale copy left behind is what a later corrupt state.json would
// resurrect.
export function loadState(): LoadedState {
  if (stateCache) return stateCache;
  const valid: { main?: PersistedState; tmp?: PersistedState } = {};
  for (const file of [STATE_FILE, `${STATE_FILE}.tmp`]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1) continue;
      if (file === STATE_FILE) valid.main = parsed;
      else valid.tmp = parsed;
    } catch {
      continue;
    }
  }
  let picked: PersistedState | undefined = valid.main;
  if (valid.tmp) {
    const tmpNewer = valid.main ? stateFileIsNewer(`${STATE_FILE}.tmp`, STATE_FILE) : true;
    if (tmpNewer) {
      picked = valid.tmp;
      console.warn('Recovered state from temp file');
    }
    try {
      fs.unlinkSync(`${STATE_FILE}.tmp`);
    } catch {
      // Vanished (or the file system refuses) — the next save truncates it.
    }
  }
  if (picked) {
    // P1-12: the same root validation guards the disk path — a peer-written
    // state.json must not persist a gate root across boots. Invalid projects
    // are dropped from the loaded state (logged), not silently trusted.
    const projects: ProjectRecord[] = [];
    for (const project of picked.projects ?? []) {
      const validated = validateGateRoot(project?.path);
      if ('drop' in validated) {
        console.warn(`Dropped persisted project ${JSON.stringify(project?.path)}: ${validated.drop}`);
        continue;
      }
      projects.push(project);
    }
    // Single documented default (P2-84): normalize once here, never at call
    // sites. Spread (not a cast) so the type system checks the result.
    const normalized: LoadedState = { ...picked, projects, preferences: picked.preferences ?? { ...DEFAULT_PREFERENCES } };
    stateCache = normalized;
    return normalized;
  }
  console.warn('No valid state file found, using defaults');
  stateCache = defaultState();
  return stateCache;
}

// mtime resolution is coarse (10 ms on NTFS), so a tie keeps state.json — the
// file the app has been writing to all along.
function stateFileIsNewer(candidate: string, reference: string): boolean {
  try {
    return fs.statSync(candidate).mtimeMs > fs.statSync(reference).mtimeMs;
  } catch {
    return false;
  }
}

export function saveState(state: PersistedState): void {
  // S1-02: main is the ONLY writer of the statusLine-consent preference
  // keys (boot modal -> recordDirConsent / guardedInstall). The renderer
  // serializes its WHOLE state - boot-time preferences included - on every
  // mutation (tab click, title, board move), so a renderer persist used to
  // erase a consent granted in the modal minutes later (declined users
  // re-prompted every launch). Graft main's authoritative consent keys onto
  // every incoming payload at the single disk writer. Main-side writers
  // pass the cache itself, so the graft is identity for them.
  if (state.preferences && stateCache?.preferences) {
    state.preferences.statusLineConsent = stateCache.preferences.statusLineConsent;
    state.preferences.statusLineConsentCommand = stateCache.preferences.statusLineConsentCommand;
    state.preferences.statusLineConsentByDir = stateCache.preferences.statusLineConsentByDir;
  }
  lastState = state;
  // P2-84: the cache is LoadedState; a writer's raw state normalizes to
  // the loader's single documented default on the way in.
  stateCache = { ...state, preferences: state.preferences ?? { ...DEFAULT_PREFERENCES } };
  knownProjectPaths = deriveGateRoots(state.projects);
  // Leading-edge throttle (same shape as the renderer's persist in
  // state.ts, ffcd283): the first save of a burst writes through
  // IMMEDIATELY, so a crash loses at most the mutations after the last
  // disk write. The old pure trailing debounce re-armed a 300ms timer on
  // every call — a steady stream of saves starved the write entirely and
  // kept the whole window exposed to a crash.
  const elapsed = Date.now() - lastSaveAt;
  if (elapsed >= SAVE_THROTTLE_MS && saveTimer === null) {
    lastSaveAt = Date.now();
    writeStateAtomically(state);
    return;
  }
  if (saveTimer !== null) return; // trailing write already armed
  saveTimer = setTimeout(() => {
    saveTimer = null;
    lastSaveAt = Date.now();
    // Coalesce: write the LATEST state, not the one that armed the timer.
    if (lastState) writeStateAtomically(lastState);
  }, SAVE_THROTTLE_MS - elapsed);
}

let lastState: PersistedState | null = null;

// Project paths, cached for the hot fs:* path guards. loadState() re-reads and
// re-parses state.json on every call, which made each fs IPC pay for a full
// disk read + JSON.parse. State changes flow through saveState/saveStateSync,
// so updating the cache there keeps it fresh without touching loadState.
// P1-12: the cache is the MAIN-VALIDATED canonical root set — renderer-
// supplied paths enter it only through deriveGateRoots.

// P1-12: the gate root set (isWithinKnownProject → fs:*, git:*, readiness,
// MCP config writes) is main-owned. `projects[].path` arrives from the
// renderer (`store:save`) and from a disk file any local peer can write, so
// neither is trusted verbatim: a gate root must be a real, existing,
// canonical directory that is not a filesystem root (`C:\`, `/`), not the
// user's home root, and not one of the CLI config trees the read allowlist
// covers. Validation lives here, on the main side of every writer: the
// persisted file is written verbatim (renderer persistence is not the gate),
// the root set is what gets validated.
// PA-08 memoization keeps every P1-12 invariant: a canonical value enters
// the per-path cache only after its FIRST full validation (realpath'd, then
// cleared by recheckCanonicalRoot), and the forbidden-tree / filesystem-root
// / home-root compares are pure string work, so they are re-checked on the
// memoized canonical at zero syscall cost — a cache hit can never launder a
// CLI config tree, a filesystem root, or the home root into the gate set.

// Mirrors the read allowlist in ipc-handlers `isAllowedReadPath` — the CLI
// config trees a "project" must never launder into the git-exec/destructive
// root set. `.claude.json`/`.mcp.json` are files, refused by the directory
// check; only the directory trees need listing here.
function cliConfigRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
    path.join(home, '.copilot'),
  ];
  if (process.platform === 'darwin') {
    roots.push('/Library/Application Support/ClaudeCode');
  } else if (process.platform === 'win32') {
    roots.push('C:\\Program Files\\ClaudeCode');
  } else {
    roots.push('/etc/claude-code');
  }
  return roots;
}

// PA-08: the realpath'd compare forms of the CLI config roots. The old code
// realpath'd every root once per project INSIDE the validateGateRoot loop
// (≈6N syscalls per save); the list is process-constant, so compute it once
// lazily — the canonicalHomeRoot() memo pattern. Dropped by
// invalidateStateCache() with the rest of the gate memo: the fs mock
// semantics (and on a real disk, directory existence) change between cases.
let cliConfigRootsCanonical: string[] | null = null;
function canonicalCliConfigRoots(): string[] {
  if (cliConfigRootsCanonical === null) {
    cliConfigRootsCanonical = cliConfigRoots().map((dir) => {
      let realDir = dir;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        // Config dir not on disk — the allowlist spelling is the compare form.
      }
      // Compare in resolved form so the mocked/test spellings and the
      // platform-native separators collapse to one shape on every OS.
      return path.resolve(realDir);
    });
  }
  return cliConfigRootsCanonical;
}

let homeRootCanonical: string | null | undefined;
function canonicalHomeRoot(): string {
  if (homeRootCanonical === undefined || homeRootCanonical === null) {
    try {
      homeRootCanonical = fs.realpathSync(os.homedir());
    } catch {
      homeRootCanonical = path.resolve(os.homedir());
    }
  }
  return homeRootCanonical;
}

/** P1-12: the syscall-free safety compares on an already realpath'd
 * canonical path — not a filesystem root, not the home root, not equal to
 * (or, by construction of the compare, inside) a CLI config tree. Pure
 * string work, so PA-08 re-checks it on every reuse of a memoized
 * canonical: a cache hit can never launder a forbidden tree into the set. */
function recheckCanonicalRoot(canonical: string): { canonical: string } | { drop: string } {
  // Compare in resolved form so the mocked/test spellings and the
  // platform-native separators collapse to one shape on every OS.
  const resolved = path.resolve(canonical);
  if (resolved === path.parse(resolved).root) return { drop: 'filesystem root' };
  if (resolved === path.resolve(canonicalHomeRoot())) return { drop: 'home root' };
  // PA-08: realpath'd once per process (canonicalCliConfigRoots) — the
  // forbidden-tree check is pure string compares now.
  for (const realDir of canonicalCliConfigRoots()) {
    if (resolved === realDir) return { drop: 'CLI config dir' };
  }
  return { canonical };
}

/** Canonicalize a renderer-supplied project path for the gate root set.
 * Returns `{ canonical }` when it is a real directory safe to gate on,
 * `{ drop }` with the refuse reason (logged by the caller) otherwise. */
function validateGateRoot(rawPath: unknown): { canonical: string } | { drop: string } {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return { drop: 'not a string path' };
  if (!path.isAbsolute(rawPath)) return { drop: 'not absolute' };
  let canonical: string;
  try {
    if (!fs.statSync(rawPath).isDirectory()) return { drop: 'not a directory' };
    canonical = fs.realpathSync(rawPath);
  } catch {
    return { drop: 'does not exist' };
  }
  return recheckCanonicalRoot(canonical);
}

// PA-08: every save re-derived the whole gate root set — per project one
// statSync + one realpathSync (plus the CLI roots realpath'd in the loop),
// ≈2N syscalls per 300 ms throttle window during every renderer mutation
// burst. Two memos, both dropped by invalidateStateCache():
// - gateRootCanonicalByPath: rawPath -> canonical for SUCCESSFUL
//   validations only. A list that grows by one project validates only the
//   new path (one stat + one realpath); cached paths cost zero syscalls and
//   are re-checked by recheckCanonicalRoot (pure string work, so the
//   memoized canonical can never launder a forbidden tree into the set).
//   Failures are NEVER cached: a refused path is a broken/dangerous project
//   path, so it re-validates on every save — that keeps the drop warning
//   firing on every save (existing tests pin it) and lets a directory that
//   reappears recover. The accepted trade-off: a cached directory deleted
//   behind our back stays in the set until the memo is invalidated.
// - gateRootMemo: the derived array keyed on the raw path list it came from;
//   an unchanged list returns the memo with ZERO fs calls.
const gateRootCanonicalByPath = new Map<string, string>();
let gateRootRawPaths: string[] | null = null;
let gateRootMemo: string[] | null = null;

// Memo key: the raw path list, strings only — a non-string path drops (with
// a warning) on every save, so a list containing one is never memoized.
function gateMemoKey(rawPaths: unknown[]): string[] | null {
  for (const rawPath of rawPaths) if (typeof rawPath !== 'string') return null;
  return rawPaths as string[];
}

// Chosen comparison: order-sensitive (same length, same entry at every
// index). A reorder counts as a change — conservative; reordering a project
// list is rare, and the re-derivation it costs is zero-syscall because
// every path hits the per-path cache.
function gatePathsEqual(a: string[] | null, b: string[]): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function deriveGateRoots(projects: ProjectRecord[]): string[] {
  const rawPaths: unknown[] = projects.map((project) => project?.path);
  const key = gateMemoKey(rawPaths);
  if (key !== null && gateRootMemo !== null && gatePathsEqual(gateRootRawPaths, key)) return gateRootMemo;
  const roots: string[] = [];
  let allValid = key !== null;
  for (const rawPath of rawPaths) {
    const cached = typeof rawPath === 'string' ? gateRootCanonicalByPath.get(rawPath) : undefined;
    // PA-08: a cache hit skips stat/realpath; the safety compares are
    // re-run on the memoized canonical at zero syscall cost.
    const validated = cached === undefined ? validateGateRoot(rawPath) : recheckCanonicalRoot(cached);
    if ('drop' in validated) {
      // Successes only are cached — the refused path re-validates (and
      // warns) on every save. A cached canonical that fails the re-check
      // is refused here but kept, so every later save behaves identically.
      allValid = false;
      console.warn(`Dropped project root from the gate set: ${JSON.stringify(rawPath)} (${validated.drop})`);
      continue;
    }
    if (cached === undefined && typeof rawPath === 'string') gateRootCanonicalByPath.set(rawPath, validated.canonical);
    if (!roots.includes(validated.canonical)) roots.push(validated.canonical);
  }
  // Whole-list memo for an all-valid list only: a list containing a refused
  // path keeps re-running the loop, so the drop warning fires every save.
  gateRootMemo = allValid ? roots : null;
  gateRootRawPaths = allValid ? key : null;
  return roots;
}
let knownProjectPaths: string[] | null = null;

export function getKnownProjectPaths(): string[] {
  if (knownProjectPaths === null) {
    knownProjectPaths = deriveGateRoots(loadState().projects);
  }
  return knownProjectPaths;
}

export function flushState(): void {
  // The quit path calls this from `before-quit`. The debounced timer must die
  // with the flush: left armed, it fires after teardown and writes state.json
  // a second time while the app-data directory is being torn down (Windows
  // logout / roaming profile), surfacing the write error as an unhandled
  // exception in the timer, and it keeps the loop alive for up to 300ms.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (lastState) {
    saveStateSync(lastState);
  }
}

export function saveStateSync(state: PersistedState): void {
  // S1-02: same consent-key graft as saveState — the renderer's
  // beforeunload flush is a whole-state write too.
  if (state.preferences && stateCache?.preferences) {
    state.preferences.statusLineConsent = stateCache.preferences.statusLineConsent;
    state.preferences.statusLineConsentCommand = stateCache.preferences.statusLineConsentCommand;
    state.preferences.statusLineConsentByDir = stateCache.preferences.statusLineConsentByDir;
  }
  stateCache = { ...state, preferences: state.preferences ?? { ...DEFAULT_PREFERENCES } };
  knownProjectPaths = deriveGateRoots(state.projects);
  // A synchronous write is a disk write: it opens the throttle window for
  // the leading-edge check in saveState.
  lastSaveAt = Date.now();
  writeStateAtomically(state);
}

// fs.writeSync reports how many bytes it wrote and a single call is allowed to
// stop short. Renaming a partially written temp file would replace a good
// state.json with a truncated one, so keep writing from the offset the last
// call stopped at; a descriptor that stops making progress aborts the write
// rather than reaching the rename. The payload is a Buffer so byte offsets and
// byte counts agree for non-ASCII project names.
function writeFully(fd: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    const written = fs.writeSync(fd, payload, offset);
    if (written <= 0) {
      throw new Error(`state write stalled at ${offset}/${payload.length} bytes`);
    }
    offset += written;
  }
}

function writeStateAtomically(state: PersistedState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const tmpFile = `${STATE_FILE}.tmp`;
    // fsync before rename: a crash between rename and data flush used to
    // leave a truncated state.json whose .tmp recovery copy was already
    // consumed by the rename — whole-state loss to defaults.
    const payload = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
    // P2-101: state.json can carry secrets (`project.defaultEnv`). The
    // default file mode is 0644 — world-readable on multi-user hosts, and
    // any backup/dotfile sync picks it up. Open the temp file 0600; the
    // rename below hands that mode to state.json itself. On Windows the
    // mode argument is a no-op (NTFS uses ACLs; every mode bit ≥0200 maps
    // to "not read-only"), so this only ever tightens, never breaks.
    const fd = fs.openSync(tmpFile, 'w', 0o600);
    // The open mode applies only on CREATE; a .tmp left by an older build
    // keeps its 0644, so force the mode on the descriptor. fchmodSync is
    // likewise a no-op for ACL purposes on Windows.
    fs.fchmodSync(fd, 0o600);
    try {
      writeFully(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}
