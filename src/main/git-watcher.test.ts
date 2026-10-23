import { vi } from 'vitest';
import type { ExecFileException } from 'child_process';
import type { Dirent, FSWatcher, WatchListener } from 'fs';

// Mock fs and child_process before importing the module
vi.mock('fs', () => ({
  watch: vi.fn(),
  // PA-17: the BFS walk is async (fs.promises.readdir per dir).
  promises: { readdir: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mutable platform flag so tests can exercise the recursive (macOS/Windows) vs
// per-dir BFS (Linux) working-tree branch. Getters keep the live `import { isLinux }`
// binding in git-watcher in sync with reassignments.
const platform = vi.hoisted(() => ({ isLinux: false }));
vi.mock('./platform', () => ({
  get isLinux() { return platform.isLinux; },
  get isMac() { return !platform.isLinux; },
  get isWin() { return false; },
}));

// git-watcher resolves the git binary through git-status's probe; the suite
// pins the resolved name so the probe never spawns via the execFile mock.
vi.mock('./git-status', () => ({
  gitBinaryPath: () => 'git',
  ensureGitProbe: vi.fn(),
}));

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { startGitWatcher, stopGitWatcher, notifyGitChanged, onGitChanged } from './git-watcher';

const mockWatch = vi.mocked(fs.watch);
const mockReaddir = vi.mocked(fs.promises.readdir);
const mockExecFile = vi.mocked(execFile);

type Tree = Record<string, string[]>; // dir path -> immediate subdir names

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}

function installTree(tree: Tree) {
  mockReaddir.mockImplementation((async (dir: unknown) => {
    const subs = tree[dir as string] ?? [];
    return subs.map((name) => makeDirent(name, true));
  }) as unknown as typeof fs.promises.readdir);
}

function installWatch() {
  const watchers: Array<{
    path: string;
    listener: WatchListener<string>;
    close: () => void;
    errorHandlers: Array<(err: unknown) => void>;
  }> = [];
  mockWatch.mockImplementation(((p: unknown, listenerOrOpts: unknown, maybeListener?: unknown) => {
    // Two call shapes used by the module: fs.watch(path, listener)
    const listener =
      typeof listenerOrOpts === 'function' ? listenerOrOpts : (maybeListener as WatchListener<string>);
    const entry = {
      path: String(p),
      listener: listener as WatchListener<string>,
      close: vi.fn(),
      errorHandlers: [] as Array<(err: unknown) => void>,
    };
    const watcher = {
      close: entry.close,
      on: vi.fn((event: string, cb: (err: unknown) => void) => {
        if (event === 'error') entry.errorHandlers.push(cb);
        return watcher;
      }),
    } as unknown as FSWatcher;
    watchers.push(entry);
    return watcher;
  }) as unknown as typeof fs.watch);
  return watchers;
}

function stubGitRevParse(gitDir: string) {
  mockExecFile.mockImplementationOnce(((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
    (callback as (err: ExecFileException | null, stdout: string) => void)(null, `${gitDir}\n`);
    return undefined as never;
  }) as unknown as typeof execFile);
}

function makeWin() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  platform.isLinux = false; // default to the recursive (macOS/Windows) branch
});

afterEach(() => {
  stopGitWatcher();
  vi.useRealTimers();
});

describe('startGitWatcher', () => {
  it('(Linux) never passes { recursive: true } to fs.watch', async () => {
    platform.isLinux = true;
    const root = path.join('/proj');
    installTree({ [root]: [] });
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    await startGitWatcher(makeWin() as never, root);

    for (const call of mockWatch.mock.calls) {
      // Second arg is either a listener function or options; if options, must not have recursive: true
      const second = call[1];
      if (second && typeof second === 'object' && 'recursive' in second) {
        expect((second as { recursive?: boolean }).recursive).not.toBe(true);
      }
    }
  });

  it('(Linux) does not descend into ignored directories', async () => {
    platform.isLinux = true;
    const root = path.join('/proj');
    const tree: Tree = {
      [root]: ['src', 'node_modules', '.venv', '.git', 'target', '__pycache__', 'lib'],
      [path.join(root, 'src')]: ['components'],
      [path.join(root, 'src', 'components')]: [],
      [path.join(root, 'lib')]: [],
      // These should never be read because they're filtered before queueing:
      [path.join(root, 'node_modules')]: ['some-pkg'],
      [path.join(root, '.venv')]: ['lib'],
    };
    installTree(tree);
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    await startGitWatcher(makeWin() as never, root);

    const watchedPaths = mockWatch.mock.calls.map((c) => String(c[0]));
    expect(watchedPaths).toContain(root);
    expect(watchedPaths).toContain(path.join(root, 'src'));
    expect(watchedPaths).toContain(path.join(root, 'src', 'components'));
    expect(watchedPaths).toContain(path.join(root, 'lib'));

    // Verify ignored dirs are never watched (walk-time exclusion, not just event filter)
    expect(watchedPaths).not.toContain(path.join(root, 'node_modules'));
    expect(watchedPaths).not.toContain(path.join(root, 'node_modules', 'some-pkg'));
    expect(watchedPaths).not.toContain(path.join(root, '.venv'));
    expect(watchedPaths).not.toContain(path.join(root, '.venv', 'lib'));
    expect(watchedPaths).not.toContain(path.join(root, 'target'));
    expect(watchedPaths).not.toContain(path.join(root, '__pycache__'));
    // .git itself is ignored by the working-tree walker but watched separately below
    // (non-recursive on .git dir) — assert here that we did NOT walk INTO .git
    expect(mockReaddir).not.toHaveBeenCalledWith(path.join(root, '.git'), expect.anything());
  });

  it('(Linux) caps the number of working-tree watches', async () => {
    platform.isLinux = true;
    const root = path.join('/proj');
    // Build a fan-out tree with > MAX_WATCHES (2000) total dirs
    const tree: Tree = { [root]: [] };
    const childNames: string[] = [];
    // 60 children x 60 grandchildren = 3600 directories under the root
    for (let i = 0; i < 60; i++) {
      const name = `d${i}`;
      childNames.push(name);
      const child = path.join(root, name);
      const grandNames: string[] = [];
      for (let j = 0; j < 60; j++) grandNames.push(`g${j}`);
      tree[child] = grandNames;
      for (const g of grandNames) tree[path.join(child, g)] = [];
    }
    tree[root] = childNames;

    installTree(tree);
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startGitWatcher(makeWin() as never, root);

    // Working-tree walk should stop at MAX_WATCHES; the module also adds a handful
    // of .git-internal watches afterwards. Total fs.watch calls should not exceed
    // MAX_WATCHES + a small constant (4: .git dir + 3 refs subdirs + HEAD = 5 ish).
    expect(mockWatch.mock.calls.length).toBeLessThanOrEqual(2010);
    expect(mockWatch.mock.calls.length).toBeGreaterThanOrEqual(2000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAX_WATCHES'));
    warn.mockRestore();
  });

  it('debounces and sends git:changed when a watched dir fires an event', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const win = makeWin();
    await startGitWatcher(win as never, root);

    // Fire an event on the root working-tree watcher
    const rootEntry = watchers.find((w) => w.path === root)!;
    rootEntry.listener('change', 'src/foo.ts');

    expect(win.webContents.send).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).toHaveBeenCalledWith('git:changed');
  });

  it('.git/ watcher only notifies for allow-listed filenames', async () => {
    const root = path.join('/proj');
    const gitDir = path.join(root, '.git');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(gitDir);

    const win = makeWin();
    await startGitWatcher(win as never, root);

    const gitEntry = watchers.find((w) => w.path === gitDir)!;

    // Noise inside .git/ (e.g., objects pack write) should NOT notify
    gitEntry.listener('change', 'objects/pack/pack-abc.pack');
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).not.toHaveBeenCalled();

    // Allow-listed files SHOULD notify
    for (const allowed of ['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'packed-refs', 'FETCH_HEAD']) {
      (win.webContents.send as ReturnType<typeof vi.fn>).mockClear();
      gitEntry.listener('change', allowed);
      vi.advanceTimersByTime(300);
      expect(win.webContents.send).toHaveBeenCalledWith('git:changed');
    }
  });

  it('stopGitWatcher closes every watcher and clears the timer', async () => {
    const root = path.join('/proj');
    installTree({ [root]: ['src'], [path.join(root, 'src')]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));

    await startGitWatcher(makeWin() as never, root);
    const createdCount = watchers.length;
    expect(createdCount).toBeGreaterThan(0);

    stopGitWatcher();

    for (const w of watchers) {
      expect(w.close).toHaveBeenCalled();
    }
  });

  it('is idempotent for the same project path', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const win = makeWin();
    await startGitWatcher(win as never, root);
    const firstCallCount = mockWatch.mock.calls.length;

    // Second call with the same path is a no-op (no extra watchers, no extra git rev-parse)
    await startGitWatcher(win as never, root);
    expect(mockWatch.mock.calls.length).toBe(firstCallCount);
  });
  it('(S2-04) stops arming fs.watch handles once a superseding call invalidates the walk', async () => {
    platform.isLinux = true;
    const root = path.join('/big-proj');
    const gate = Promise.withResolvers<Dirent[]>();
    mockReaddir.mockImplementation((async (dir: unknown) => {
      if (dir === root) {
        await gate.promise;
        return Array.from({ length: 50 }, (_, i) => makeDirent(`d${i}`, true));
      }
      return [];
    }) as unknown as typeof fs.promises.readdir);
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const p = startGitWatcher(makeWin() as never, root);
    // Let the BFS reach its pending root readdir.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    stopGitWatcher(); // supersedes the in-flight walk (generation bump)
    gate.resolve([]);
    await p;

    // Without the generation guard every queued subdir would be armed.
    expect(watchers.filter((w) => w.path.includes(`${path.sep}d`))).toHaveLength(0);
    expect(watchers.length).toBeLessThanOrEqual(1); // at most the root, closed by the caller
  });

});

describe('startGitWatcher (macOS/Windows recursive working tree)', () => {
  it('uses a single recursive watch for the working tree (no BFS walk)', async () => {
    const root = path.join('/proj');
    installTree({ [root]: ['src', 'lib'] }); // would be walked on Linux; must be ignored here
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    await startGitWatcher(makeWin() as never, root);

    const rootCalls = mockWatch.mock.calls.filter((c) => String(c[0]) === root);
    expect(rootCalls.length).toBe(1);
    const opts = rootCalls[0][1] as { recursive?: boolean };
    expect(opts.recursive).toBe(true);
    // No per-dir BFS: the tree is never read, and subdirs are never watched.
    expect(mockReaddir).not.toHaveBeenCalled();
    expect(mockWatch.mock.calls.map((c) => String(c[0]))).not.toContain(path.join(root, 'src'));
  });

  it('filters ignored segments, notifies on tracked paths and on null (coalesced)', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const win = makeWin();
    await startGitWatcher(win as never, root);
    const tree = watchers.find((w) => w.path === root)!;

    tree.listener('change', path.join('node_modules', 'foo.js'));
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).not.toHaveBeenCalled();

    tree.listener('change', path.join('src', 'app.ts'));
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).toHaveBeenCalledWith('git:changed');

    (win.webContents.send as ReturnType<typeof vi.fn>).mockClear();
    tree.listener('change', null as never); // OS coalesced — notify conservatively
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).toHaveBeenCalledWith('git:changed');
  });

  it('closes the recursive handle on stop', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));

    await startGitWatcher(makeWin() as never, root);
    stopGitWatcher();

    for (const w of watchers) expect(w.close).toHaveBeenCalled();
  });
});

describe('notifyGitChanged', () => {
  it('sends git:changed after debounce', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    installWatch();
    stubGitRevParse(path.join(root, '.git'));

    const win = makeWin();
    await startGitWatcher(win as never, root);

    notifyGitChanged();
    expect(win.webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(win.webContents.send).toHaveBeenCalledWith('git:changed');
  });

  // PA-07: main-process subscribers (the Quick Open enumeration cache) get
  // the signal immediately, not behind the renderer's debounce.
  it('notifies onGitChanged listeners immediately, and unsubscribing works', async () => {
    const root = path.join('/proj');
    installTree({ [root]: [] });
    installWatch();
    stubGitRevParse(path.join(root, '.git'));
    await startGitWatcher(makeWin() as never, root);

    const listener = vi.fn();
    const off = onGitChanged(listener);
    notifyGitChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    notifyGitChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('watcher resilience', () => {
  it('first watcher error warns once with the code and arms the periodic rescan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));
    const win = makeWin();
    await startGitWatcher(win as never, root);
    const send = (win.webContents as unknown as { send: ReturnType<typeof vi.fn> }).send;

    watchers
      .find((w) => w.path === root)!
      .errorHandlers.forEach((h) => h(Object.assign(new Error('native events died'), { code: 'EMFILE' })));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMFILE');

    // The rescan drives the same debounced `git:changed` signal the renderer
    // listens for: a 2s tick + the 300ms flush must reach the window.
    send.mockClear();
    await vi.advanceTimersByTimeAsync(2300);
    expect(send).toHaveBeenCalledWith('git:changed');

    // A second error on another watcher: no second warn (warn-once contract).
    warn.mockClear();
    watchers
      .find((w) => w.path === path.join(root, '.git'))!
      .errorHandlers.forEach((h) => h(Object.assign(new Error('again'), { code: 'EMFILE' })));
    expect(warn).not.toHaveBeenCalled();
  });

  it('Linux ENOSPC warns with the inotify-limit text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    platform.isLinux = true;
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));
    await startGitWatcher(makeWin() as never, root);
    watchers
      .find((w) => w.path === root)!
      .errorHandlers.forEach((h) => h(Object.assign(new Error('queue overflow'), { code: 'ENOSPC' })));
    expect(String(warn.mock.calls[0][0])).toContain('inotify limit reached (fs.inotify.max_user_watches)');
  });

  it('stopGitWatcher tears the rescan down (no sends after stop)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = path.join('/proj');
    installTree({ [root]: [] });
    const watchers = installWatch();
    stubGitRevParse(path.join(root, '.git'));
    const win = makeWin();
    await startGitWatcher(win as never, root);
    const send = (win.webContents as unknown as { send: ReturnType<typeof vi.fn> }).send;
    watchers
      .find((w) => w.path === root)!
      .errorHandlers.forEach((h) => h(Object.assign(new Error('boom'), { code: 'EMFILE' })));
    stopGitWatcher();
    send.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
  });
});
