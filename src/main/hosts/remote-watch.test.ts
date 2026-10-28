// Remote watcher (MH-1 Phase 4): the sftp poll diff. The ssh seam and the
// host registry are stubbed; the electron window is faked via the
// setRemoteWatchWindow contract. Timers are faked so a poll is one tick.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { FsChange } from '../../shared/types';

const sftp = vi.hoisted(() => ({
  entries: vi.fn<(record: unknown, dir: string, opts?: unknown) => Promise<Array<{ name: string; isDirectory: boolean; mtimeMs: number }> | null>>(),
}));
vi.mock('./ssh-client', () => ({
  sftpListDirEntries: (record: unknown, dir: string, opts?: unknown) => sftp.entries(record, dir, opts),
  exec: vi.fn(),
}));
vi.mock('./host-registry', () => ({
  getHost: (id: string) => (id === 'lab' ? ({ id, name: 'l', host: 'l.example' }) : undefined),
}));

import { remoteWatchKeys, setRemoteWatchWindow, unwatchRemoteDir, watchRemoteDir } from './remote-watch';

const sent: FsChange[][] = [];
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (_ch: string, changes: FsChange[]) => sent.push(changes) },
} as unknown as BrowserWindow;

const file = (name: string, mtimeMs = 1000) => ({ name, isDirectory: false, mtimeMs });
const dir = (name: string, mtimeMs = 500) => ({ name, isDirectory: true, mtimeMs });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setRemoteWatchWindow(fakeWin);
});

afterEach(() => {
  for (const key of remoteWatchKeys()) {
    const [hostId, path] = key.split('|');
    unwatchRemoteDir(hostId, path);
  }
  vi.useRealTimers();
});

describe('watchRemoteDir', () => {
  it('rejects the local host id and unsafe paths without creating a watch', () => {
    watchRemoteDir('local', '/x');
    watchRemoteDir('lab', 'C:\\windows\\path');
    expect(remoteWatchKeys()).toEqual([]);
  });

  it('seeds the snapshot at watch time and emits nothing until entries change', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);
    expect(sftp.entries).toHaveBeenCalledWith({ id: 'lab', name: 'l', host: 'l.example' }, '/srv/app', { timeoutMs: 5000 });
    expect(sent).toEqual([]);
  });

  it('emits addDir/add and unlink(/unlinkDir) deltas, then a quiet tick', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);

    sftp.entries.mockResolvedValue([file('a.ts'), dir('docs'), file('b.ts', 7)]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent[0]).toEqual([
      { path: '/srv/app/docs', dir: '/srv/app', type: 'addDir' },
      { path: '/srv/app/b.ts', dir: '/srv/app', type: 'add' },
    ]);

    sftp.entries.mockResolvedValue([file('a.ts', 999), dir('docs')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent[1]).toEqual([
      { path: '/srv/app/a.ts', dir: '/srv/app', type: 'change' },
      { path: '/srv/app/b.ts', dir: '/srv/app', type: 'unlink' },
    ]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(2); // unchanged listing → no event
  });

  it('a failed poll keeps the last snapshot and warns once', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sftp.entries.mockRejectedValue(new Error('connection closed'));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('an unknown host stops polling without throwing', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('ghost', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);
    expect(sftp.entries).not.toHaveBeenCalled();
  });
});

describe('unwatchRemoteDir', () => {
  it('stops the interval and is idempotent', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);
    const calls = sftp.entries.mock.calls.length;
    unwatchRemoteDir('lab', '/srv/app');
    unwatchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sftp.entries).toHaveBeenCalledTimes(calls);
  });
});
