// Remote watcher (MH-1 Phase 4): the sftp poll diff. The ssh seam and the
// host registry are stubbed; the electron window is faked via the
// setRemoteWatchWindow contract. Timers are faked so a poll is one tick.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { FsChange } from '../../shared/types.js';

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

import {
  MAX_REMOTE_WATCHED_HOSTS,
  MAX_REMOTE_WATCHES,
  REMOTE_POLL_MS,
  remoteWatchKeys,
  setRemoteWatchWindow,
  stopAllRemoteWatchers,
  unwatchRemoteDir,
  watchRemoteDir,
} from './remote-watch';

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
  stopAllRemoteWatchers();
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
    expect(sftp.entries).toHaveBeenCalledWith({ id: 'lab', name: 'l', host: 'l.example' }, '/srv/app', { timeoutMs: REMOTE_POLL_MS });
    expect(sent).toEqual([]);
  });

  it('re-watching the same host+dir is a no-op (dedupe, no second poll)', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    watchRemoteDir('lab', '/srv/app/');
    await vi.advanceTimersByTimeAsync(0);
    expect(remoteWatchKeys()).toEqual(['lab|/srv/app']);
    expect(sftp.entries).toHaveBeenCalledTimes(1);
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

describe('caps (module-map governance)', () => {
  // The host-registry stub answers only for 'lab', so polls on the synthetic
  // ids bail before the sftp call — these tests exercise the bookkeeping.
  beforeEach(() => {
    sftp.entries.mockResolvedValue([]); // every seed poll resolves quietly
  });

  it('FIFO-evicts the oldest watch at MAX_REMOTE_WATCHES', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_REMOTE_WATCHES; i++) watchRemoteDir('lab', `/srv/d${i}`);
    expect(remoteWatchKeys()).toHaveLength(MAX_REMOTE_WATCHES);
    watchRemoteDir('lab', '/srv/last');
    const keys = remoteWatchKeys();
    expect(keys).toHaveLength(MAX_REMOTE_WATCHES);
    expect(keys).not.toContain('lab|/srv/d0');
    expect(keys[keys.length - 1]).toBe('lab|/srv/last');
    // Warned once, not once per eviction.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('evicts every watch of the oldest host at MAX_REMOTE_WATCHED_HOSTS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let h = 0; h < MAX_REMOTE_WATCHED_HOSTS; h++) {
      watchRemoteDir(`h${h}`, '/srv/a');
      watchRemoteDir(`h${h}`, '/srv/b');
    }
    expect(remoteWatchKeys()).toHaveLength(MAX_REMOTE_WATCHED_HOSTS * 2);
    watchRemoteDir('newcomer', '/srv/a');
    const keys = remoteWatchKeys();
    expect(keys.filter((k) => k.startsWith('h0|'))).toEqual([]);
    expect(keys).toContain('newcomer|/srv/a');
    expect(keys).toHaveLength((MAX_REMOTE_WATCHED_HOSTS - 1) * 2 + 1);
    // Re-watching a live host past the cap costs nothing (no eviction).
    watchRemoteDir('h1', '/srv/c');
    expect(remoteWatchKeys()).toContain('h1|/srv/a');
    warn.mockRestore();
  });
});

describe('stopAllRemoteWatchers', () => {
  it('clears every interval and stops polling', async () => {
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    watchRemoteDir('lab', '/srv/other');
    await vi.advanceTimersByTimeAsync(0);
    const calls = sftp.entries.mock.calls.length;
    stopAllRemoteWatchers();
    expect(remoteWatchKeys()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sftp.entries).toHaveBeenCalledTimes(calls);
    stopAllRemoteWatchers(); // idempotent
  });

  it('releases the window so the next watch re-points fs:changed', async () => {
    // The old window is the module-level `fakeWin`/`sent`; a stop must drop it
    // so a re-opened window (fs-domains calls setRemoteWatchWindow on every
    // fs:watchDir) receives the deltas instead of a destroyed reference.
    const sentNew: FsChange[][] = [];
    const other = {
      isDestroyed: () => false,
      webContents: { send: (_ch: string, changes: FsChange[]) => sentNew.push(changes) },
    } as unknown as BrowserWindow;
    sftp.entries.mockResolvedValue([file('a.ts')]);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0);
    stopAllRemoteWatchers();
    const sentBefore = sent.length;
    setRemoteWatchWindow(other);
    watchRemoteDir('lab', '/srv/app');
    await vi.advanceTimersByTimeAsync(0); // the seed poll stays silent
    sftp.entries.mockResolvedValue([file('a.ts'), file('b.ts', 2)]);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(sentNew).toEqual([[{ path: '/srv/app/b.ts', dir: '/srv/app', type: 'add' }]]);
    expect(sent).toHaveLength(sentBefore);
  });
});
