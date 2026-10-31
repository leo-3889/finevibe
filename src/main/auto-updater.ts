import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setCloseConfirmed } from './close-state';
import { getMainWindow } from './main-window';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 10_000; // 10 seconds

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = getMainWindow();
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

// P1-7 (audit plan §1(iv), FORK identity) + row 64: a packaged fork build must
// NEVER self-update from the upstream repo, and it must self-update with
// ZERO user env. The packaged default is the feed electron-builder bakes into
// `resources/app-update.yml` (built from `build.publish`), which is exactly the
// file electron-updater loads when no feed URL is set
// (AppUpdater.loadUpdateConfig -> app.appUpdateConfigPath), so the packaged
// path simply never calls setFeedURL. FINEVIBE_RELEASE_REPO only OVERRIDES it:
// requiring that env var (the old behaviour) left every packaged build without
// an updater, and on mac the launcher spawns through `open --args`
// (bin/finevibe.js), which drops the caller's environment entirely.
// The npm launcher has no baked feed and still requires the env var.
const RELEASE_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// The fork constant: keep equal to `build.publish` (owner/repo) in
// package.json — auto-updater.test.ts pins it, so the two cannot drift. A
// baked feed naming any OTHER repo (an upstream build's resources dir, a
// hand-edited app-update.yml) never feeds a fork install: fail closed instead
// of pulling foreign release bytes.
export const FORK_RELEASE_REPO = 'leo-3889/finevibe';

function parseReleaseRepo(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return RELEASE_REPO_PATTERN.test(trimmed) ? trimmed : null;
}

// A file electron-builder writes next to the app in packaged resources:
// PublishManager writes `app-update.yml`, FpmTarget (deb/rpm/pacman) writes
// `package-type`. Missing/unreadable returns null — the callers treat that as
// "cannot be trusted".
function readPackagedResource(name: string): string | null {
  try {
    return readFileSync(join(process.resourcesPath ?? '', name), 'utf8');
  } catch {
    return null;
  }
}

// app-update.yml is electron-builder's own flat serialization of the publish
// config (builder-util serializeToYaml): `owner:`/`repo:` are top-level
// scalars, so this stays a regex read instead of pulling a yaml parser into
// src/main for a file we do not control the shape of.
function readBakedFeedRepo(): string | null {
  const text = readPackagedResource('app-update.yml');
  if (text == null) return null;
  const owner = /^owner:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  const repo = /^repo:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  return owner && repo ? `${owner}/${repo}` : null;
}

export function initAutoUpdater(): () => void {
  if (!app.isPackaged) return () => {};

  // The published portable .exe (electron-builder `portable` target) is NOT
  // supported by electron-updater: an update would download the NSIS setup
  // and install it, clobbering the portable layout. PORTABLE_EXECUTABLE_DIR
  // is set by the portable bootstrap, so its presence identifies this run;
  // portable installs update via the launcher/npm package path instead.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    console.log(
      '[auto-updater] portable build (PORTABLE_EXECUTABLE_DIR is set) — skipping ' +
      'auto-update; electron-updater cannot update a portable install. Update ' +
      'through the npm launcher (npx finevibe) instead.',
    );
    return () => {};
  }
 
  // Row 57/65 posture: the linux channel file is ONE installer
  // (Provider.getChannelFilePrefix -> `latest-linux.yml`) and it describes the
  // AppImage — the artifact the npm launcher installs (row 65: `deb.publish`
  // is null so the deb leg no longer overwrites that file). electron-updater
  // picks DebUpdater from `resources/package-type` (electron-updater/out/
  // main.js), and DebUpdater's findFile(files, "deb", ["AppImage", …]) then
  // finds no .deb entry and errors on every check. Deb installs update
  // through apt (docs/packaging.md, "Update policy").
  if (readPackagedResource('package-type')?.trim() === 'deb') {
    console.log(
      '[auto-updater] deb install (resources/package-type is "deb") — skipping ' +
      'auto-update; the linux release feed ships the AppImage only. Update with ' +
      '`sudo apt install ./FineVibe-<version>-linux-amd64.deb` instead.',
    );
    return () => {};
  }

  const overrideRepo = parseReleaseRepo(process.env.FINEVIBE_RELEASE_REPO);
  if (!overrideRepo && process.env.FINEVIBE_RELEASE_REPO?.trim()) {
    console.warn(
      `[auto-updater] FINEVIBE_RELEASE_REPO=${process.env.FINEVIBE_RELEASE_REPO} ` +
      'is not a valid "owner/repo" — auto-update disabled (a malformed override is ' +
      'never ignored in favour of the baked feed).',
    );
    return () => {};
  }

  if (overrideRepo) {
    const [owner, repo] = overrideRepo.split('/');
    autoUpdater.setFeedURL({ provider: 'github', owner, repo, releaseType: 'release' });
  } else {
    const bakedRepo = readBakedFeedRepo();
    if (bakedRepo !== FORK_RELEASE_REPO) {
      console.warn(
        `[auto-updater] resources/app-update.yml feed is ${bakedRepo ?? '<unreadable>'}, ` +
        `expected ${FORK_RELEASE_REPO} — auto-update disabled (a fork build never ` +
        'self-updates from a foreign release feed).',
      );
      return () => {};
    }
    // No setFeedURL call: electron-updater loads that same file itself.
  }

   autoUpdater.autoDownload = true;
   autoUpdater.autoInstallOnAppQuit = true;
 
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
