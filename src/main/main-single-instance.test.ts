import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Smoke test for the single-instance gate in main.ts. main.ts has no
// exports — the gate runs at module import — so the test mocks 'electron'
// (recording app.on handlers and BrowserWindow instances) plus every
// dependency main.ts touches, imports the module fresh per case, and
// drives the recorded handlers. This is the same mocked-electron pattern
// auto-updater.test.ts uses; the app.whenReady chain in main.ts is fully
// mocked through (providers, ipc, store, …) so nothing real runs.

interface MockWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
}

const { appHandlers, app, windows, fakeProvider } = vi.hoisted(() => {
  const appHandlers: Record<string, (...args: unknown[]) => void> = {};
  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      appHandlers[event] = cb;
    }),
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
  };
  const windows: MockWindow[] = [];
  const fakeProvider = {
    meta: { displayName: 'Fake CLI' },
    validatePrerequisites: () => true,
    installHooks: vi.fn(async () => {}),
    installStatusScripts: vi.fn(),
  };
  return { appHandlers, app, windows, fakeProvider };
});

vi.mock('electron', () => {
  class BrowserWindow implements MockWindow {
    destroyed = false;
    isDestroyed = (): boolean => this.destroyed;
    isMinimized = vi.fn(() => true);
    restore = vi.fn();
    focus = vi.fn();
    webContents = {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
    };
    loadFile = vi.fn();
    on = vi.fn();
    constructor() {
      windows.push(this);
    }
    static getAllWindows(): MockWindow[] {
      return windows.filter((w) => !w.isDestroyed());
    }
    static fromWebContents(): MockWindow | null {
      return null;
    }
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    },
    powerMonitor: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('./ipc-handlers', () => ({ registerIpcHandlers: vi.fn(), resetHookWatcher: vi.fn() }));
vi.mock('./pty-manager', () => ({ killAllPtys: vi.fn() }));
vi.mock('./store', () => ({
  flushState: vi.fn(),
  loadState: vi.fn(() => ({ preferences: {} })),
}));
vi.mock('./menu', () => ({ createAppMenu: vi.fn() }));
vi.mock('./hook-status', () => ({ restartAndResync: vi.fn() }));
vi.mock('./providers/registry', () => ({
  initProviders: vi.fn(),
  getAllProviders: vi.fn(() => [fakeProvider]),
}));
vi.mock('./auto-updater', () => ({ initAutoUpdater: vi.fn() }));
vi.mock('./git-watcher', () => ({ stopGitWatcher: vi.fn() }));
vi.mock('./file-watcher', () => ({ stopAllFileWatchers: vi.fn() }));
vi.mock('./mcp-client', () => ({ disconnectAll: vi.fn() }));
vi.mock('./prerequisites', () => ({ checkPythonAvailable: vi.fn(() => null) }));
vi.mock('./platform', () => ({ isMac: false, isWin: false }));
vi.mock('./close-state', () => ({
  isCloseConfirmed: vi.fn(() => true),
  setCloseConfirmed: vi.fn(),
}));

// Dynamic import is the point of this suite: main.ts runs the
// single-instance gate at module scope, so each case must re-execute the
// module body (vi.resetModules + await import) against its own mocks.
async function importPrimaryInstance(): Promise<void> {
  await import('./main');
  // The window is created inside app.whenReady().then(...) — flush the
  // mocked chain before touching the recorded window.
  await vi.waitFor(() => expect(windows.length).toBeGreaterThan(0));
}

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(appHandlers)) delete appHandlers[key];
  windows.length = 0;
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true);
  vi.mocked(app.quit).mockClear();
  vi.mocked(app.on).mockClear();
});

describe('single-instance gate', () => {
  it('quits immediately when another instance holds the lock', async () => {
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false);

    await import('./main');

    expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // The loser must not start serving relaunches.
    expect(appHandlers['second-instance']).toBeUndefined();
  });

  it('registers a second-instance handler that restores and focuses the window', async () => {
    await importPrimaryInstance();

    expect(app.quit).not.toHaveBeenCalled();
    expect(appHandlers['second-instance']).toBeTypeOf('function');

    const win = windows[0];
    appHandlers['second-instance']();
    expect(win.isMinimized).toHaveBeenCalled();
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('focuses a visible window without restoring it', async () => {
    await importPrimaryInstance();

    const win = windows[0];
    vi.mocked(win.isMinimized as MockedFunction<() => boolean>).mockReturnValue(false);
    appHandlers['second-instance']();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('is a no-op when every window is destroyed', async () => {
    await importPrimaryInstance();

    windows[0].destroyed = true;
    expect(() => appHandlers['second-instance']()).not.toThrow();
    expect(windows[0].focus).not.toHaveBeenCalled();
  });
});
