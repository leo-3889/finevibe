import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { registerIpcHandlers, resetHookWatcher } from './ipc-handlers';
import { sweepImportTempDirs } from './chrome-import/copy';
import { killAllPtys } from './pty-manager';
import { flushState, loadState } from './store';
import { createAppMenu } from './menu';
import { restartAndResync } from './hook-status';
import { initProviders, getAllProviders } from './providers/registry';
import { initAutoUpdater } from './auto-updater';
import { ensureAgentmemoryRunning } from './agentmemory-manager';
import { stopGitWatcher } from './git-watcher';
import { stopConfigWatcher } from './config-watcher';
import { stopAllFileWatchers } from './file-watcher';
import { disconnectAll } from './mcp-client';
import { checkPythonAvailable } from './prerequisites';
import { configureProbeCacheDir } from './providers/resolve-binary';
import { isMac, isWin } from './platform';
import { isCloseConfirmed, setCloseConfirmed } from './close-state';
import { pinWebviewGuest } from './webview-guest-pin';
import { isHttpUrl } from '../shared/url';

let mainWindow: BrowserWindow | null = null;

// The UI boots ONLY for the single-instance lock winner:
// startMainProcess() (below createWindow) owns the second-instance,
// whenReady, before-quit and window-all-closed registrations, and the
// requestSingleInstanceLock gate at the END of this module calls it for
// the winner alone. The loser quits without constructing anything.

function requestConfirmClose(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:confirmClose');
  } else {
    setCloseConfirmed(true);
    app.quit();
  }
}

// The only preload a <webview> guest may carry: the browser-tab inspect/draw
// bridge, whose path the renderer obtains from app:getBrowserPreloadPath
// (ipc-handlers) and sets as the webview's `preload` attribute. Its single
// import is Electron's sandbox-safe ipcRenderer, so it keeps working with
// nodeIntegration off and sandbox forced on.
const BROWSER_GUEST_PRELOAD = path.join(__dirname, '..', '..', 'preload', 'preload', 'browser-tab-preload.js');

// The app UI only ever needs clipboard reads (copy path) and its own desktop
// notifications; camera/mic/geolocation/MIDI are denied for the host renderer
// as well. Guest partitions get their own allowlist, pinned at attach time in
// webview-guest-pin.ts (guest pages are remote content by design).
const HOST_PERMISSIONS: Record<string, true> = {
  'clipboard-read': true,
  'clipboard-sanitized-write': true,
  notifications: true,
};
const isHostPermission = (permission: string): boolean => Object.hasOwn(HOST_PERMISSIONS, permission);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'FineVibe',
    icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
    // A visible Windows menu bar latches on the Alt half of Alt+Tab (the
    // alt-press flag is not reset on window blur), and the native menu bar then
    // consumes the next Escape as "deactivate menu bar" — it never reaches the
    // renderer, so xterm/PTY loses Escape while every other key flows through
    // (electron/electron#12167, #2504; same class as microsoft/vscode#35010).
    // Hide the bar; Alt still reveals it on demand (electron/electron#18518).
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // The preload exposes the API surface purely through contextBridge and
      // sandbox-safe electron modules (contextBridge/ipcRenderer/webFrame/
      // webUtils); node-pty lives in the main process and is reached over IPC.
      sandbox: true,
      webviewTag: true, // needed for browser-tab sessions
    },
  });

  const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  mainWindow.loadFile(indexPath);

  // Open external links in default browser instead of inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const appSession = mainWindow.webContents.session;
  appSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isHostPermission(permission)));
  appSession.setPermissionCheckHandler((_wc, permission) => isHostPermission(permission));

  // A <webview> guest's `webpreferences` and `preload` are renderer-controlled
  // (browser tabs). A compromised renderer could attach a guest with
  // nodeIntegration=true, webviewTag=true (letting the remote page nest a
  // <webview> into the same partition, un-pinned) or an arbitrary preload file
  // to escape into a privileged process, so pin the guest shape before
  // attachment: Node integration and webviewTag off, context isolation and
  // sandbox forced on, and a preload kept ONLY when it is the shipped
  // browser-tab-preload.js. URLs are deliberately not validated here — loading
  // arbitrary remote pages is the browser-tab feature; this guard pins
  // privileges, not destinations.
  // In Electron 41 `will-attach-webview` is an event on the HOST webContents
  // (absent from the App event set). It is listened to only on this window,
  // the only webContents with webviewTag enabled; guests get webviewTag
  // forced off by the pin, so a guest can never host an attach that bypasses
  // this handler.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    // The permission allowlist is resolved from the guest's `partition` string
    // inside pinWebviewGuest: `webPreferences.session` is a main-process
    // Session object and is never populated for a webview guest, so reading it
    // left the allowlist uninstalled (Electron auto-approves everything).
    pinWebviewGuest(webPreferences, BROWSER_GUEST_PRELOAD);
  });

  // The app document is the ONLY navigation target we ever allow. A stray anchor
  // in rendered content (e.g. a relative `.md` link in the file reader) resolves
  // against this file:// document and would otherwise navigate the window away
  // from index.html, destroying every session, PTY and layout binding with it.
  // Compared on the decoded pathname so percent-encoding differences between
  // Electron's own loadFile URL and pathToFileURL never cause a false block.
  const appPathname = decodeURIComponent(pathToFileURL(indexPath).pathname);
  const isAppUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname) === appPathname;
    } catch {
      return false;
    }
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (event) => {
    if (!isCloseConfirmed()) {
      event.preventDefault();
      requestConfirmClose();
      return;
    }
    flushState();
  });

  mainWindow.on('closed', () => {
    killAllPtys();
    resetHookWatcher();
    stopAllFileWatchers();
    // macOS close-and-reopen: the git/config watchers hold the window that
    // started them (currentWin), and a re-issued start for the SAME project
    // early-returns without re-pointing it — the reopened window would
    // never receive git:changed/config:changed again and the old watch
    // handles would leak for the app's life. Releasing them on 'closed'
    // makes the first start after the reopen re-point to the new window.
    stopGitWatcher();
    stopConfigWatcher();
    mainWindow = null;
  });
}

// Windows app identity. Without an explicit AppUserModelID the process
// registers as "Electron", so the taskbar group, Alt+Tab entry, Start-menu
// shortcut and toast notifications all attribute FineVibe to Electron. The
// id must match package.json "build".appId: the NSIS installer stamps that
// same AUMID on its shortcuts, so setting it unconditionally on win32 is
// consistent with the packaged install, and it also covers dev runs and the
// portable exe (which carry no installer metadata at all). Hoisted out of
// startMainProcess so the boot body stays linear; the win32 gate lives here.
function claimWindowsIdentity(): void {
  if (isWin) {
    app.setAppUserModelId('com.finevibe.app');
  }
}

function startMainProcess(): void {
  // First: the identity must be stamped on the process before the first
  // window (taskbar button) exists. See claimWindowsIdentity above.
  claimWindowsIdentity();

  // Winner-only: a relaunch while the app runs focuses the existing
  // window, so launching again behaves like "focus FineVibe".
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // P2-47 pin (boot call site; the after-import sweep lives in
    // ipc-handlers.ts chromeImport:run): quit/crash mid-import used to
    // leave the Chrome cookie snapshot in the OS temp dir for the
    // machine's life. Sweep stale finevibe-chrome-import-* dirs at boot,
    // mirroring the finevibe-screenshots prune's 24h bound — an in-flight
    // fresh dir is never touched. Never throws; tmpdir-sized, negligible
    // on the boot path.
    sweepImportTempDirs();
    initProviders();

    // PA-01: the all-missing guard used to run BEFORE the window existed —
    // six serial spawn-bound probes (up to 2.4 s of `which`/`npm prefix -g`
    // spawns, W2-06) in front of the first paint. IPC/menu/window first;
    // the probes run below, parallel, after the window is up. The window
    // briefly flashing on the all-providers-missing path is the accepted
    // trade for a first paint that never waits on a probe.

    // P2-100 companion (renderer: components/browser-tab/pane.ts isolation
    // toggle). The toggle rebuilds the pane on the SAME sessionId, so the
    // isolated partition name is identical before and after; the renderer
    // must clear that jar on every toggle and `clearStorageData` lives in
    // main. Restricted to the isolated-partition pattern with the same
    // format guard as `session:release` (ipc-handlers.ts) — the shared
    // default partition (every other browser tab, the imported Chrome jar)
    // is not clearable from the renderer.
    ipcMain.on('browser:clearIsolatedStorage', (_event, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
      const partDir = path.join(app.getPath('userData'), 'Partitions', `finevibe-browser-iso-${sessionId}`);
      // Existence guard: releasing/clearing a session that never browsed in
      // isolation must not materialise a partition via fromPartition().
      if (!fs.existsSync(partDir)) return;
      session.fromPartition(`persist:finevibe-browser-iso-${sessionId}`)
        .clearStorageData()
        .catch((err) => console.warn('clearStorageData failed:', err));
    });
    registerIpcHandlers();
    const state = loadState();
    createAppMenu(state.preferences?.debugMode ?? false);
    createWindow();
    // S1-01: the updater and the activate/resume handlers used to be
    // registered at the very END of this chain, behind the awaited provider
    // probe fan-out, the Python probe, the statusLine-consent modal (whose
    // promise resolves only on a renderer click) and the installHooks
    // fan-out (fs writes that can throw EACCES). A rejection there — or the
    // modal simply staying open — left the updater, the macOS dock
    // 'activate' re-create and the sleep-resume resync permanently
    // unregistered, and turned any installHooks throw into an unhandled
    // rejection (Electron: crash dialog). They gate on nothing: register
    // them the moment the window exists.
    initAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          restartAndResync(win);
        }
      }
    });

    powerMonitor.on('resume', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        restartAndResync(win);
      }
    });


    // PA-01: cross-launch probe cache (resolved path + availability +
    // binary mtime, mtime-invalidated per entry) lives in userData;
    // main.ts owns the userData wiring so resolve-binary stays
    // electron-free.
    configureProbeCacheDir(app.getPath('userData'));

    // PA-01: probes are spawn-bound (`which`, `npm prefix -g`) — fan every
    // provider's async probe out concurrently, off the main thread.
    // Providers without the async probe (tests, future registrations) fall
    // back to the sync one.
    const providers = getAllProviders();
    const availability = await Promise.all(providers.map(p => (
      p.validatePrerequisitesAsync
        ? p.validatePrerequisitesAsync()
        : Promise.resolve(p.validatePrerequisites())
    )));
    const missing = providers.filter((_, i) => !availability[i]);
    for (const p of missing) {
      console.warn(`Provider "${p.meta.displayName}" not available`);
    }
    if (missing.length === providers.length) {
      const bullets = providers.map(p => `  • ${p.meta.displayName}`).join('\n');
      dialog.showErrorBox(
        'FineVibe — No CLI Provider Found',
        `FineVibe needs at least one supported CLI provider installed to run.\n\n` +
          `Install one of the following, then restart FineVibe:\n\n${bullets}`,
      );
      // PA-01: with the window up first, a bare app.quit() would land on
      // the close-confirm gate (before-quit → app:confirmClose) and prompt
      // "Close FineVibe?" on top of the fatal dialog. This quit IS the
      // confirmed exit.
      setCloseConfirmed(true);
      app.quit();
      return;
    }

    // PA-16: async Python probe (was 2×execSync(timeout 3000) straight
    // after createWindow — up to 6 s of main-thread block on first paint).
    // Awaiting it here does not block the paint — the window is up. The
    // await exists because installHooks below bakes the live pythonBin
    // binding into the generated hook commands, so the binding must be
    // re-pointed (setPythonBin mutates it in place; nothing synchronous
    // gates on it) before the installs run.
    const pythonWarning = await checkPythonAvailable();
    if (pythonWarning) {
      console.warn(pythonWarning);
      const owner = mainWindow;
      if (owner && !owner.isDestroyed()) {
        dialog.showMessageBox(owner, {
          type: 'warning',
          title: 'FineVibe — Python Not Found',
          message: pythonWarning,
        });
      }
    }

    // PA-26: install hooks and status scripts for available providers
    // (after window creation so dialogs can attach). Each provider owns a
    // disjoint config dir (~/.claude, ~/.codex, ~/.gemini, …), so the
    // installs are independent. S1-01: fire-and-forget with a per-provider
    // catch — the await used to gate the updater/activate/resume
    // registrations (now done right after createWindow) on every provider's
    // IO AND on the statusLine-consent modal (resolved only by a renderer
    // click), and any throw (EACCES on ~/.claude, AV lock on Windows)
    // became an unhandled rejection. A failed install is a logged warning:
    // the provider still runs, hooks just stay uninstalled until the next
    // spawn/Fix Settings.
    for (const provider of providers.filter((_, i) => availability[i])) {
      void provider.installHooks(mainWindow)
        .then(() => provider.installStatusScripts())
        .catch((err: unknown) => console.warn(
          `Provider "${provider.meta.displayName}" hook install failed:`,
          (err as Error)?.message ?? err,
        ));
    }



    // Model A: opportunistically ensure the shared agentmemory engine is running
    // before any agent session spawns, so its first MCP connect hits a live
    // daemon. Fire-and-forget: a cold boot (engine self-install) must never block
    // startup. The daemon is shared by all agent CLIs, so it is intentionally NOT
    // stopped on quit (see before-quit) — that would sever memory outside FineVibe.
    if (loadState().preferences.agentmemoryAutoStart !== false) {
      void ensureAgentmemoryRunning().then(
        (s) => console.log(`[agentmemory] ${s.running ? `running${s.serviceVersion ? ` v${s.serviceVersion}` : ''}` : 'not running'}`),
        (err: unknown) => console.warn('[agentmemory] ensure failed:', (err as Error).message),
      );
    }

    })
    // S1-01: nothing below this point may crash the app: a rejected boot
  // chain (probe spawn failure, dialog API failure) used to surface as an
  // unhandled rejection — Electron shows a crash dialog and exits on
  // Node's throw-by-default policy. Log loudly; the window is already up.
  .catch((err: unknown) => {
    console.error('FineVibe startup failed after window creation:', err);
    dialog.showErrorBox(
      'FineVibe — Partial Startup Failure',
      `Some startup steps failed. FineVibe is running, but CLI hooks may not be installed:\n\n${(err as Error)?.message ?? String(err)}`,
    );
  });

  app.on('before-quit', (event) => {
    if (!isCloseConfirmed()) {
      event.preventDefault();
      requestConfirmClose();
      return;
    }
    flushState();
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('app:quitting');
    }
    killAllPtys();
    stopGitWatcher();
    stopAllFileWatchers();
    // Close any open MCP inspector connections (the pane-close path disconnects
    // its own session; this catches connections left open at quit).
    void disconnectAll();
    // Cleanup all providers
    for (const provider of getAllProviders()) {
      provider.cleanup();
    }
  });

  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit();
    }
  });
}

// Single-instance gate. A second launch must not start a second main
// process: two mains would race for the same state.json, the same PTY
// sessions and the same STATUS_DIR status files. The gate is the last
// statement of the module body and requestSingleInstanceLock() runs
// synchronously, so the loser quits immediately WITHOUT reaching
// startMainProcess(): no window, no IPC, no browser/webview stack, no
// lifecycle handlers. The winner runs the full boot. (Gate is smoke-tested
// in main-single-instance.test.ts via mocked electron.)
if (app.requestSingleInstanceLock()) {
  startMainProcess();
} else {
  app.quit();
}
