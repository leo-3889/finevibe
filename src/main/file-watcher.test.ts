import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// A fake chokidar FSWatcher that records add/unwatch calls and lets tests emit events.
class FakeWatcher {
  added: string[] = [];
  unwatched: string[] = [];
  closed = false;
  handlers = new Map<string, (p: string) => void>();
  on(event: string, cb: (p: string) => void) {
    this.handlers.set(event, cb);
    return this;
  }
  add(p: string) { this.added.push(p); return this; }
  unwatch(p: string) { this.unwatched.push(p); return this; }
  close() { this.closed = true; return Promise.resolve(); }
  emit(event: string, payload: string | NodeJS.ErrnoException) { this.handlers.get(event)?.(payload as string); }
}

let lastWatcher: FakeWatcher;
const FSWatcherCtor = vi.fn((_opts?: unknown) => {
  lastWatcher = new FakeWatcher();
  return lastWatcher;
});

vi.mock('chokidar', () => ({
  FSWatcher: function (opts?: unknown) { return FSWatcherCtor(opts); },
}));

import { watchDir, unwatchDir, setFileWatcherWindow, stopAllFileWatchers } from './file-watcher';

function makeWin() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as any;
  return { win, send };
}

beforeEach(() => {
  vi.useFakeTimers();
  FSWatcherCtor.mockClear();
  stopAllFileWatchers();
});

afterEach(() => {
  stopAllFileWatchers();
  vi.useRealTimers();
});

describe('directory ref-counting', () => {
  it('creates a single watcher and adds a dir once across multiple watchers', () => {
    watchDir('/a');
    watchDir('/a');
    expect(FSWatcherCtor).toHaveBeenCalledTimes(1);
    expect(lastWatcher.added).toEqual(['/a']);
  });

  it('only unwatches when the last reference is dropped', () => {
    watchDir('/a');
    watchDir('/a');
    unwatchDir('/a');
    expect(lastWatcher.unwatched).toEqual([]);
    unwatchDir('/a');
    expect(lastWatcher.unwatched).toEqual(['/a']);
  });

  it('ignores unwatch of an unknown dir', () => {
    watchDir('/a');
    unwatchDir('/never-watched');
    expect(lastWatcher.unwatched).toEqual([]);
  });
});

describe('change batching', () => {
  it('coalesces a burst into one debounced fs:changed send', () => {
    const { win, send } = makeWin();
    setFileWatcherWindow(win);
    watchDir('/a');

    lastWatcher.emit('add', '/a/one.ts');
    lastWatcher.emit('change', '/a/one.ts');
    lastWatcher.emit('unlink', '/a/two.ts');

    expect(send).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(200);

    expect(send).toHaveBeenCalledTimes(1);
    const [channel, changes] = send.mock.calls[0];
    expect(channel).toBe('fs:changed');
    expect(changes).toEqual([
      { path: '/a/one.ts', dir: '/a', type: 'add' },
      { path: '/a/one.ts', dir: '/a', type: 'change' },
      { path: '/a/two.ts', dir: '/a', type: 'unlink' },
    ]);
  });

  it('does not send to a destroyed window', () => {
    const send = vi.fn();
    const win = { isDestroyed: () => true, webContents: { send } } as any;
    setFileWatcherWindow(win);
    watchDir('/a');
    lastWatcher.emit('change', '/a/x.ts');
    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('closes the watcher and clears state', () => {
    watchDir('/a');
    const w = lastWatcher;
    stopAllFileWatchers();
    expect(w.closed).toBe(true);

    // A subsequent watch spins up a fresh watcher.
    watchDir('/b');
    expect(FSWatcherCtor).toHaveBeenCalledTimes(2);
  });
});

describe('watcher resilience', () => {
  it('warns once with the error code and restarts the watcher with usePolling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    watchDir('/repo/a');
    const first = lastWatcher;
    lastWatcher.emit('error', Object.assign(new Error('native events died'), { code: 'EMFILE' }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMFILE');
    // The native watcher is closed and rebuilt in polling mode…
    expect(first.closed).toBe(true);
    expect(FSWatcherCtor).toHaveBeenCalledTimes(2);
    const opts = FSWatcherCtor.mock.calls[1][0] as { usePolling: boolean; interval?: number };
    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBe(2000);
    // …and every live root is re-armed on it.
    expect(lastWatcher.added).toEqual(['/repo/a']);
    // A second error: no second warn, no second restart (already polling).
    lastWatcher.emit('error', new Error('again'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(FSWatcherCtor).toHaveBeenCalledTimes(2);
  });

  it('starts in polling mode for a UNC root (native events are unreliable there)', () => {
    watchDir('\\\\server\\share\\repo');
    const opts = FSWatcherCtor.mock.calls[0][0] as { usePolling: boolean };
    expect(opts.usePolling).toBe(true);
  });

  it('starts in polling mode for a wsl.localhost root', () => {
    watchDir('\\\\wsl.localhost\\Ubuntu\\home\\user\\repo');
    const opts = FSWatcherCtor.mock.calls[0][0] as { usePolling: boolean };
    expect(opts.usePolling).toBe(true);
  });

  it('keeps native watching for plain local roots (polling costs stay opt-in)', () => {
    watchDir('/repo/plain');
    const opts = FSWatcherCtor.mock.calls[0][0] as { usePolling: boolean };
    expect(opts.usePolling).toBe(false);
  });

  it('a network root admitted to a live native watcher restarts it polling', () => {
    watchDir('/repo/plain');
    expect(FSWatcherCtor.mock.calls[0][0]).toEqual(expect.objectContaining({ usePolling: false }));
    watchDir('\\\\server\\share\\repo');
    expect(FSWatcherCtor).toHaveBeenCalledTimes(2);
    expect(FSWatcherCtor.mock.calls[1][0]).toEqual(expect.objectContaining({ usePolling: true }));
    // Both roots live on the polling watcher.
    expect(lastWatcher.added).toEqual(['/repo/plain', '\\\\server\\share\\repo']);
  });
});
