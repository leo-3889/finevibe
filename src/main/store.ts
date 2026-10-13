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
    preferences: { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en' },
  };
}

export function loadState(): PersistedState {
  if (stateCache) return stateCache;
  for (const file of [STATE_FILE, STATE_FILE + '.tmp']) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1) continue;
      if (file !== STATE_FILE) {
        console.warn('Recovered state from temp file');
      }
      stateCache = parsed;
      return parsed;
    } catch {
      continue;
    }
  }
  console.warn('No valid state file found, using defaults');
  stateCache = defaultState();
  return stateCache;
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
  if (lastState) {
    saveStateSync(lastState);
  }
}

export function saveStateSync(state: PersistedState): void {
  stateCache = state;
  knownProjectPaths = state.projects.map(p => p.path);
  writeStateAtomically(state);
}

function writeStateAtomically(state: PersistedState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}
