import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stopGitWatcher } from './git-watcher';
import { stopConfigWatcher } from './config-watcher';
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
  handlers: Record<string, (arg?: unknown) => void>;
  focus: () => void;
}

const { appHandlers, app, windows, fakeProvider, ipcHandlers, ipcMainOn, closeState } = vi.hoisted(() => {
  const appHandlers: Record<string, (...args: unknown[]) => void> = {};
  // Audit row 89: main.ts registers its ipcMain handlers with literal channel
  // names; recording them by channel lets a case invoke the close lanes
  // directly (the real ipc-handlers registration is mocked out here).
  const ipcHandlers: Record<string, (...args: unknown[]) => void> = {};
  const app = {
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      appHandlers[event] = cb;
    }),
    quit: vi.fn(),
    // PA-01: the boot chain wires the probe cache via app.getPath('userData')
    // right after createWindow; without this the continuation dies before the
    // probe fan-out (probe-order test sees []).
    getPath: () => '/mock/userdata',
    whenReady: () => Promise.resolve(),
  };
  const windows: MockWindow[] = [];
  const fakeProvider = {
    meta: { displayName: 'Fake CLI' },
    validatePrerequisites: () => true,
    installHooks: vi.fn(async () => {}),
    installStatusScripts: vi.fn(),
  };
  // main.ts imports isCloseConfirmed/setCloseConfirmed and the watchdog reads
  // the flag inside its timer, so the mock is hoisted: a case flips the flag
  // and beforeEach restores the boot default (confirmed).
  const closeState = {
    isCloseConfirmed: vi.fn(() => true),
    setCloseConfirmed: vi.fn(),
  };
  return {
    appHandlers,
    app,
    windows,
    fakeProvider,
    ipcHandlers,
    closeState,
    ipcMainOn: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcHandlers[channel] = handler;
    }),
  };
});

// P2-47: the winner's whenReady chain sweeps stale finevibe-chrome-import-*
// temp leftovers (boot call site in main.ts). Spied, never real.
const sweepImportSpy = vi.hoisted(() => vi.fn());

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
    loadURL = vi.fn();
    handlers: Record<string, (arg?: unknown) => void> = {};
    on = vi.fn((event: string, cb: (arg?: unknown) => void) => { this.handlers[event] = cb; });
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
    // main.ts registers/serves the renderer over app:// (src/main/app-scheme.ts):
    // registerAppScheme() runs at module scope, so the electron mock must carry
    // `protocol`, and app-scheme imports `net` for the file fetch.
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    net: { fetch: vi.fn() },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    },
    powerMonitor: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
    // main.ts registers the browser:clearIsolatedStorage jar clear on
    // ipcMain and resolves the isolated partition through session.
    ipcMain: { on: ipcMainOn },
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
// PA-01: main.ts wires the cross-launch probe cache to userData at boot;
// the real module touches fs/child_process — stub it.
vi.mock('./providers/resolve-binary', () => ({ configureProbeCacheDir: vi.fn() }));
// main.ts imports the row-85 GPU-hatch decision at boot, so the factory must
// carry it; these cases never exercise the hatch.
vi.mock('./platform', () => ({
  isMac: false,
  isWin: false,
  shouldDisableHardwareAcceleration: () => false,
}));
vi.mock('./chrome-import/copy', () => ({ sweepImportTempDirs: sweepImportSpy }));
vi.mock('./close-state', () => closeState);

// Dynamic import is the point of this suite: main.ts runs the
// single-instance gate at module scope, so each case must re-execute the
// module body (vi.resetModules + await import) against its own mocks.
async function importPrimaryInstance(): Promise<void> {
  await import('./main');
  // The window is created inside app.whenReady().then(...) — flush the
  // mocked chain before touching the recorded window.
  await vi.waitFor(() => expect(windows.length).toBeGreaterThan(0));
  // No extra await here: this suite's hoisted mock state (windows,
  // appHandlers) is reset in beforeEach, and an added macrotask/microtask
  // turn lets the previous import's whenReady continuations land across
  // that reset (deterministically red when stressed 25x). The P1-6 console
  // race is fixed at the source — the store mock above keeps main.ts from
  // emitting any user console log.
}

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(appHandlers)) delete appHandlers[key];
  windows.length = 0;
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true);
  vi.mocked(app.quit).mockClear();
  vi.mocked(app.on).mockClear();
  vi.mocked(sweepImportSpy).mockClear();
  for (const key of Object.keys(ipcHandlers)) delete ipcHandlers[key];
  closeState.isCloseConfirmed.mockReturnValue(true);
  closeState.setCloseConfirmed.mockClear();
  fakeProvider.validatePrerequisites = () => true;
});

describe('single-instance gate', () => {
  it('quits immediately when another instance holds the lock', async () => {
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false);

    // Delta (order-independence audit 2026-10-26): a shuffled predecessor's
    // deferred boot-chain continuation (main.ts:476-481) can land a quit
    // during this case. Exactly ONE quit must be attributable to THIS import.
    const quitBase = app.quit.mock.calls.length;
    const lockBase = app.requestSingleInstanceLock.mock.calls.length;
    await import('./main');

    expect(app.requestSingleInstanceLock.mock.calls.length - lockBase).toBe(1);
    expect(app.quit.mock.calls.length - quitBase).toBe(1);
    // The loser must not start serving relaunches.
    expect(appHandlers['second-instance']).toBeUndefined();

    // P1-1: the loser must boot NOTHING. The full UI stack (window, IPC,
    // browser/webview surface, lifecycle handlers) used to run from
    // app.whenReady() in the loser before quit() could take effect.
    await vi.waitFor(() => expect(windows.length).toBe(0));
    expect(appHandlers['before-quit']).toBeUndefined();
    expect(appHandlers['window-all-closed']).toBeUndefined();
    // P2-47: the boot sweep rides the winner's whenReady chain — the loser
    // must not sweep (it must boot NOTHING, including temp cleanup).
    expect(sweepImportSpy).not.toHaveBeenCalled();
  });

  it('registers a second-instance handler that restores and focuses the window', async () => {
    await importPrimaryInstance();

    expect(app.quit).not.toHaveBeenCalled();
    expect(appHandlers['second-instance']).toBeTypeOf('function');
    // P2-47 pin (boot call site): exactly one sweep, in the boot chain.
    expect(sweepImportSpy).toHaveBeenCalledTimes(1);

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

  // P2-52: after a macOS close-and-reopen the git/config watchers kept
  // their handle on the DESTROYED window (startGitWatcher/startConfigWatcher
  // early-return with an unchanged project and never re-point currentWin),
  // so git:changed/config:changed were dropped for the life of the app and
  // the old watch handles leaked. Releasing them on 'closed' makes the
  // reopened window's next start* call re-point them.
  it('releases the git and config watchers when the window closes', async () => {
    await importPrimaryInstance();

    windows[0].handlers['closed']!();

    expect(vi.mocked(stopGitWatcher)).toHaveBeenCalled();
    expect(vi.mocked(stopConfigWatcher)).toHaveBeenCalled();
  });

  // PA-01: the all-missing probe sweep used to gate the first window
  // (serial spawn probes, up to 2.4 s cold). It now runs AFTER
  // createWindow, in parallel — a probe must observe the window existing.
  it('creates the window before the provider availability probes run', async () => {
    const probeOrder: string[] = [];
    fakeProvider.validatePrerequisites = () => {
      probeOrder.push(windows.length > 0 ? 'probe-after-window' : 'probe-before-window');
      return true;
    };

    await importPrimaryInstance();

    expect(probeOrder).toEqual(['probe-after-window']);
  });
});

// Audit row 89: the C4S-07 close-confirmation watchdog (main.ts,
// CLOSE_CONFIRM_WATCHDOG_MS = 15 s) exists to end a quit that a HUNG renderer
// never answered. It used to be the only timer, so an explicit Cancel in the
// quit confirm — which answers nothing on IPC — was indistinguishable from a
// hang, and the app force-quit (killAllPtys) 15 s after the user dismissed the
// dialog. The renderer now answers Cancel with 'app:closeCancelled'.
describe('close-confirmation watchdog', () => {
  // main.ts CLOSE_CONFIRM_WATCHDOG_MS; not exported, kept in sync by hand.
  const WATCHDOG_MS = 15_000;
  const quitEvent = { preventDefault: vi.fn() };

  afterEach(() => {
    vi.useRealTimers();
  });

  // Unconfirmed close: before-quit preventDefaults and arms the watchdog,
  // exactly the state a hung renderer would leave behind.
  function armWatchdog(): number {
    closeState.isCloseConfirmed.mockReturnValue(false);
    appHandlers['before-quit']!(quitEvent);
    return app.quit.mock.calls.length;
  }

  it('quits after the watchdog window when the renderer stays silent', async () => {
    await importPrimaryInstance();
    vi.useFakeTimers();

    const quitBase = armWatchdog();
    vi.advanceTimersByTime(WATCHDOG_MS);

    expect(quitEvent.preventDefault).toHaveBeenCalled();
    expect(app.quit.mock.calls.length - quitBase).toBe(1);
  });

  it('disarms the watchdog on app:closeCancelled, and re-arms on the next quit', async () => {
    await importPrimaryInstance();
    vi.useFakeTimers();

    const quitBase = armWatchdog();
    ipcHandlers['app:closeCancelled']!();
    vi.advanceTimersByTime(WATCHDOG_MS);
    expect(app.quit.mock.calls.length - quitBase).toBe(0);
    // Cancelling must not confirm: the flag stays false so the window close
    // still asks next time (and the next arm above is a real arm).
    expect(closeState.setCloseConfirmed).not.toHaveBeenCalled();

    const rearmBase = armWatchdog();
    vi.advanceTimersByTime(WATCHDOG_MS);
    expect(app.quit.mock.calls.length - rearmBase).toBe(1);
  });
});
