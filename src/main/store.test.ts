import { vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  writeSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

import * as fs from 'fs';
import { loadState, saveState, flushState, saveStateSync, invalidateStateCache, DEFAULT_PREFERENCES } from './store';
import type { PersistedState } from './store';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockOpenSync = vi.mocked(fs.openSync);
const mockWriteSync = vi.mocked(fs.writeSync);
const mockFsyncSync = vi.mocked(fs.fsyncSync);
const mockCloseSync = vi.mocked(fs.closeSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockRenameSync = vi.mocked(fs.renameSync);

const DEFAULT_STATE: PersistedState = {
  version: 1,
  projects: [],
  activeProjectId: null,
  preferences: { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en', agentmemoryAutoStart: true },
};

// Monotonic fake epoch: vi.useFakeTimers() re-bases Date.now to the (barely
// advanced) real clock, so a fixed advance from real time is not enough —
// each case must start 10 s past the PREVIOUS case's fake clock.
let fakeClockBase = Date.now();
beforeEach(() => {
  vi.clearAllMocks();
  // fs.writeSync reports the byte count and production code loops on it, so the
  // mock has to behave like a real descriptor, not return undefined.
  mockWriteSync.mockImplementation(((
    _fd: number,
    buffer: Buffer,
    position = 0,
  ) => buffer.length - position) as unknown as typeof fs.writeSync);
  vi.useFakeTimers();
  // Each case starts 10 s past the previous case's fake clock, so the
  // first saveState of every case takes the leading edge regardless of
  // when the previous case last touched lastSaveAt.
  fakeClockBase += 10_000;
  vi.setSystemTime(fakeClockBase);
  invalidateStateCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadState', () => {
  it('returns default state when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadState()).toEqual(DEFAULT_STATE);
  });

  it('parses valid JSON', () => {
    const state: PersistedState = {
      version: 1,
      projects: [{ id: 'p1', name: 'Test', path: '/test', sessions: [], activeSessionId: null, layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' } }],
      activeProjectId: 'p1',
      preferences: { ...DEFAULT_PREFERENCES, soundOnSessionWaiting: true },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(state));
    expect(loadState()).toEqual(state);
  });

  it('returns default state on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');
    expect(loadState()).toEqual(DEFAULT_STATE);
  });

  it('returns default state on wrong version', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 99 }));
    expect(loadState()).toEqual(DEFAULT_STATE);
  });

  it('fills the documented default preferences once for a file without them (P2-84)', () => {
    // A `version: 1` file predates the field; every main-side consumer
    // reads `state.preferences.X` unguarded (LoadedState guarantees it), so
    // the loader must normalize — a missing object is a TypeError per read.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1, projects: [], activeProjectId: null }));
    const loaded = loadState();
    expect(loaded.preferences).toEqual(DEFAULT_PREFERENCES);
    // Cached reads carry the same normalized object (single fill, not per call).
    expect(loadState()).toBe(loaded);
  });

  it('normalizes the cache on saveStateSync for a writer without preferences (P2-84)', () => {
    // The renderer's persisted payload is PersistedState (preferences optional);
    // after a sync save, loadState reads from the cache, so the write path must
    // normalize too — otherwise the guarantee exists only on the read path.
    const raw = { version: 1, projects: [], activeProjectId: 'p1' } as unknown as PersistedState;
    saveStateSync(raw);
    expect(loadState().preferences).toEqual(DEFAULT_PREFERENCES);
    expect(loadState().activeProjectId).toBe('p1');
  });
});

describe('saveState', () => {
  it('writes the leading edge immediately, not 300ms later', () => {
    saveState(DEFAULT_STATE);
    // P1-2: with the old trailing debounce nothing reached disk until the
    // timer fired, so a crash inside the window lost the state. The
    // leading edge writes through at once.
    expect(mockWriteSync).toHaveBeenCalledOnce();
    expect(String(mockRenameSync.mock.calls[0][0]).replaceAll('\\', '/')).toContain('/mock/home/.vibeyard/state.json.tmp');
    expect(String(mockRenameSync.mock.calls[0][1]).replaceAll('\\', '/')).toContain('/mock/home/.vibeyard/state.json');

    // The first write opens the throttle window; bursts inside it coalesce
    // into ONE trailing write of the LATEST state.
    saveState({ ...DEFAULT_STATE, activeProjectId: 'p2' });
    saveState({ ...DEFAULT_STATE, activeProjectId: 'p3' });
    expect(mockWriteSync).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(300);
    expect(mockWriteSync).toHaveBeenCalledTimes(2);
    const written = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(written.activeProjectId).toBe('p3');
    expect(mockRenameSync).toHaveBeenCalledTimes(2);
  });

  it('takes the leading edge again once the throttle window has passed', () => {
    saveState(DEFAULT_STATE); // leading
    vi.advanceTimersByTime(200);

    const updated = { ...DEFAULT_STATE, activeProjectId: 'p1' };
    saveState(updated); // inside the window: trailing armed
    vi.advanceTimersByTime(300);

    expect(mockWriteSync).toHaveBeenCalledTimes(2);
    const written = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(written.activeProjectId).toBe('p1');

    vi.advanceTimersByTime(1_000);
    const later = { ...DEFAULT_STATE, activeProjectId: 'p2' };
    saveState(later); // window passed: leading again
    expect(mockWriteSync).toHaveBeenCalledTimes(3);
    const written2 = JSON.parse(String(mockWriteSync.mock.calls[2][1]));
    expect(written2.activeProjectId).toBe('p2');
  });

  it('creates directory if needed', () => {
    mockExistsSync.mockReturnValue(false);
    saveState(DEFAULT_STATE);
    vi.advanceTimersByTime(300);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.vibeyard'),
      { recursive: true },
    );
  });
});

describe('saveStateSync', () => {
  it('writes immediately without debounce', () => {
    saveStateSync(DEFAULT_STATE);
    expect(mockWriteSync).toHaveBeenCalledOnce();
  });

  it('keeps writing after a short write instead of renaming a partial file', () => {
    const longId = 'x'.repeat(200);
    mockWriteSync.mockImplementation(((
      _fd: number,
      buffer: Buffer,
      position = 0,
    ) => Math.min(64, buffer.length - position)) as unknown as typeof fs.writeSync);

    const state = { ...DEFAULT_STATE, activeProjectId: longId };
    saveStateSync(state);

    expect(mockWriteSync.mock.calls.length).toBeGreaterThan(3);
    // Every call passes the whole payload with a rising offset and reports how
    // many bytes it moved, so the pieces must tile the payload exactly.
    const written = Buffer.concat(mockWriteSync.mock.calls.map(([ , buffer, position], i) => {
      const start = (position as number) ?? 0;
      return (buffer as unknown as Buffer).subarray(start, start + (mockWriteSync.mock.results[i].value as number));
    }));
    expect(written.toString('utf-8')).toBe(JSON.stringify(state, null, 2));
    expect(mockFsyncSync).toHaveBeenCalledOnce();
    expect(mockRenameSync).toHaveBeenCalledOnce();
  });

  it('refuses to fsync and rename when the descriptor stops making progress', () => {
    mockWriteSync.mockReturnValue(0);

    saveStateSync(DEFAULT_STATE);

    expect(mockFsyncSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalledOnce();
  });

  it('fsyncs and closes the temp file before renaming it into place', () => {
    saveStateSync(DEFAULT_STATE);

    expect(String(mockOpenSync.mock.calls[0][0]).replaceAll('\\', '/')).toContain('/mock/home/.vibeyard/state.json.tmp');
    expect(mockFsyncSync).toHaveBeenCalledOnce();
    expect(mockCloseSync).toHaveBeenCalledOnce();
    // Neither may overtake the data flush: a rename that wins leaves a
    // truncated state.json with the .tmp recovery copy already consumed.
    expect(mockFsyncSync.mock.invocationCallOrder[0]).toBeLessThan(mockRenameSync.mock.invocationCallOrder[0]);
    expect(mockCloseSync.mock.invocationCallOrder[0]).toBeLessThan(mockRenameSync.mock.invocationCallOrder[0]);
  });

  it('closes the descriptor and skips the rename when the write fails', () => {
    mockWriteSync.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    saveStateSync(DEFAULT_STATE);

    expect(mockCloseSync).toHaveBeenCalledOnce();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });
});

describe('flushState', () => {
  it('writes pending state immediately and disarms the trailing timer', () => {
    saveState(DEFAULT_STATE); // leading write
    saveState({ ...DEFAULT_STATE, activeProjectId: 'pending' }); // trailing armed
    flushState();
    const written = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(written.activeProjectId).toBe('pending');
    vi.advanceTimersByTime(1_000);
    expect(mockWriteSync).toHaveBeenCalledTimes(2); // flush disarmed the timer
  });
});

