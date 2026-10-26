import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedState, Preferences, ProjectRecord, Profile, HostRecord } from '../shared/types';
import { LOCAL_HOST_ID } from '../shared/types';
import { validateHostRecordShape, migrateLegacySessionSshHosts } from '../shared/ssh-host';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState } from '../shared/types';

const STATE_DIR = path.join(os.homedir(), '.finevibe');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// SA-P2-8: last-known-good copy. Before it, a single corrupt state.json
// (a bad hand-edit, a truncated file) meant a whole-state reset: the .tmp
// sibling is a crash artifact that is consumed on recovery, so it is the
// only copy exactly when it is missing. `performStateWrite` mirrors every
// successful commit here, and `loadState` falls back to it.
const STATE_FILE_GOOD = `${STATE_FILE}.good`;

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
  remoteProjectRoots = null;
  // The write-backoff machine (see writeStateAtomically) is module state
  // too: a forced-failure case must not leave an outage armed that would
  // suppress the next case's leading-edge write.
  clearWriteRetryTimer();
  writeBackoffMs = 0;
  suppressedWriteFailures = 0;
}

// Test-only. Fully resets the leading-edge throttle and the write-backoff
// machine. The write-storm tests need a clean leading edge: a trailing
// saveTimer armed by a prior case lives on a fake clock afterEach tears down,
// so its handle survives as non-null `saveTimer` and makes the next saveState
// skip the leading edge (write + log never fire). Production never calls this
// — invalidateStateCache() deliberately leaves lastState/saveTimer intact so
// store:save coalescing and the flush contract are preserved.
export function resetWriteStateForTests(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  clearWriteRetryTimer();
  writeBackoffMs = 0;
  suppressedWriteFailures = 0;
  lastSaveAt = 0;
  lastState = null;
}

/** The single documented default for a state file that omits `preferences`
 * (P2-84): a `version: 1` file without the field parses verbatim, and
 * `loadState` fills this in exactly once so every consumer reads a present
 * object. Keep in sync with the renderer's `defaultPreferences`. */
export const DEFAULT_PREFERENCES: Preferences = { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en', defaultProjectsFolder: '' };

/** State returned by {@link loadState}: `preferences` is guaranteed present
 * by the loader's single normalization step, so main-side consumers never
 * need to guard it. */
export type LoadedState = PersistedState & { preferences: Preferences; hosts: HostRecord[] };

function defaultState(): LoadedState {
  return {
    version: 1,
    projects: [],
    activeProjectId: null,
    preferences: { ...DEFAULT_PREFERENCES },
    hosts: [],
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
// A state.json saved by Notepad/PowerShell on Windows carries a UTF-8 BOM;
// fs.readFileSync('utf-8') keeps it and JSON.parse rejects it, so an intact
// hand-edited file used to be graded corrupt: .tmp recovery if a sibling
// exists, else a silent reset to defaults. Strip the leading BOM before
// parsing. A BOM-only file (a Notepad save of an empty doc) becomes '' and
// fails the parse — the existing corrupt path, deliberately.
function parseStateJson(raw: string): PersistedState {
  // pi-lens-ignore: slop, unchecked-throwing-call
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) as PersistedState;
}

/** SA-P2-8: the migration seam. Today version 1 passes through and any
 * other version is REFUSED with a loud warn — the loader then falls back to
 * the recovery chain below (never silently: the reset is the warn). A future
 * version bump adds its step HERE (`if (parsed.version === 2) return
 * migrateV2(parsed)`), not in loadState's control flow. Refusing, not
 * booting on a shape this build cannot interpret, is the current contract. */
function migrateState(parsed: PersistedState): PersistedState | null {
  if (parsed.version === 1) return parsed;
  console.warn(
    `state.json version ${JSON.stringify((parsed as { version?: unknown }).version)} has no migration path in this build: refusing the file (see store.ts migrateState)`,
  );
  return null;
}

/** SA-P2-8: the last-known-good copy, version-checked and parse-guarded.
 * Returns undefined when there is nothing usable (no file, torn copy). */
function readGoodState(): PersistedState | undefined {
  try {
    if (!fs.existsSync(STATE_FILE_GOOD)) return undefined;
    const parsed = parseStateJson(fs.readFileSync(STATE_FILE_GOOD, 'utf-8'));
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function loadState(): LoadedState {
  if (stateCache) return stateCache;
  const valid: { main?: PersistedState; tmp?: PersistedState } = {};
  // Only a state.json that EXISTS and fails to PARSE opens the .good
  // fallback: a missing file is a fresh install, and a refused version is a
  // deliberate refusal, not damage to route around.
  let mainCorrupt = false;
  for (const file of [STATE_FILE, `${STATE_FILE}.tmp`]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = parseStateJson(raw);
      if (file === STATE_FILE) valid.main = migrateState(parsed) ?? undefined;
      // The .tmp sibling keeps the plain version-1 skip: it is a crash
      // artifact of THIS build's writer, never a migration subject.
      else if (parsed.version === 1) valid.tmp = parsed;
    } catch {
      if (file === STATE_FILE) mainCorrupt = true;
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
  // SA-P2-8: corrupt state.json, no .tmp winner → the last-known-good copy.
  // The warn names the source so a recovery is never mistaken for the
  // plain 'using defaults' reset (the audit's bar: recovery is visible).
  if (!picked && mainCorrupt) {
    picked = readGoodState();
    if (picked) console.warn('Recovered state from last-known-good copy (state.json is corrupt)');
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
    // Hosts normalize once here too (multi-host Phase 1): entries the shared
    // validator rejects are dropped with a log, never trusted.
    const hosts: HostRecord[] = [];
    for (const host of picked.hosts ?? []) {
      const validated = validateHostRecordShape(host);
      if (!validated) {
        console.warn(`Dropped persisted host ${JSON.stringify((host as { id?: string })?.id)}: failed validateHostRecordShape`);
        continue;
      }
      hosts.push(validated);
    }
    // Per-host providers plan §2: pre-existing records carry no hostId —
    // normalize once at load, exactly once (mirrored in the renderer's
    // hydrateLoadedState), never at call sites.
    // Legacy sshHost adoption runs FIRST (parent §11, one release carrying
    // both): a session tagged with a registry hostname adopts the host id;
    // unregistered/ambiguous targets keep sshHost for the legacy wrap.
    migrateLegacySessionSshHosts(projects, hosts);
    for (const project of projects) {
      if (!project.hostId) project.hostId = LOCAL_HOST_ID;
      project.sessions = project.sessions.map((s) => (s.hostId ? s : { ...s, hostId: LOCAL_HOST_ID }));
    }
    const profiles: Profile[] | undefined = picked.profiles?.map((p) => (p.hostId ? p : { ...p, hostId: LOCAL_HOST_ID }));
    // Single documented default (P2-84): normalize once here, never at call
    // sites. Spread (not a cast) so the type system checks the result.
    const normalized: LoadedState = {
      ...picked,
      projects,
      hosts,
      ...(profiles ? { profiles } : {}),
      preferences: picked.preferences ?? { ...DEFAULT_PREFERENCES },
    };
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

// SA-P2-7: single implementation of the S1-02 graft, shared by saveState and
// saveStateSync (previously byte-identical copies, with the sync branch — the
// beforeunload flush — untested). SA-P1-1: when the cache is empty (the B2
// root-change hook calls invalidateStateCache() immediately before a persist),
// load-then-graft: re-read disk so the renderer's stale payload cannot become
// the new cache and permanently erase a main-side consent. SA-P2-2: chromeImport
// joins the main-owned key set — chromeImport:run/clearCookies write it on the
// main side and a renderer whole-state save used to clobber the mid-session summary.
function graftMainOwnedPreferences(state: PersistedState): void {
  if (!state.preferences) return;
  if (!stateCache) {
    // SA-P1-1: only reload when there IS a persisted state. With no cache and
    // no file (fresh install) the payload itself is the first state — the old
    // empty-cache skip is kept for that case so a main-side first write is
    // never overwritten by the defaults loadState would return.
    if (!fs.existsSync(STATE_FILE) && !fs.existsSync(`${STATE_FILE}.tmp`)) return;
    loadState();
  }
  const authoritative = stateCache?.preferences;
  if (!authoritative) return;
  state.preferences.statusLineConsent = authoritative.statusLineConsent;
  state.preferences.statusLineConsentCommand = authoritative.statusLineConsentCommand;
  state.preferences.statusLineConsentByDir = authoritative.statusLineConsentByDir;
  if (authoritative.chromeImport) state.preferences.chromeImport = authoritative.chromeImport;
  else delete state.preferences.chromeImport;
}

export function saveState(state: PersistedState): void {
  // S1-02: main is the ONLY writer of the main-owned preference keys (see
  // graftMainOwnedPreferences). The renderer serializes its WHOLE state -
  // boot-time preferences included - on every mutation (tab click, title,
  // board move), so a renderer persist used to erase a consent granted in the
  // modal minutes later (declined users re-prompted every launch). Main-side
  // writers pass the cache itself, so the graft is identity for them.
  graftMainOwnedPreferences(state);
  lastState = state;
  // P2-84: the cache is LoadedState; a writer's raw state normalizes to
  // the loader's single documented default on the way in.
  stateCache = { ...state, hosts: state.hosts ?? [], preferences: state.preferences ?? { ...DEFAULT_PREFERENCES } };
  knownProjectPaths = deriveGateRoots(state.projects);
  // ENOSPC storm guard (workstation, 2026-10-23): the disk is failing, so
  // the single backoff timer (see writeStateAtomically) owns retries — no
  // per-event write syscalls, no per-event log. `lastState` is already the
  // newest state, so the recovery write flushes every mutation accepted
  // while backing off.
  if (writeBackoffMs > 0) return;
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
// B1: FIFO bound on the per-path memo (settings-guard.ts'
// MAX_CONSENT_DIR_RECORDS idiom): a session that keeps gating on fresh
// project paths must not grow it without limit. Oldest path evicted first;
// an eviction costs one stat + one realpath on the next save, never a
// policy miss — the memoized canonical is re-checked on every hit anyway.
export const GATE_ROOT_CANONICAL_MAX = 200;
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
    if (cached === undefined && typeof rawPath === 'string') {
      gateRootCanonicalByPath.set(rawPath, validated.canonical);
      while (gateRootCanonicalByPath.size > GATE_ROOT_CANONICAL_MAX) {
        const oldest = gateRootCanonicalByPath.keys().next().value;
        if (oldest === undefined) break;
        gateRootCanonicalByPath.delete(oldest);
      }
    }
    if (!roots.includes(validated.canonical)) roots.push(validated.canonical);
  }
  // Whole-list memo for an all-valid list only: a list containing a refused
  // path keeps re-running the loop, so the drop warning fires every save.
  gateRootMemo = allValid ? roots : null;
  gateRootRawPaths = allValid ? key : null;
  return roots;
}
let knownProjectPaths: string[] | null = null;

// Coherence Phase 3 (docs/hosts.md): remote project roots, for the main-side
// belt that refuses local git/fs sinks on paths that belong to a host.
function deriveRemoteProjectRoots(projects: PersistedState['projects']): Array<{ path: string; hostId: string }> {
  return projects
    .filter((p) => typeof p.hostId === 'string' && p.hostId && p.hostId !== 'local')
    .map((p) => ({ path: p.path, hostId: p.hostId as string }));
}
let remoteProjectRoots: Array<{ path: string; hostId: string }> | null = null;

export function getRemoteProjectRoots(): Array<{ path: string; hostId: string }> {
  if (remoteProjectRoots === null) {
    remoteProjectRoots = deriveRemoteProjectRoots(loadState().projects);
  }
  return remoteProjectRoots;
}

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
  // Same teardown for the backoff retry timer (see writeStateAtomically):
  // a quit has no future to retry in, and an armed timer would fire after
  // teardown exactly like the debounced one above.
  clearWriteRetryTimer();
  if (lastState) {
    saveStateSync(lastState);
  }
  // saveStateSync → onStateWriteFailed can arm one last retry; tear it
  // down with the flush, mirroring the saveTimer teardown above.
  clearWriteRetryTimer();
}

export function saveStateSync(state: PersistedState): void {
  // S1-02: same graft as saveState via the shared helper (SA-P2-7) — the
  // renderer's beforeunload flush is a whole-state write too.
  graftMainOwnedPreferences(state);
  stateCache = { ...state, hosts: state.hosts ?? [], preferences: state.preferences ?? { ...DEFAULT_PREFERENCES } };
  knownProjectPaths = deriveGateRoots(state.projects);
  remoteProjectRoots = deriveRemoteProjectRoots(state.projects);
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

// Windows holds open files against replacement: while an AV scan, an
// editor buffer or a backup indexer keeps a handle on state.json,
// renameSync(tmp, state.json) fails EPERM/EBUSY. The payload is fsynced
// into .tmp by this point, so a short bounded retry turns a silently lost
// newest snapshot into a brief stall. Synchronous by necessity:
// saveStateSync/flushState run on shutdown paths (Windows logout) that do
// not outlive an async retry, so an armed timer would be dropped
// mid-flight. Any other errno, or a failed budget, re-throws into the
// existing catch-and-log; the fsynced .tmp then survives for loadState's
// startup recovery.
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 50;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmpFile: string, target: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpFile, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= RENAME_MAX_ATTEMPTS) throw err;
      sleepSync(RENAME_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

// ENOSPC storm guard (workstation incident, 2026-10-23): a full disk made
// EVERY renderer `store:save` IPC a failed atomic write, and the old
// catch-and-log printed a full stack per attempt. The 300ms leading-edge
// throttle re-armed on every mutation, so one outage logged ~400 stacks a
// minute (journald + rsyslog mirrored them); the log growth consumed the
// very space the failure complained about — a self-amplifying loop. The
// first failure of an outage keeps the exact log line, repeats are counted
// and suppressed, and ONE exponential backoff timer (1s -> 60s cap) owns
// all retries. Steady state pays nothing: `writeBackoffMs === 0` is the
// only state, and success short-circuits before any logging.
const WRITE_BACKOFF_BASE_MS = 1000;
const WRITE_BACKOFF_CAP_MS = 60000;
/** Current retry delay; 0 = healthy (no outage in progress). */
let writeBackoffMs = 0;
let writeRetryTimer: ReturnType<typeof setTimeout> | null = null;
let suppressedWriteFailures = 0;

function clearWriteRetryTimer(): void {
  if (writeRetryTimer !== null) {
    clearTimeout(writeRetryTimer);
    writeRetryTimer = null;
  }
}

function onStateWriteSucceeded(): void {
  if (writeBackoffMs === 0) return; // steady path: zero syscalls, zero logs
  const n = suppressedWriteFailures;
  writeBackoffMs = 0;
  suppressedWriteFailures = 0;
  console.info(`State saved after ${n} failed attempt(s)`);
}

function onStateWriteFailed(err: unknown): void {
  if (writeBackoffMs === 0) {
    writeBackoffMs = WRITE_BACKOFF_BASE_MS;
    suppressedWriteFailures = 0;
    // First failure of the outage: the exact pre-backoff log line, once.
    console.error('Failed to save state:', err);
  } else {
    suppressedWriteFailures++;
  }
  scheduleWriteRetry();
}

function scheduleWriteRetry(): void {
  if (writeRetryTimer !== null) return; // a retry is already armed
  const delay = writeBackoffMs;
  writeBackoffMs = Math.min(writeBackoffMs * 2, WRITE_BACKOFF_CAP_MS);
  writeRetryTimer = setTimeout(() => {
    writeRetryTimer = null;
    // Coalesce like the trailing throttle: retry the LATEST state.
    if (lastState) writeStateAtomically(lastState);
  }, delay);
}

/** The atomic write, unguarded: every failure (mkdir/chmod, open,
 * writeFully, fsync, rename) throws to writeStateAtomically's handler. */
function performStateWrite(state: PersistedState): void {
  if (fs.existsSync(STATE_DIR)) {
    // C4S-12: state.json carries secrets, and its PARENT must be private
    // too. Older builds created the dir with the 0755 default and mkdir
    // never repairs an existing dir's mode — enforce 0700 on it as well.
    // Both are no-ops for ACL purposes on Windows (harmless), and the
    // stat guard keeps the hot persist path free of redundant chmods.
    try {
      if ((fs.statSync(STATE_DIR).mode & 0o777) !== 0o700) fs.chmodSync(STATE_DIR, 0o700);
    } catch { /* best-effort: never block persistence */ }
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
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
  renameWithRetry(tmpFile, STATE_FILE);
  // SA-P2-8: mirror the committed payload to the last-known-good copy. One
  // plain write of the buffer the rename just made durable — no second
  // fsync: a torn .good is a parse failure in readGoodState, which falls
  // through to the pre-SA-P2-8 behavior (defaults), never to a bad state.
  // The mode matches state.json (P2-101: the payload can carry secrets).
  // Best-effort: a .good failure must not report the successful commit as a
  // write failure and arm the ENOSPC backoff for a write that worked.
  try {
    fs.writeFileSync(STATE_FILE_GOOD, payload, { mode: 0o600 });
  } catch {
    // Best-effort: the next successful write recreates it.
  }
}

function writeStateAtomically(state: PersistedState): void {
  try {
    performStateWrite(state);
    onStateWriteSucceeded();
  } catch (err) {
    onStateWriteFailed(err);
  }
}
