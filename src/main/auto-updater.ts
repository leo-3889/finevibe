import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { setCloseConfirmed } from './close-state';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 10_000; // 10 seconds

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch(() => {});
}

export function quitAndInstall(): void {
  // The default path runs app.quit() first; the close-confirmation handler
  // preventDefaults that, so the NSIS installer launches against the live
  // app and the process is force-killed externally, skipping flushState,
  // killAllPtys and watcher teardown. Confirm the close (runs the normal
  // teardown in the 'close' path) and let the installer kill the process.
  setCloseConfirmed(true);
  autoUpdater.quitAndInstall(true, true);
}

// P1-7 (audit plan §1(iv), FORK identity): a packaged fork build must NEVER
// self-update from the upstream repo. The release feed is exactly the fork
// repo named by FINEVIBE_RELEASE_REPO (the same override the npm launcher
// honours); unset or malformed disables auto-update with a warning instead
// of silently falling back to upstream releases.
const RELEASE_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function resolveReleaseRepo(): string | null {
  const value = process.env.FINEVIBE_RELEASE_REPO?.trim();
  if (!value) return null;
  return RELEASE_REPO_PATTERN.test(value) ? value : null;
}

export function initAutoUpdater(): () => void {
  if (!app.isPackaged) return () => {};
 
  const releaseRepo = resolveReleaseRepo();
  if (!releaseRepo) {
    console.warn(
      `[auto-updater] FINEVIBE_RELEASE_REPO=${process.env.FINEVIBE_RELEASE_REPO ?? '<unset>'} ` +
      'is not a valid "owner/repo" — auto-update disabled (a fork build never ' +
      'self-updates from the upstream release feed).',
    );
    return () => {};
  }

   autoUpdater.autoDownload = true;
   autoUpdater.autoInstallOnAppQuit = true;
 
  const [owner, repo] = releaseRepo.split('/');
  autoUpdater.setFeedURL({ provider: 'github', owner, repo, releaseType: 'release' });

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('update:available', { version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update:download-progress', { percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendToRenderer('update:error', { message: err?.message ?? 'Unknown error' });
  });

  // Check after startup delay, then periodically. C4S-06: the handles are
  // returned as a disposer so before-quit can stop the 4 h poll and the
  // 10 s startup check (a check firing mid-quit races the teardown).
  const startupTimer = setTimeout(checkForUpdates, STARTUP_DELAY_MS);
  const interval = setInterval(checkForUpdates, CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
