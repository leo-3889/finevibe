import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the Windows app identity (startMainProcess in main.ts).
// Without an explicit AppUserModelID, Windows attributes the running process to
// "Electron" — taskbar group, Alt+Tab entry, Start-menu shortcut and toasts all
// say Electron, which is exactly the bug behind the "default Electron icon"
// report on dev/portable Windows runs.
//
// Same mocked-electron boot pattern as main-single-instance.test.ts: main.ts has
// no exports and boots from the module body, so each case re-executes it with
// vi.resetModules + dynamic import against its own mocks. './platform' is mocked
// through a live getter so a single file can drive both the win32 and the
// POSIX branch.
//
// This is the sanctioned exception to the static-import preference: a static
// `import './main'` is hoisted once per file, so it cannot re-run the boot.

const { app, windows, calls, platform, fakeProvider } = vi.hoisted(() => {
  const windows: unknown[] = [];
  // Boot order probe: identity must be stamped before the first window exists.
  const calls: string[] = [];
  const platform = { isWin: true };
  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
    getPath: () => '/mock/userdata',
    setAppUserModelId: vi.fn(() => { calls.push('aumid'); }),
  };
  const fakeProvider = {
    meta: { displayName: 'Fake CLI' },
    validatePrerequisites: () => true,
    installHooks: vi.fn(async () => {}),
    installStatusScripts: vi.fn(),
  };
  return { app, windows, calls, platform, fakeProvider };
});

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false;
    isDestroyed = (): boolean => this.destroyed;
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
      calls.push('window');
    }
    static getAllWindows(): unknown[] {
      return windows.filter((w) => !(w as { isDestroyed(): boolean }).isDestroyed());
    }
    static fromWebContents(): unknown {
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
    ipcMain: { on: vi.fn() },
    session: {
      fromPartition: vi.fn(() => ({ clearStorageData: vi.fn(async () => {}) })),
    },
  };
});

vi.mock('./ipc-handlers', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ipc-handlers')>();
  return { ...real, registerIpcHandlers: vi.fn(), resetHookWatcher: vi.fn() };
});
// main.ts imports both members it calls at boot (killAllPtys on quit, and
// the C2M-02 PATH prewarm), so the factory must carry both names.
vi.mock('./pty-manager', () => ({ killAllPtys: vi.fn(), getFullPathAsync: vi.fn(async () => '/usr/bin') }));
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
vi.mock('./config-watcher', () => ({ stopConfigWatcher: vi.fn() }));
vi.mock('./mcp-client', () => ({ disconnectAll: vi.fn() }));
vi.mock('./prerequisites', () => ({ checkPythonAvailable: vi.fn(() => null) }));
// PA-01: main.ts wires the probe cache to userData at boot; stub the module.
vi.mock('./providers/resolve-binary', () => ({ configureProbeCacheDir: vi.fn() }));
// Live getter: main.ts reads `isWin` at boot, so the case can flip the flag
// between imports without a second mock registration.
vi.mock('./platform', () => ({ isMac: false, get isWin() { return platform.isWin; } }));
vi.mock('./chrome-import/copy', () => ({ sweepImportTempDirs: vi.fn() }));
vi.mock('./close-state', () => ({
  isCloseConfirmed: vi.fn(() => true),
  setCloseConfirmed: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  windows.length = 0;
  calls.length = 0;
  platform.isWin = true;
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true);
  vi.mocked(app.setAppUserModelId).mockClear();
});

describe('Windows AppUserModelID', () => {
  it('is set to the builder appId on win32, before the window boots', async () => {
    await import('./main');

    // startMainProcess() runs synchronously off the single-instance gate, so the
    // identity is stamped on the process BEFORE the window exists — Windows needs
    // the AUMID ahead of the first taskbar button.
    expect(app.setAppUserModelId).toHaveBeenCalledTimes(1);
    expect(app.setAppUserModelId).toHaveBeenCalledWith('com.finevibe.app');
    expect(calls).toEqual(['aumid', 'window']);

    // The rest of the boot is untouched by the identity call.
    await vi.waitFor(() => expect(windows.length).toBeGreaterThan(0));
  });

  it('is not set on non-win32 platforms', async () => {
    platform.isWin = false;

    await import('./main');
    await vi.waitFor(() => expect(windows.length).toBeGreaterThan(0));

    expect(app.setAppUserModelId).not.toHaveBeenCalled();
  });

  // P1-1 companion: the single-instance loser boots NOTHING, so it must not
  // claim the app identity while another instance owns it.
  it('is not set by the single-instance loser', async () => {
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false);

    await import('./main');
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));

    expect(app.setAppUserModelId).not.toHaveBeenCalled();
    expect(windows.length).toBe(0);
  });
});
