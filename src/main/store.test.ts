import { vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  fchmodSync: vi.fn(),
  writeSync: vi.fn(),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn(),
  realpathSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

import * as fs from 'fs';
import { loadState, saveState, flushState, saveStateSync, invalidateStateCache, getKnownProjectPaths, DEFAULT_PREFERENCES, GATE_ROOT_CANONICAL_MAX, resetWriteStateForTests } from './store';
import type { PersistedState, ProjectRecord } from './store';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockOpenSync = vi.mocked(fs.openSync);
const mockWriteSync = vi.mocked(fs.writeSync);
const mockFsyncSync = vi.mocked(fs.fsyncSync);
const mockCloseSync = vi.mocked(fs.closeSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockRenameSync = vi.mocked(fs.renameSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockRealpathSync = vi.mocked(fs.realpathSync);

const DEFAULT_STATE: PersistedState = {
  version: 1,
  projects: [],
  activeProjectId: null,
  hosts: [],
  preferences: { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, locale: 'en', defaultProjectsFolder: '' },
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
  // P1-12 root-set validation stats + realpath-projects. Default mock
  // semantics: every path is a real directory and realpath is identity;
  // cases override when a dir must not exist.
  mockStatSync.mockImplementation(() => ({ isDirectory: () => true }) as unknown as fs.Stats);
  mockRealpathSync.mockImplementation((p) => String(p));
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
    // hosts normalizes to [] on load (multi-host Phase 1 contract).
    expect(loadState()).toEqual({ ...state, hosts: [] });
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

  it('parses a state file saved with a UTF-8 BOM (Notepad/PowerShell edit)', () => {
    // Notepad/PowerShell on Windows save state.json with a BOM;
    // JSON.parse rejects it, so an intact hand-edited file was graded
    // corrupt — .tmp recovery at best, a silent reset to defaults.
    const state: PersistedState = {
      version: 1,
      projects: [],
      activeProjectId: 'p1',
      preferences: { ...DEFAULT_PREFERENCES },
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(`\uFEFF${JSON.stringify(state)}`);
    expect(loadState()).toEqual({ ...state, hosts: [] });
  });

  it('treats a BOM-only state file as corrupt: defaults, no crash', () => {
    // A Notepad save of an empty doc is just the BOM. It normalizes to ''
    // and fails the parse — the existing corrupt path, deliberately.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('\uFEFF');
    expect(loadState()).toEqual(DEFAULT_STATE);
  });
});

describe('saveState', () => {
  it('writes the leading edge immediately, not 300ms later', () => {
    saveState(DEFAULT_STATE);
    // P1-2: with the old trailing debounce nothing reached disk until the
    // timer fired, so a crash inside the window lost the state. The
    // leading edge writes through at once.
    expect(mockWriteSync).toHaveBeenCalledOnce();
    expect(String(mockRenameSync.mock.calls[0][0]).replaceAll('\\', '/')).toContain('/mock/home/.finevibe/state.json.tmp');
    expect(String(mockRenameSync.mock.calls[0][1]).replaceAll('\\', '/')).toContain('/mock/home/.finevibe/state.json');

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
      expect.stringContaining('.finevibe'),
      { recursive: true, mode: 0o700 }, // C4S-12: state dir is private
    );
  });

  it('grafts main-owned statusLine-consent keys onto every write (S1-02)', () => {
    // Main records a consent decision (boot modal -> recordDirConsent).
    const withConsent = {
      ...DEFAULT_STATE,
      preferences: {
        ...DEFAULT_STATE.preferences!,
        statusLineConsent: 'declined' as const,
        statusLineConsentCommand: 'foreign-cmd',
        statusLineConsentByDir: { '/x': { consent: 'granted' as const, command: 'c' } },
      },
    };
    saveState(withConsent);
    vi.advanceTimersByTime(300);

    // The renderer's next whole-state persist carries its BOOT-TIME prefs
    // (consent keys absent). Before S1-02 this erased the consent on disk.
    saveState({ ...DEFAULT_STATE });
    vi.advanceTimersByTime(300);
    const written = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(written.preferences.statusLineConsent).toBe('declined');
    expect(written.preferences.statusLineConsentCommand).toBe('foreign-cmd');
    expect(written.preferences.statusLineConsentByDir).toEqual({ '/x': { consent: 'granted', command: 'c' } });
    // And a main-side read sees them too.
    expect(loadState().preferences.statusLineConsent).toBe('declined');
  });

  // SA-P1-1: the B2 root-change hook calls invalidateStateCache() immediately
  // before saveState — the old guard (`stateCache?.preferences`) was then false
  // and the renderer's stale payload became the cache verbatim, erasing a
  // consent granted in the boot modal permanently. load-then-graft: an empty
  // cache reloads from disk before the graft reads it.
  it('reloads disk state when the cache was invalidated before a persist (SA-P1-1)', () => {
    // Real-disk stand-in: readFileSync returns exactly what the last write wrote.
    let disk = JSON.stringify({
      ...DEFAULT_STATE,
      preferences: {
        ...DEFAULT_STATE.preferences!,
        statusLineConsent: 'granted' as const,
        statusLineConsentCommand: 'cmd-a',
      },
    });
    mockWriteSync.mockImplementation(((
      _fd: number,
      buffer: Buffer,
      position = 0,
    ) => {
      if (position === 0) disk = buffer.toString('utf-8');
      return buffer.length - position;
    }) as unknown as typeof fs.writeSync);
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockImplementation(() => disk);
    invalidateStateCache();

    // The renderer persists its whole state with a BOOT-TIME stale consent
    // ('declined' from before the modal granted 'granted').
    const staleRendererPayload: PersistedState = {
      ...DEFAULT_STATE,
      preferences: {
        ...DEFAULT_STATE.preferences!,
        statusLineConsent: 'declined' as const,
        statusLineConsentCommand: 'stale-cmd',
      },
    };
    saveState(staleRendererPayload);

    const written = JSON.parse(disk);
    expect(written.preferences.statusLineConsent).toBe('granted');
    expect(written.preferences.statusLineConsentCommand).toBe('cmd-a');
  });

  // SA-P2-2: chromeImport is main-owned (chromeImport:run/clearCookies write
  // it); a renderer whole-state save must not clobber it.
  it('grafts the main-owned chromeImport summary onto renderer writes (SA-P2-2)', () => {
    const summary = { lastImportedAt: 123, profileId: 'Default', cookieCount: 42, skippedV11: 0 };
    const withImport: PersistedState = {
      ...DEFAULT_STATE,
      preferences: { ...DEFAULT_STATE.preferences!, chromeImport: summary },
    };
    // Main wrote the summary (chromeImport:run) — disk/cache now carry it.
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockImplementation(() => JSON.stringify(withImport));
    loadState();

    // Renderer persist without the key (its boot snapshot predates the import).
    saveState({ ...DEFAULT_STATE });
    const written = JSON.parse(String(mockWriteSync.mock.calls[0][1]));
    expect(written.preferences.chromeImport).toEqual(summary);

    // A renderer payload carrying a STALE summary is also overridden by main's.
    vi.advanceTimersByTime(300);
    saveState({
      ...DEFAULT_STATE,
      preferences: { ...DEFAULT_STATE.preferences!, chromeImport: { ...summary, cookieCount: 1 } },
    });
    vi.advanceTimersByTime(300);
    const written2 = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(written2.preferences.chromeImport).toEqual(summary);
  });
});

describe('saveStateSync', () => {
  it('writes immediately without debounce', () => {
    saveStateSync(DEFAULT_STATE);
    expect(mockWriteSync).toHaveBeenCalledOnce();
  });

  // SA-P2-7: the sync branch (the beforeunload flush path) had the same graft
  // as saveState but no test pinning it — the duplicated copy could drift silently.
  it('grafts main-owned consent keys like saveState (SA-P2-7)', () => {
    // Own fs state: no state file on disk (vi.clearAllMocks() keeps prior
    // tests' mock implementations, so the SA-P2-2 mocks would otherwise
    // persist and the graft would load THAT test's disk content).
    mockExistsSync.mockReturnValue(false);
    const withConsent: PersistedState = {
      ...DEFAULT_STATE,
      preferences: {
        ...DEFAULT_STATE.preferences!,
        statusLineConsent: 'declined' as const,
        statusLineConsentCommand: 'foreign-cmd',
        statusLineConsentByDir: { '/x': { consent: 'granted' as const, command: 'c' } },
        chromeImport: { lastImportedAt: 5, profileId: 'Default', cookieCount: 7, skippedV11: 0 },
      },
    };
    saveStateSync(withConsent);
    const first = JSON.parse(String(mockWriteSync.mock.calls[0][1]));
    expect(first.preferences.statusLineConsent).toBe('declined');

    // A second sync write from a stale payload keeps main's consent + summary.
    saveStateSync({ ...DEFAULT_STATE });
    const second = JSON.parse(String(mockWriteSync.mock.calls[1][1]));
    expect(second.preferences.statusLineConsent).toBe('declined');
    expect(second.preferences.statusLineConsentCommand).toBe('foreign-cmd');
    expect(second.preferences.chromeImport).toEqual({ lastImportedAt: 5, profileId: 'Default', cookieCount: 7, skippedV11: 0 });
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

    expect(String(mockOpenSync.mock.calls[0][0]).replaceAll('\\', '/')).toContain('/mock/home/.finevibe/state.json.tmp');
    expect(mockFsyncSync).toHaveBeenCalledOnce();
    expect(mockCloseSync).toHaveBeenCalledOnce();
    // Neither may overtake the data flush: a rename that wins leaves a
    // truncated state.json with the .tmp recovery copy already consumed.
    expect(mockFsyncSync.mock.invocationCallOrder[0]).toBeLessThan(mockRenameSync.mock.invocationCallOrder[0]);
    expect(mockCloseSync.mock.invocationCallOrder[0]).toBeLessThan(mockRenameSync.mock.invocationCallOrder[0]);
  });

  // P2-101: state.json can carry secrets (`project.defaultEnv`). The writer
  // opens the temp file 0600 (mode at create) and fchmods it (covers a .tmp
  // left by an older 0644 build); the rename carries the mode to state.json.
  it('opens the temp file 0600 and chmods it for secrets at rest', () => {
    saveStateSync(DEFAULT_STATE);

    expect(mockOpenSync.mock.calls[0][1]).toBe('w');
    expect(mockOpenSync.mock.calls[0][2]).toBe(0o600);
    expect(vi.mocked(fs.fchmodSync)).toHaveBeenCalledWith(
      mockOpenSync.mock.results[0].value,
      0o600,
    );
  });

  it('closes the descriptor and skips the rename when the write fails', () => {
    mockWriteSync.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    saveStateSync(DEFAULT_STATE);

    expect(mockCloseSync).toHaveBeenCalledOnce();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('retries the rename through transient Windows lock failures (EPERM/EBUSY)', () => {
    // AV scans and editor buffers hold state.json open; renameSync onto
    // the locked target fails EPERM/EBUSY. The save must survive the
    // lock, not lose the write.
    const locked = (code: string) => Object.assign(new Error(`${code}: locked`), { code });
    mockRenameSync
      .mockImplementationOnce(() => { throw locked('EPERM'); })
      .mockImplementationOnce(() => { throw locked('EBUSY'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    saveStateSync(DEFAULT_STATE);

    expect(mockRenameSync).toHaveBeenCalledTimes(3);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('gives up after the rename budget: logged, fsynced .tmp left for startup recovery', () => {
    const locked = () => Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
    mockRenameSync.mockImplementation(() => { throw locked(); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    saveStateSync(DEFAULT_STATE);

    // 5 attempts, 50ms doubling backoff; the payload is NOT lost — the
    // fsynced .tmp survives (loadState consumes it at next startup).
    expect(mockRenameSync).toHaveBeenCalledTimes(5);
    expect(err).toHaveBeenCalledWith('Failed to save state:', expect.objectContaining({ code: 'EPERM' }));
    err.mockRestore();
  });

  it('does not retry a rename failure that is not a lock', () => {
    mockRenameSync.mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device'), { code: 'EXDEV' });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    saveStateSync(DEFAULT_STATE);

    expect(mockRenameSync).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalledWith('Failed to save state:', expect.objectContaining({ code: 'EXDEV' }));
    err.mockRestore();
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


// P1-12: the gate root set (isWithinKnownProject → fs:*, git:*, readiness,
// MCP) is main-owned. projects[].path arrives from the renderer
// (`store:save`) and from a disk file any local peer can write — never
// verbatim.
describe('main-owned gate root set (P1-12)', () => {
  const FS_ROOT = process.platform === 'win32' ? 'C:\\' : '/';
  const projectAt = (projectPath: string): ProjectRecord => ({
    id: `p-${projectPath}`,
    name: 'P',
    path: projectPath,
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  });
  const missing = (p: string): void => {
    mockStatSync.mockImplementation((pathLike) => {
      if (String(pathLike) === p) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => true } as unknown as fs.Stats;
    });
  };

  it('saveState refuses a fabricated gate root: the root set does not widen', () => {
    saveState({ ...DEFAULT_STATE, projects: [projectAt(FS_ROOT)] });
    // One `store:save` with projects:[{path:'C:\\'}] must not authorize
    // arbitrary fs/git/MCP access — the root set stays shut.
    expect(getKnownProjectPaths()).toEqual([]);
  });

  it('saveState refuses the home root, missing dirs and CLI config dirs, keeps real dirs', () => {
    missing('/mock/home/gone');
    saveState({
      ...DEFAULT_STATE,
      projects: [
        projectAt('/mock/home'),
        projectAt('/mock/home/gone'),
        projectAt('/mock/home/.claude'),
        projectAt('/mock/home/projects/real'),
      ],
    });
    expect(getKnownProjectPaths()).toEqual(['/mock/home/projects/real']);
  });

  it('saveState persists the renderer payload verbatim (persistence is not the gate)', () => {
    saveState({ ...DEFAULT_STATE, projects: [projectAt(FS_ROOT)] });
    const written = JSON.parse(String(mockWriteSync.mock.calls[0][1]));
    expect(written.projects.map((p: ProjectRecord) => p.path)).toContain(FS_ROOT);
  });

  it('loadState drops persisted projects that fail root validation and logs drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    missing('/mock/home/gone');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      version: 1,
      projects: [projectAt('/mock/home/projects/real'), projectAt(FS_ROOT), projectAt('/mock/home/gone')],
      activeProjectId: null,
    }));
    const loaded = loadState();
    // A peer-written state.json must not persist a gate root across boots.
    expect(loaded.projects.map(p => p.path)).toEqual(['/mock/home/projects/real']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(FS_ROOT));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/mock/home/gone'));
    warn.mockRestore();
  });
});

// PA-08: the validated gate root set is memoized per save — an unchanged
// project list costs zero fs calls, a grown list validates only the diff,
// and refused paths are deliberately NOT cached (they re-validate, warn,
// and recover on every save).
describe('gate root memo (PA-08)', () => {
  const projectAt = (projectPath: string): ProjectRecord => ({
    id: `p-${projectPath}`,
    name: 'P',
    path: projectPath,
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  });
  const missing = (p: string): void => {
    mockStatSync.mockImplementation((pathLike) => {
      if (String(pathLike) === p) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => true } as unknown as fs.Stats;
    });
  };

  it('re-saving an unchanged project list performs zero stat/realpath syscalls', () => {
    const state = {
      ...DEFAULT_STATE,
      projects: [projectAt('/mock/home/projects/a'), projectAt('/mock/home/projects/b')],
    };
    saveState(state);
    expect(mockStatSync).toHaveBeenCalled(); // the first save validates every path
    mockStatSync.mockClear();
    mockRealpathSync.mockClear();

    saveState(state);

    expect(mockStatSync).not.toHaveBeenCalled();
    expect(mockRealpathSync).not.toHaveBeenCalled();
    expect(getKnownProjectPaths()).toEqual(['/mock/home/projects/a', '/mock/home/projects/b']);
  });

  it('adding one project costs exactly one stat + one realpath', () => {
    saveState({ ...DEFAULT_STATE, projects: [projectAt('/mock/home/projects/a')] });
    mockStatSync.mockClear();
    mockRealpathSync.mockClear();

    saveState({
      ...DEFAULT_STATE,
      projects: [projectAt('/mock/home/projects/a'), projectAt('/mock/home/projects/new')],
    });

    expect(mockStatSync).toHaveBeenCalledTimes(1);
    expect(mockStatSync).toHaveBeenCalledWith('/mock/home/projects/new');
    expect(mockRealpathSync).toHaveBeenCalledTimes(1);
    expect(mockRealpathSync).toHaveBeenCalledWith('/mock/home/projects/new');
    expect(getKnownProjectPaths()).toEqual(['/mock/home/projects/a', '/mock/home/projects/new']);
  });

  it('re-validates a dropped path on every save while a cached sibling costs zero syscalls', () => {
    // Own fs state: no state file, so the empty-cache graft in saveState
    // skips loadState() — the previous test's persisted existsSync/readFileSync
    // mocks would otherwise make it load and validate that test's project list
    // (extra stats, extra drop warnings), inflating the counts asserted below.
    mockExistsSync.mockReturnValue(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    missing('/mock/home/gone');
    const state = {
      ...DEFAULT_STATE,
      projects: [projectAt('/mock/home/projects/real'), projectAt('/mock/home/gone')],
    };
    saveState(state);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/mock/home/gone'));
    mockStatSync.mockClear();
    mockRealpathSync.mockClear();

    saveState(state);

    // Failures are never cached: the refused path is statted again and
    // warns again, so a directory that reappears recovers...
    expect(mockStatSync).toHaveBeenCalledTimes(1);
    expect(mockStatSync).toHaveBeenCalledWith('/mock/home/gone');
    expect(warn).toHaveBeenCalledTimes(2);
    // ...while the valid sibling is served from the per-path cache.
    expect(mockRealpathSync).not.toHaveBeenCalled();
    expect(mockStatSync.mock.calls.map((call) => String(call[0]))).not.toContain('/mock/home/projects/real');
    warn.mockRestore();
  });

  // B1: the memo was unbounded (only invalidateStateCache cleared it) — a
  // session that keeps gating on fresh project paths grew it forever.
  it('caps the per-path canonical memo at 200 entries, oldest evicted first', () => {
    // Own fs state: no state file — an existsSync mock leaked from a prior
    // test would make saveState's empty-cache graft run loadState(), whose
    // project validation adds realpath calls for '/mock/home/projects/...'
    // paths and breaks the memo-miss count below.
    mockExistsSync.mockReturnValue(false);
    const paths = Array.from({ length: GATE_ROOT_CANONICAL_MAX }, (_, i) => `/mock/home/projects/p${i}`);
    saveState({ ...DEFAULT_STATE, projects: paths.map(projectAt) });
    // One realpath per project path. The lazily recomputed CLI-config-root
    // canonicals (dropped with the memo by invalidateStateCache) ride along
    // on this first save — they are process constants, not memo misses, so
    // the memo contract is counted on project paths only.
    const isProjectPath = (call: unknown[]): boolean =>
      String(call[0]).startsWith('/mock/home/projects/');
    expect(mockRealpathSync.mock.calls.filter(isProjectPath)).toHaveLength(GATE_ROOT_CANONICAL_MAX);

    // One more path: the cap+1-th insert evicts the oldest (p0), FIFO.
    saveState({ ...DEFAULT_STATE, projects: [...paths.map(projectAt), projectAt('/mock/home/projects/overflow')] });
    mockStatSync.mockClear();
    mockRealpathSync.mockClear();

    // p0 was evicted: it re-validates. Its re-insert hits the cap again and
    // evicts the NEXT oldest survivor (p1), which the same loop then
    // re-validates — pure FIFO cascade, never a policy miss. saveState's
    // own persistence bookkeeping (state-file stat checks) rides along, so
    // the memo contract is counted on project paths only.
    saveState({ ...DEFAULT_STATE, projects: [projectAt(paths[0]!), projectAt(paths[1]!)] });
    expect(mockStatSync.mock.calls.filter(isProjectPath).map((c) => String(c[0]))).toEqual([paths[0], paths[1]]);
    expect(mockRealpathSync.mock.calls.filter(isProjectPath).map((c) => String(c[0]))).toEqual([paths[0], paths[1]]);
  });
});

// ENOSPC write storm (workstation incident, 2026-10-23): a full disk made
// every renderer `store:save` IPC a failed atomic write, and the old
// catch-and-log printed a full stack per attempt (~400/min, journald-
// mirrored, consuming the very space it complained about). The backoff
// machine in writeStateAtomically must log ONCE per outage and retry on
// one exponential timer, never per event.
describe('write-failure backoff (ENOSPC storm)', () => {
  const enospc = () =>
    Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

  it('logs the failure once, stays silent across a save storm', () => {
    resetWriteStateForTests(); // clean leading edge: drop leaked throttle/backoff state from a prior case
    mockWriteSync.mockImplementation(() => {
      throw enospc();
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 20; i++) {
      saveState({ ...DEFAULT_STATE, activeProjectId: `storm-${i}` });
      vi.advanceTimersByTime(400); // every save takes the leading edge
    }

    // Flood regression: pre-backoff this logged ~20 full stacks (leading
    // edge per save + trailing timer writes). Now the first failure logs
    // with the exact legacy shape, and every repeat — the swallowed
    // mutations and the retry timer's own failures (1s/2s/4s fire inside
    // the 8s of advancing) — stays silent.
    expect(err).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith('Failed to save state:', expect.objectContaining({ code: 'ENOSPC' }));
    err.mockRestore();
  });

  it('backs off to the 60s cap, then recovers with one line', () => {
    resetWriteStateForTests();
    mockWriteSync.mockImplementation(() => {
      throw enospc();
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    // The 'gives up after the rename budget' case installs a PERSISTENT
    // mockImplementation(throw EPERM) on renameSync, and beforeEach's
    // vi.clearAllMocks() = mockClear keeps persistent implementations.
    // Neutralize that leak locally: the recovery attempt must reach a
    // successful rename for the success handler to fire.
    mockRenameSync.mockImplementation(() => undefined);

    saveState(DEFAULT_STATE); // leading-edge attempt #1: logs once
    expect(mockWriteSync).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);

    // The outage retries on the doubling 1s→60s-capped series — NOT the
    // 300ms throttle. Renderer mutations keep arriving during every step;
    // the backoff gate swallows them at zero write syscalls per event.
    const cadence = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    for (let step = 0; step < cadence.length; step++) {
      for (let burst = 0; burst < 3; burst++) {
        saveState({ ...DEFAULT_STATE, activeProjectId: `outage-${step}-${burst}` });
        vi.advanceTimersByTime(200); // 600ms of mutations < the 1s floor
      }
      vi.advanceTimersByTime(cadence[step] - 600);
      expect(mockWriteSync).toHaveBeenCalledTimes(step + 2); // ONE attempt per step
    }
    expect(err).toHaveBeenCalledTimes(1); // 8 repeats counted, not logged

    // Disk recovers: the next backoff step writes, logs ONE recovery line,
    // and no new error fires.
    mockWriteSync.mockImplementation(((
      _fd: number,
      buffer: Buffer,
      position = 0,
    ) => buffer.length - position) as unknown as typeof fs.writeSync);
    vi.advanceTimersByTime(60000);

    expect(mockWriteSync).toHaveBeenCalledTimes(cadence.length + 2);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('State saved after 8 failed attempt(s)');
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
    info.mockRestore();
  });
});

// SA-P2-8: a corrupt state.json used to mean a silent whole-state reset (the
// .tmp sibling is a consumed crash artifact, so it is missing exactly when it
// is needed), and `version !== 1` reset to defaults with one generic warn and
// no migration seam. Recovery order is .tmp → .good → defaults, each with a
// distinct warn; the version path is the documented migrateState() seam.
describe('state recovery and the migration seam (SA-P2-8)', () => {
  const pathEnds = (p: unknown, suffix: string): boolean =>
    String(p).replaceAll('\\', '/').endsWith(suffix);
  const diskFiles = (files: Record<string, string>): void => {
    mockExistsSync.mockImplementation((p) =>
      Object.keys(files).some((suffix) => pathEnds(p, suffix)));
    mockReadFileSync.mockImplementation((p) => {
      const hit = Object.keys(files).find((suffix) => pathEnds(p, suffix));
      if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[hit]!;
    });
  };
  const stateAt = (id: string): string =>
    JSON.stringify({ ...DEFAULT_STATE, activeProjectId: id });

  it('recovers a corrupt state.json from the last-known-good copy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diskFiles({
      'state.json': '{corrupt',
      'state.json.good': stateAt('from-good'),
    });

    expect(loadState().activeProjectId).toBe('from-good');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('last-known-good'),
    );
    warn.mockRestore();
  });

  it('prefers a valid .tmp over the good copy when state.json is corrupt', () => {
    // Existing behavior pinned: the .tmp check runs first, and with no
    // parseable state.json it wins on mtime by definition.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diskFiles({
      'state.json': '{corrupt',
      'state.json.tmp': stateAt('from-tmp'),
      'state.json.good': stateAt('from-good'),
    });

    expect(loadState().activeProjectId).toBe('from-tmp');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('temp file'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('last-known-good'));
    warn.mockRestore();
  });

  it('falls back to defaults, loudly, when the good copy is gone too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diskFiles({ 'state.json': '{corrupt' });

    expect(loadState()).toEqual(DEFAULT_STATE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No valid state file'));
    warn.mockRestore();
  });

  it('refuses a future version through the migration seam: defaults + a version warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    diskFiles({ 'state.json': JSON.stringify({ ...DEFAULT_STATE, version: 2 }) });

    expect(loadState()).toEqual(DEFAULT_STATE);
    // Distinct from the corrupt/defaults warns: it names the version and the seam.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('version 2 has no migration path'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('last-known-good'));
    warn.mockRestore();
  });

  it('mirrors every successful commit to state.json.good (0600)', () => {
    saveStateSync({ ...DEFAULT_STATE, activeProjectId: 'committed' });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(pathEnds(mockWriteFileSync.mock.calls[0]![0], 'state.json.good')).toBe(true);
    expect(JSON.parse(String(mockWriteFileSync.mock.calls[0]![1])).activeProjectId).toBe('committed');
    expect(mockWriteFileSync.mock.calls[0]![2]).toEqual({ mode: 0o600 });
    // The mirror runs after the commit rename, never before it.
    expect(mockRenameSync.mock.invocationCallOrder[0]!).toBeLessThan(
      mockWriteFileSync.mock.invocationCallOrder[0]!,
    );
  });

  it('does not report a good-copy failure as a state write failure', () => {
    // state.json committed; a .good write failure must not log the ENOSPC
    // outage line nor arm the write backoff for a write that worked.
    mockWriteFileSync.mockImplementation(() => { throw new Error('ENOSPC'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    saveStateSync(DEFAULT_STATE);

    expect(mockRenameSync).toHaveBeenCalledOnce();
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
