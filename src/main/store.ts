import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedState } from '../shared/types';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState } from '../shared/types';

const STATE_DIR = path.join(os.homedir(), '.vibeyard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let saveTimer: ReturnType<typeof setTimeout> | null = null;

// loadState() re-read and re-parsed state.json on every call; state changes
// flow through saveState/saveStateSync, so the parsed result is cached there
// and reused here (fs:* guards and the synchronous startup-prefs channel run
// loadState on hot paths). Tests manipulate fs mocks directly and must call
// invalidateStateCache() between cases.
let stateCache: PersistedState | null = null;

export function invalidateStateCache(): void {
  stateCache = null;
}

function defaultState(): PersistedState {
  return {
    version: 1,
    projects: [],
    activeProjectId: null,
    preferences: { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en', agentmemoryAutoStart: true },
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
export function loadState(): PersistedState {
  if (stateCache) return stateCache;
  const valid: { main?: PersistedState; tmp?: PersistedState } = {};
  for (const file of [STATE_FILE, STATE_FILE + '.tmp']) {
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
    const tmpNewer = valid.main ? stateFileIsNewer(STATE_FILE + '.tmp', STATE_FILE) : true;
    if (tmpNewer) {
      picked = valid.tmp;
      console.warn('Recovered state from temp file');
    }
    try {
      fs.unlinkSync(STATE_FILE + '.tmp');
    } catch {
      // Vanished (or the file system refuses) — the next save truncates it.
    }
  }
  if (picked) {
    stateCache = picked;
    return picked;
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
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  lastState = state;
  stateCache = state;
  knownProjectPaths = state.projects.map(p => p.path);
  saveTimer = setTimeout(() => {
    writeStateAtomically(state);
    saveTimer = null;
  }, 300);
}

let lastState: PersistedState | null = null;

// Project paths, cached for the hot fs:* path guards. loadState() re-reads and
// re-parses state.json on every call, which made each fs IPC pay for a full
// disk read + JSON.parse. State changes flow through saveState/saveStateSync,
// so updating the cache there keeps it fresh without touching loadState.
let knownProjectPaths: string[] | null = null;

export function getKnownProjectPaths(): string[] {
  if (knownProjectPaths === null) {
    knownProjectPaths = loadState().projects.map(p => p.path);
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
  stateCache = state;
  knownProjectPaths = state.projects.map(p => p.path);
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
    const tmpFile = STATE_FILE + '.tmp';
    // fsync before rename: a crash between rename and data flush used to
    // leave a truncated state.json whose .tmp recovery copy was already
    // consumed by the rename — whole-state loss to defaults.
    const payload = Buffer.from(JSON.stringify(state, null, 2), 'utf-8');
    const fd = fs.openSync(tmpFile, 'w');
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
