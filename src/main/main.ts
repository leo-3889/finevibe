import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerIpcHandlers, resetHookWatcher, sweepEnumerationCaches, removeIsoPartitionDirs } from './ipc-handlers';
import { sweepImportTempDirs } from './chrome-import/copy';
import { killAllPtys, getFullPathAsync } from './pty-manager';
import { flushState, loadState } from './store';
import { createAppMenu } from './menu';
import { restartAndResync } from './hook-status';
import { initProviders, getAllProviders } from './providers/registry';
import { initAutoUpdater } from './auto-updater';
import { stopGitWatcher } from './git-watcher';
import { stopConfigWatcher } from './config-watcher';
import { stopAllFileWatchers } from './file-watcher';
import { disconnectAll } from './mcp-client';
import { checkPythonAvailable } from './prerequisites';
import { configureProbeCacheDir } from './providers/resolve-binary';
import { isMac, isWin } from './platform';
import { APP_INDEX_URL, installAppScheme, isAppDocumentUrl, registerAppScheme } from './app-scheme';
import { isCloseConfirmed, setCloseConfirmed } from './close-state';
import { pinWebviewGuest } from './webview-guest-pin';
import { isHttpUrl } from '../shared/url';
import { migrateLegacyUserData, retireLegacyUserData } from './userdata-migration';
import { startSessionRetentionSweeps } from './launch-session-dir';

import { installConsoleThrottle } from './log-throttle';
import { installLogFile } from './log-file';
import { startDiskHealthPreflight } from './disk-health';
import { finishBoot, finishBootPhase, markBoot, reportRendererBoot, startPerfSampler, stopPerfSampler } from './boot-timing';
import { getMainWindow } from './main-window';

// 2026-10-23 ENOSPC incident: the state writer logged a full stack on every
// renderer save against a full disk — 160 409 journal lines in 30 min,
// rsyslog-mirrored into /var/log/syslog, and the log growth consumed the very
// space it complained about (a self-amplifying loop). The per-write source is
// fixed in store.ts; this is the app-wide net: any main-process logger that
// loops collapses to one line plus a "repeated n times" tally, so no future
// storm floods journald/syslog. Guarded on VITEST so per-test console spies
// stay pristine (the mocked-boot suites import this module).
if (!process.env.VITEST) installConsoleThrottle();
let mainWindow: BrowserWindow | null = null;
let stopDiskHealthPreflight: (() => void) | null = null;

// The UI boots ONLY for the single-instance lock winner:
// startMainProcess() (below createWindow) owns the second-instance,
// whenReady, before-quit and window-all-closed registrations, and the
// requestSingleInstanceLock gate at the END of this module calls it for
// the winner alone. The loser quits without constructing anything.

// C4S-07: close-confirmation watchdog. before-quit preventDefaults until the
// renderer answers 'app:confirmClose'; a hung renderer would keep the quit
// prevented forever. After 15 s of silence the main process takes the same
// path as the renderer's 'app:closeConfirmed' reply.
const CLOSE_CONFIRM_WATCHDOG_MS = 15_000;
let closeConfirmTimer: NodeJS.Timeout | null = null;

function clearCloseConfirmWatchdog(): void {
  if (closeConfirmTimer) {
    clearTimeout(closeConfirmTimer);
    closeConfirmTimer = null;
  }
}

function requestConfirmClose(): void {
  const win = getMainWindow();
  if (win) {
    win.webContents.send('app:confirmClose');
    clearCloseConfirmWatchdog();
    closeConfirmTimer = setTimeout(() => {
      closeConfirmTimer = null;
      if (isCloseConfirmed()) return; // guarded once — a real reply won
      setCloseConfirmed(true);
      app.quit();
    }, CLOSE_CONFIRM_WATCHDOG_MS);
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
// The renderer entry the main window loads. Module scope: the not-built
// boot guard (rendererIsBuilt) and createWindow must agree on ONE path.
const RENDERER_INDEX_PATH = path.join(__dirname, '..', '..', 'renderer', 'index.html');


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

// Privileged `app://` registration must precede the `ready` event (Electron
// requirement), so it runs at module scope, not in whenReady. The handler that
// serves dist/renderer is installed in whenReady below.
registerAppScheme();

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

  // Served over app:// (see app-scheme.ts): the bundle is ES modules with
  // chunks, which Chromium will not execute from a file:// document.
  const loadRenderer = (): void => { mainWindow?.loadURL(APP_INDEX_URL); };
  loadRenderer();

  // C4S-08: a renderer-process death (crash, OOM, GPU-loss kill) used to
  // leave a dead frame until the user restarted. Reload the same entry on
  // any non-clean exit.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) loadRenderer();
  });

  // Open external links in default browser instead of inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // openExternal rejects on a headless / no-default-browser Linux session;
    // this handler has no caller to catch it, so warn here.
    if (isHttpUrl(url)) shell.openExternal(url).catch((err: unknown) => console.warn(`[window-open] could not open ${url}`, err));
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
  // against this app:// document and would otherwise navigate the window away
  // from index.html, destroying every session, PTY and layout binding with it.
  // The predicate lives in app-scheme.ts (unit-tested) and matches the exact
  // scheme + host + /index.html we load, so no other app:// path can pass.
  const isAppUrl = (url: string): boolean => isAppDocumentUrl(url);

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url).catch((err: unknown) => console.warn(`[will-navigate] could not open ${url}`, err));
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
// Boot guard for an unbuilt tree (dist/ missing after a fresh clone,
// `npm run clean`, or a failed build). The silent failure this replaces:
// `electron .` loaded the nonexistent dist/renderer/index.html, the window
// died with the app, and no message ever surfaced — users then launched
// bare `electron` and landed on the stock Electron welcome window. Fail
// loudly BEFORE the first window: name the exact missing artifact and the
// fix, then quit. VITEST-gated like installConsoleThrottle (line 38): the
// mocked-boot suites (main-single-instance, main-app-user-model-id) boot
// main.ts from the SOURCE tree, where this dist-relative path never exists
// — ungated, the guard would abort every mocked boot. The guard's own
// suite (main-not-built.test.ts) unsets VITEST around its import to
// exercise the real path.
function rendererIsBuilt(): boolean {
  if (process.env.VITEST) return true;
  if (fs.existsSync(RENDERER_INDEX_PATH)) return true;
  const projectDir = path.resolve(__dirname, '..', '..', '..');
  dialog.showErrorBox(
    'FineVibe is not built',
    `FineVibe cannot start: its build output is missing.\n\n` +
      `Missing: ${RENDERER_INDEX_PATH}\n\n` +
      `Run "npm run build" in ${projectDir}, then start FineVibe again.`,
  );
  app.quit();
  return false;
}


function startMainProcess(): void {
  // C4S-06: updater disposer (startup timeout + 4 h interval); quit runs it.
  let disposeAutoUpdater: (() => void) | null = null;
  // First: the identity must be stamped on the process before the first
  // window (taskbar button) exists. See claimWindowsIdentity above.
  claimWindowsIdentity();

  // Release gate (AUDIT_STATUS "Rename on the CURRENT tree"): the
  // vibeyard -> finevibe cutover (4fc533c) renamed BOTH user-data trees -
  // the store tree (`~/.vibeyard` -> `~/.finevibe`, store.ts) and Electron
  // userData (`%APPDATA%/Vibeyard|vibeyard` -> the finevibe dir). Without a
  // migration an install updating across the cutover boots into empty dirs
  // and loses projects, history, cookies and caches. Copy-only (the legacy
  // trees are never deleted), destination wins on conflicts, stale
  // `vibeyard-browser-iso-*` partitions are purged, not copied, per-file
  // failures (a legacy instance holding a lock) are logged and retried at
  // the next launch. Winner-only, ahead of anything that reads userData.
  try {
    const { home, appData } = migrateLegacyUserData({
      homedir: app.getPath('home'),
      appDataDir: app.getPath('appData'),
      userDataDir: app.getPath('userData'),
    });
    const touched = home.copied + appData.copied + home.errors.length + appData.errors.length;
    if (touched > 0) {
      console.log(
        `[userdata-migration] home ${home.copied} copied / ${home.skipped} kept` +
          (home.errors.length ? ` / ${home.errors.length} FAILED` : '') +
          `; userData ${appData.copied} copied / ${appData.skipped} kept / ${appData.purged} stale partitions purged` +
          (appData.errors.length ? ` / ${appData.errors.length} FAILED` : ''),
      );
    }
  } catch (error) {
    console.error('[userdata-migration] failed; legacy data left untouched', error);
  }

  // A3: ledger-driven retirement of the legacy userData tree the migration
  // copied. Gated by the ledger: 30-day grace, destination integrity check,
  // opt-out file, appData-only (the home tree `~/.vibeyard`, still read by
  // the project importer, is never touched). Runs AFTER the migration, so a
  // fresh cutover launch is never a retirement candidate. Never throws.
  try {
    retireLegacyUserData({
      userDataDir: app.getPath('userData'),
      appDataDir: app.getPath('appData'),
    });
  } catch (error) {
    console.error('[userdata-retirement] failed; legacy data left untouched', error);
  }
  markBoot('identity+migrate');

  // Winner-only: a relaunch while the app runs focuses the existing
  // window, so launching again behaves like "focus FineVibe".
  app.on('second-instance', () => {
    const win = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : getMainWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // Tee the (already throttled) console into <logs>/finevibe.log FIRST, so
    // every boot sweep and every later failure is on disk — packaged apps
    // have no console the user can read (owner request 2026-10-26). VITEST
    // gate mirrors the throttle above: test console spies stay pristine.
    if (!process.env.VITEST) installLogFile(app.getPath('logs'));
    markBoot('ready');
    // Serve the built renderer over app:// (registered at module scope). Must
    // run before the first window loads; the root is the directory index.html
    // lives in, so a moved build tree moves the served root with it.
    installAppScheme(path.dirname(RENDERER_INDEX_PATH));
    // P2-47 pin (boot call site; the after-import sweep lives in
    // ipc-handlers.ts chromeImport:run): quit/crash mid-import used to
    // leave the Chrome cookie snapshot in the OS temp dir for the
    // machine's life. Sweep stale finevibe-chrome-import-* dirs at boot,
    // mirroring the finevibe-screenshots prune's 24h bound — an in-flight
    // fresh dir is never touched. Never throws; tmpdir-sized, negligible
    // on the boot path.
    sweepImportTempDirs();
    // A5: isolated browser partitions are per-session ephemera — every
    // `session:release` removes its own jar (ipc-handlers.ts), but a quit
    // or crash between close and release leaves `finevibe-browser-iso-*`
    // dirs under userData/Partitions for the machine's life. Sweep all of
    // them at boot; no live session exists this early, so every
    // re-validating iso dir is by definition orphaned. Never throws.
    removeIsoPartitionDirs(app.getPath('userData'));
    // A4: Pi/OMP session-dir retention used to be armed ONLY by the first
    // Pi/OMP launch — an install that never launches one grew the two base
    // dirs forever. Sweep both bases at boot (setImmediate, off the boot
    // path), re-arm every 24 h with the 2 GiB per-base quota, and run the
    // enumeration-cache TTL sweep on every daily tick.
    startSessionRetentionSweeps(sweepEnumerationCaches);
    initProviders();
    markBoot('sweeps');

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
    // C2M-09 (SEC-02 class): main.ts registers no safeOn — the wrapper lives
    // in ipc-handlers.ts — so the P2-108 rule applies inline: an `ipcMain.on`
    // body that throws is a fatal main-process exception that kills every
    // live PTY and window. A partition whose storage is locked (Windows
    // EBUSY) must degrade to a logged warning.
    ipcMain.on('browser:clearIsolatedStorage', (_event, sessionId: unknown) => {
      try {
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return;
        const partDir = path.join(app.getPath('userData'), 'Partitions', `finevibe-browser-iso-${sessionId}`);
        // Existence guard: releasing/clearing a session that never browsed in
        // isolation must not materialise a partition via fromPartition().
        if (!fs.existsSync(partDir)) return;
        session.fromPartition(`persist:finevibe-browser-iso-${sessionId}`)
          .clearStorageData()
          .catch((err) => console.warn('clearStorageData failed:', err));
      } catch (err) {
        console.warn('browser:clearIsolatedStorage failed:', err);
      }
    });
    registerIpcHandlers();
    const state = loadState();
    createAppMenu(state.preferences?.debugMode ?? false);
    markBoot('ipc');
    // Boot guard (rendererIsBuilt): an unbuilt tree fails with the
    // not-built dialog, never a silent window death. Quit BEFORE the first
    // window — the close-confirm watchdog, the disk-health preflight and
    // the provider probes below all assume a live renderer.
    if (!rendererIsBuilt()) return;
    createWindow();
    // 2026-10-23: proactive disk-health preflight. Warn ONCE, before writes
    // start failing, when the userData volume runs low — one banner instead of
    // a per-write ENOSPC stack storm. Emits on state transitions only (see
    // disk-health.ts), so a full disk is a single warning, not a flood.
    stopDiskHealthPreflight = startDiskHealthPreflight({
      getUserDataPath: () => app.getPath('userData'),
      onStatus: (status) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('disk-health:status', status);
      },
    });
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
    disposeAutoUpdater = initAutoUpdater();
    // Audit P1: first-paint is the boot number a user feels; everything after
    // it reports as a post-window phase. The sampler pushes RSS/heap/handle
    // counts to the renderer debug ring (Ctrl+Shift+D) every minute.
    markBoot('window');
    finishBoot('window-shown');
    startPerfSampler(() => mainWindow);
    // The renderer echoes its own parse+paint time on this channel; the
    // summary lands in the same log stream, so one launch reads top-to-bottom.
    ipcMain.on('perf:reportBoot', (_event, ms: unknown) => reportRendererBoot(ms));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        const win = getMainWindow();
        if (win) {
          restartAndResync(win);
        }
      }
    });

    powerMonitor.on('resume', () => {
      const win = getMainWindow();
      if (win) {
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
    // C2M-02: PA-01 moved the probes off the sync path, but the first PTY
    // SPAWN still paid getFullPath() synchronously — POSIX:
    // `execSync($SHELL -ilc …)`, 0.2-1.5 s on nvm/p10k setups; Windows: two
    // `reg query` execSyncs — blocking main for the duration of every
    // window's paint and every other PTY's traffic. Warm the cache the spawn
    // reads, in parallel with the probes. The probes reach the same cache
    // through resolve-binary's freshness gate; this prewarm does not depend
    // on provider coverage. getFullPathAsync never rejects (every probe
    // failure composes a fallback PATH), so it cannot fail the boot chain.
    const [availability] = await Promise.all([
      Promise.all(providers.map(p => (
        p.validatePrerequisitesAsync
          ? p.validatePrerequisitesAsync()
          : Promise.resolve(p.validatePrerequisites())
      ))),
      getFullPathAsync(),
    ]);
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
    markBoot('python');
    finishBootPhase('post-window');
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

  // C4S-07: a confirmed reply from the renderer disarms the watchdog.
  ipcMain.on('app:closeConfirmed', clearCloseConfirmWatchdog);

  app.on('before-quit', (event) => {
    clearCloseConfirmWatchdog();
    if (!isCloseConfirmed()) {
      event.preventDefault();
      requestConfirmClose();
      return;
    }
    disposeAutoUpdater?.();
    flushState();
    stopPerfSampler();
    stopDiskHealthPreflight?.();
    stopDiskHealthPreflight = null;
    const win = getMainWindow();
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
