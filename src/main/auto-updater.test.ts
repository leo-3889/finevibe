import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    on: vi.fn(),
  },
}));

const mockSend = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
}));

import { autoUpdater } from 'electron-updater';
import { initAutoUpdater, checkForUpdates, quitAndInstall, FORK_RELEASE_REPO } from './auto-updater';

// electron-builder bakes the publish config into resources/app-update.yml
// (PublishManager.onAfterPack -> serializeToYaml) and electron-updater reads
// that file when no feed URL is set. Row 64: that baked feed is the packaged
// default, so the tests drive it through a real temp resources dir.
const BAKED_FEED = [
  'provider: github',
  `owner: ${FORK_RELEASE_REPO.split('/')[0]}`,
  `repo: ${FORK_RELEASE_REPO.split('/')[1]}`,
  'releaseType: release',
  'updaterCacheDirName: finevibe-updater',
].join('\n');

const tempDirs: string[] = [];

function useResourcesDir(files: Record<string, string> = { 'app-update.yml': BAKED_FEED }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-resources-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  // NodeJS.Process declares resourcesPath read-only; under vitest (plain
  // node, not electron) it is undefined, so an own property is the honest
  // stand-in for the packaged resources dir the module reads.
  Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true });
}

describe('auto-updater', () => {
  beforeEach(() => {
    // The packaged default is the baked fork feed; the happy-path tests keep
    // an env override set (the FINEVIBE_RELEASE_REPO path) so their
    // setFeedURL assertions stay meaningful.
    process.env.FINEVIBE_RELEASE_REPO = 'leo-3889/vibeyard';
    useResourcesDir();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    delete (process as { resourcesPath?: string }).resourcesPath;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('registers event listeners and configures autoUpdater', () => {
    initAutoUpdater();
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function));
    expect(autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('schedules check after 10s delay', () => {
    initAutoUpdater();
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('disposer clears the startup delay and the 4 h interval (C4S-06)', () => {
    const dispose = initAutoUpdater();
    dispose();
    vi.advanceTimersByTime(10_000 + 4 * 60 * 60 * 1000);
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('checkForUpdates delegates to autoUpdater once init enabled the updater', () => {
    initAutoUpdater();
    expect(checkForUpdates()).toEqual({ checked: true });
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  // Rows 57/64/65 (manual bypass): the About section renders its "Check for
  // updates" button unconditionally, so a click on a gated install used to hit
  // autoUpdater directly — one update:error per click on a deb (the linux feed
  // ships the AppImage only) and an NSIS download over the portable layout.
  it('manual check reports the deb gate and never calls autoUpdater', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    useResourcesDir({ 'app-update.yml': BAKED_FEED, 'package-type': 'deb' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(checkForUpdates()).toEqual({ disabled: expect.stringContaining('deb install') });
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('manual check reports the portable gate and never calls autoUpdater', () => {
    process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\apps';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(checkForUpdates()).toEqual({ disabled: expect.stringContaining('portable') });
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      delete process.env.PORTABLE_EXECUTABLE_DIR;
    }
  });

  it('manual check reports a disabled feed decision instead of checking', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    useResourcesDir({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(checkForUpdates()).toEqual({ disabled: expect.stringContaining('<unreadable>') });
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('quitAndInstall delegates to autoUpdater', () => {
    quitAndInstall();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it('forwards update-available event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'update-available')![1] as (info: { version: string }) => void;
    handler({ version: '1.2.3' });
    expect(mockSend).toHaveBeenCalledWith('update:available', { version: '1.2.3' });
  });

  it('forwards download-progress event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'download-progress')![1] as (progress: { percent: number }) => void;
    handler({ percent: 55.7 });
    expect(mockSend).toHaveBeenCalledWith('update:download-progress', { percent: 56 });
  });

  it('forwards update-downloaded event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'update-downloaded')![1] as (info: { version: string }) => void;
    handler({ version: '2.0.0' });
    expect(mockSend).toHaveBeenCalledWith('update:downloaded', { version: '2.0.0' });
  });

  it('forwards error event to renderer', () => {
    initAutoUpdater();
    const handler = vi.mocked(autoUpdater.on).mock.calls.find((c) => c[0] === 'error')![1] as (err: Error) => void;
    handler(new Error('update failed'));
    expect(mockSend).toHaveBeenCalledWith('update:error', { message: 'update failed' });
  });

  it('points the feed at FINEVIBE_RELEASE_REPO when set to owner/repo', () => {
    process.env.FINEVIBE_RELEASE_REPO = 'leo-3889/vibeyard';
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'github',
        owner: 'leo-3889',
        repo: 'vibeyard',
        releaseType: 'release',
      });
      // The override wins over the baked feed (which names finevibe, not
      // vibeyard) instead of being merged with it.
      expect(autoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.FINEVIBE_RELEASE_REPO;
    }
  });

  // Row 64: a packaged build launched from Finder/Dock has no environment to
  // lean on at all, so with the env unset the updater must run against the baked
  // fork feed — and must NOT call setFeedURL, which would replace the file
  // electron-updater loads itself.
  it('runs the updater against the baked app-update.yml feed when FINEVIBE_RELEASE_REPO is unset', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.autoDownload).toBe(true);
      expect(autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function));
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Fail closed, never a silent fallback: resources/app-update.yml naming a
  // repo other than the fork means these bytes are not this fork's releases.
  it('disables auto-update when the baked feed names a repo other than the fork', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    useResourcesDir({ 'app-update.yml': BAKED_FEED.replace('repo: finevibe', 'repo: vibeyard') });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000 + 4 * 60 * 60 * 1000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('leo-3889/vibeyard'));
    } finally {
      warn.mockRestore();
    }
  });

  it('disables auto-update when resources/app-update.yml cannot be read', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    useResourcesDir({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('<unreadable>'));
    } finally {
      warn.mockRestore();
    }
  });

  // The fork constant duplicates build.publish (package.json has no comments
  // and npm requires strict JSON), so the duplication is pinned here.
  it('keeps FORK_RELEASE_REPO equal to build.publish in package.json', () => {
    const build = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).build;
    expect(`${build.publish.owner}/${build.publish.repo}`).toBe(FORK_RELEASE_REPO);
    expect(build.publish.provider).toBe('github');
  });

  // P2-77 retarget, row 64 refinement: a malformed override is not silently
  // replaced by the baked feed — the operator named a feed, and a typo must
  // not decide which bytes get installed.
  it('disables auto-update for a malformed FINEVIBE_RELEASE_REPO override even with a valid baked feed', () => {
    process.env.FINEVIBE_RELEASE_REPO = 'not-a-slug';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-slug'));
    } finally {
      warn.mockRestore();
    }
  });

  // Portable win target: electron-updater does not support it — an update
  // would download the NSIS setup and clobber the portable layout. The
  // portable bootstrap sets PORTABLE_EXECUTABLE_DIR, so its presence must
  // skip updater init entirely (portable updates via the npm launcher).
  it('skips updater init for portable builds (PORTABLE_EXECUTABLE_DIR set)', () => {
    process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\apps';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('portable'));
    } finally {
      log.mockRestore();
      delete process.env.PORTABLE_EXECUTABLE_DIR;
    }
  });

  // Row 57/65 posture: the linux feed ships ONE installer (the AppImage), so
  // a deb install has no feed entry — DebUpdater would find no .deb and error
  // on every 4 h check. Deb installs update through apt.
  it('skips updater init for a deb install (resources/package-type is "deb")', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    useResourcesDir({ 'app-update.yml': BAKED_FEED, 'package-type': 'deb' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('deb install'));
    } finally {
      log.mockRestore();
    }
  });

  it('skips initialization in dev mode', async () => {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: { getAllWindows: () => [] },
    }));
    vi.doMock('electron-updater', () => ({
      autoUpdater: {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
        on: vi.fn(),
      },
    }));
    const mod = await import('./auto-updater');
    const { autoUpdater: freshUpdater } = await import('electron-updater');
    mod.initAutoUpdater();
    expect(freshUpdater.on).not.toHaveBeenCalled();
  });
});
