import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression test for the not-built boot guard (rendererIsBuilt in main.ts).
// With dist/ missing, `electron .` used to exit SILENTLY — the app:// load of a
// nonexistent index.html killed the window and the app — and users then
// launched bare `electron` and landed on the stock Electron welcome window.
// The guard must show the not-built dialog naming the missing artifact,
// quit, and construct NO window.
//
// Same mocked-electron boot pattern as main-app-user-model-id.test.ts:
// main.ts has no exports and boots from the module body, so the case
// re-executes it with vi.resetModules + dynamic import against its mocks.
// The guard (and installConsoleThrottle) skip their work under VITEST so the
// other mocked-boot suites can boot main.ts from the SOURCE tree, where the
// dist-relative index.html never exists; this case unsets VITEST around the
// import to exercise the real guard path, and restores the console methods
// the throttle patches at module scope.

const { app, dialog, windows } = vi.hoisted(() => {
  const windows: unknown[] = [];
  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: () => Promise.resolve(),
    getPath: () => '/mock/userdata',
    setAppUserModelId: vi.fn(),
  };
  const dialog = {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  };
  return { app, dialog, windows };
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
    loadURL = vi.fn();
    on = vi.fn();
    constructor() {
      windows.push(this);
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
    // main.ts registers/serves the renderer over app:// (src/main/app-scheme.ts):
    // registerAppScheme() runs at module scope, so the electron mock must carry
    // `protocol`, and app-scheme imports `net` for the file fetch.
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    net: { fetch: vi.fn() },
    dialog,
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
vi.mock('./pty-manager', () => ({ killAllPtys: vi.fn(), getFullPathAsync: vi.fn(async () => '/usr/bin') }));
vi.mock('./store', () => ({
  flushState: vi.fn(),
  loadState: vi.fn(() => ({ preferences: {} })),
}));
vi.mock('./menu', () => ({ createAppMenu: vi.fn() }));
vi.mock('./hook-status', () => ({ restartAndResync: vi.fn() }));
vi.mock('./providers/registry', () => ({
  initProviders: vi.fn(),
  getAllProviders: vi.fn(() => []),
}));
vi.mock('./auto-updater', () => ({ initAutoUpdater: vi.fn() }));
vi.mock('./git-watcher', () => ({ stopGitWatcher: vi.fn() }));
vi.mock('./file-watcher', () => ({ stopAllFileWatchers: vi.fn() }));
vi.mock('./config-watcher', () => ({ stopConfigWatcher: vi.fn() }));
vi.mock('./mcp-client', () => ({ disconnectAll: vi.fn() }));
vi.mock('./prerequisites', () => ({ checkPythonAvailable: vi.fn(() => null) }));
vi.mock('./providers/resolve-binary', () => ({ configureProbeCacheDir: vi.fn() }));
vi.mock('./platform', () => ({ isMac: false, isWin: false }));
vi.mock('./chrome-import/copy', () => ({ sweepImportTempDirs: vi.fn() }));
vi.mock('./close-state', () => ({
  isCloseConfirmed: vi.fn(() => true),
  setCloseConfirmed: vi.fn(),
}));

let savedVitest: string | undefined;
const consoleOriginals = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

beforeEach(() => {
  vi.resetModules();
  windows.length = 0;
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true);
  vi.mocked(app.quit).mockClear();
  vi.mocked(dialog.showErrorBox).mockClear();
  // Unset VITEST so the import runs the REAL guard (and the real
  // installConsoleThrottle) instead of the mocked-boot fast paths.
  savedVitest = process.env.VITEST;
  delete process.env.VITEST;
});

afterEach(() => {
  if (savedVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitest;
  // The module-scope installConsoleThrottle() ran with VITEST unset and
  // patched the shared console object; hand the pristine methods back.
  Object.assign(console, consoleOriginals);
});

describe('not-built boot guard', () => {
  it('shows the not-built dialog naming the missing renderer, quits, and opens no window', async () => {
    // RENDERER_INDEX_PATH resolves to <repo>/renderer/index.html here (the
    // suite runs main.ts from src/main), which never exists — the guard fires.
    await import('./main');

    await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalledTimes(1));

    const [title, body] = vi.mocked(dialog.showErrorBox).mock.calls[0];
    expect(title).toBe('FineVibe is not built');
    // Names the exact missing artifact and the fix...
    expect(body).toMatch(/renderer[\\/]index\.html/);
    expect(body).toContain('npm run build');
    // ...and the boot stops there: quit, and NO BrowserWindow constructed.
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(windows.length).toBe(0);
  });
});
