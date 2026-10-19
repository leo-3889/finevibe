import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { registerIpcHandlers, resetHookWatcher } from './ipc-handlers';
import { killAllPtys } from './pty-manager';
import { flushState, loadState } from './store';
import { createAppMenu } from './menu';
import { restartAndResync } from './hook-status';
import { initProviders, getAllProviders } from './providers/registry';
import { initAutoUpdater } from './auto-updater';
import { stopGitWatcher } from './git-watcher';
import { stopAllFileWatchers } from './file-watcher';
import { disconnectAll } from './mcp-client';
import { checkPythonAvailable } from './prerequisites';
import { isMac, isWin } from './platform';
import { isCloseConfirmed, setCloseConfirmed } from './close-state';
import { isHttpUrl } from '../shared/url';

let mainWindow: BrowserWindow | null = null;

// Single-instance gate. A second launch must not start a second main
// process: two mains would race for the same state.json, the same PTY
// sessions and the same STATUS_DIR status files. The loser quits
// immediately; the winner focuses its existing window when a relaunch
// happens, so launching again behaves like "focus Vibeyard". The gate
// sits at module scope — requestSingleInstanceLock() must run
// synchronously at startup, before app.whenReady resolves. (Gate is
// smoke-tested in main-single-instance.test.ts via mocked electron.)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

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
    title: 'Vibeyard',
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
  // nodeIntegration=true or an arbitrary preload file to escape into a
  // privileged process, so pin the guest shape before attachment: Node
  // integration off, context isolation and sandbox forced on, and a preload
  // kept ONLY when it is the shipped browser-tab-preload.js. URLs are
  // deliberately not validated here — loading arbitrary remote pages is the
  // browser-tab feature; this guard pins privileges, not destinations.
  // In Electron 41 `will-attach-webview` is an event on the HOST webContents
  // (absent from the App event set), and this window is the only webContents
  // with webviewTag enabled.
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
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  initProviders();

  const providers = getAllProviders();
  const missing = providers.filter(p => !p.validatePrerequisites());
  for (const p of missing) {
    console.warn(`Provider "${p.meta.displayName}" not available`);
  }
  if (missing.length === providers.length) {
    const bullets = providers.map(p => `  • ${p.meta.displayName}`).join('\n');
    dialog.showErrorBox(
      'Vibeyard — No CLI Provider Found',
      `Vibeyard needs at least one supported CLI provider installed to run.\n\n` +
        `Install one of the following, then restart Vibeyard:\n\n${bullets}`,
    );
    app.quit();
    return;
  }

  registerIpcHandlers();
  const state = loadState();
  createAppMenu(state.preferences?.debugMode ?? false);
  createWindow();

  // Warn if Python is missing on Windows (hooks depend on it)
  const pythonWarning = checkPythonAvailable();
  if (pythonWarning) {
    console.warn(pythonWarning);
    const owner = mainWindow;
    if (owner) {
      dialog.showMessageBox(owner, {
        type: 'warning',
        title: 'Vibeyard — Python Not Found',
        message: pythonWarning,
      });
    }
  }

  // Install hooks and status scripts for available providers (after window creation so dialogs can attach)
  for (const provider of getAllProviders()) {
    if (provider.validatePrerequisites()) {
      await provider.installHooks(mainWindow);
      provider.installStatusScripts();
    }
  }

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
