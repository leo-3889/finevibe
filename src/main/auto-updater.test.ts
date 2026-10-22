import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { initAutoUpdater, checkForUpdates, quitAndInstall } from './auto-updater';

describe('auto-updater', () => {
  beforeEach(() => {
    // P1-7 fork identity: the feed is the fork repo named by
    // FINEVIBE_RELEASE_REPO, so the happy-path tests run with a valid one.
    process.env.FINEVIBE_RELEASE_REPO = 'leo-3889/vibeyard';
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.FINEVIBE_RELEASE_REPO;
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

  it('checkForUpdates delegates to autoUpdater', () => {
    checkForUpdates();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled();
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
    } finally {
      delete process.env.FINEVIBE_RELEASE_REPO;
    }
  });

  // P2-77 retarget. These two previously pinned the upstream feed as the
  // intended behavior of an unset/malformed FINEVIBE_RELEASE_REPO. P1-7
  // (audit plan §1(iv), FORK identity): a packaged fork build must NEVER
  // self-update from the upstream repo. No valid fork feed = auto-update
  // disabled with a warning, not a silent fallback to upstream releases.
  it('disables auto-update when FINEVIBE_RELEASE_REPO is unset', () => {
    delete process.env.FINEVIBE_RELEASE_REPO;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      initAutoUpdater();
      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
      expect(autoUpdater.on).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10_000);
      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('FINEVIBE_RELEASE_REPO'));
    } finally {
      warn.mockRestore();
    }
  });

  it('disables auto-update for a malformed FINEVIBE_RELEASE_REPO', () => {
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
