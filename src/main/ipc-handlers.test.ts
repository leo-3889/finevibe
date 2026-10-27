import { EventEmitter } from 'events';
import { searchSessions } from './session-deep-search';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CliProvider } from './providers/provider';
import * as fs from 'fs';
import * as os from 'os';
import { clipboard, dialog, shell, utilityProcess } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ClipboardPastePayload, SettingsValidationResult } from '../shared/types';
import * as path from 'path';
import { SPAWN_REJECTED_EXIT_REASON } from '../shared/constants';

/**
 * Focused on the `pty:create` lifecycle: which provider hook fires for a
 * fresh vs a resumed spawn, and the ORDER of the teardown calls in the PTY
 *
 * `calls` records lifecycle events in the order they happen, so the
 * assertions are about sequence rather than membership.
 */

type ExitCallback = (exitCode: number, signal?: number, pid?: number, spawnRejectedReason?: string) => void;

const calls = vi.hoisted(() => [] as string[]);
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const knownPaths = vi.hoisted(() => [] as string[]);
const remoteRoots = vi.hoisted(() => [] as Array<{ path: string; hostId: string }>);
const fakeWin = vi.hoisted(() => ({
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
}));

const mockSpawnPty = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<void> => {}));
const mockRegisterSync = vi.hoisted(() => vi.fn());
const mockUnregisterSync = vi.hoisted(() => vi.fn(() => { calls.push('unregister'); }));
const mockGetProvider = vi.hoisted(() => vi.fn());
const mockGetAvailableAsync = vi.hoisted(() => vi.fn(async () => [] as string[]));
const mockGetSyncedPath = vi.hoisted(() => vi.fn((): string | null => null));
const mockRegisterSession = vi.hoisted(() => vi.fn());

// Modules the handler-under-test imports but this suite never exercises: a
// Proxy of vi.fn()s keeps the module loadable without hand-listing exports.
const autoStub = vi.hoisted(() => () =>
  new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (key === '__esModule') return true;
      // Never stub `then`. A stubbed `then` makes the whole namespace a
      // thenable, so anything that awaits the import (vitest's own interop
      // included) resolves to a mock fn instead of the module.
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined;
      if (typeof key === 'symbol') return target[key];
      if (!(key in target)) target[key] = vi.fn();
      return target[key];
    },
  })
);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [fakeWin],
    fromWebContents: () => fakeWin,
    getFocusedWindow: () => fakeWin,
  },
  app: {
    getPath: () => '/mock/app',
    getName: () => 'finevibe',
    getVersion: () => 'test',
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    // fs:browseDirectory passes the native directory picker through; the
    // default cancels, picker-success tests override per test.
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] as string[] })),
  },
  // The file-tree channels: `fs:trashItem` moves a file to its volume's trash
  // (the EXDEV test overrides `trashItem` per test) and `fs:showInFolder`
  // reveals a file with showItemInFolder / opens a folder with openPath.
  shell: {
    openExternal: () => Promise.resolve(),
    trashItem: vi.fn(() => Promise.resolve()),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(() => Promise.resolve('')),
  },
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => ''),
    // Default: a format that is not on the clipboard. Tests override per format.
    readBuffer: vi.fn(() => { throw new Error('format not on clipboard'); }),
    read: vi.fn(() => ''),
    readHTML: vi.fn(() => ''),
    readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    availableFormats: vi.fn(() => [] as string[]),
  },
  // P4: the off-main PNG encoder forks a utilityProcess; the default stub
  // refuses the fork, so handlers take the documented main-thread
  // fallback. Worker-success tests override `fork` per test.
  utilityProcess: { fork: vi.fn(() => null as never) },
}));

// The ESM namespace of a node builtin is frozen, so `vi.spyOn(os, 'homedir')`
// throws ("Module namespace is not configurable in ESM"). Swap in a mutable
// binding over the real module — the repo's established 'os'-mock technique.
const osHomeOverride = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => osHomeOverride.value || actual.homedir() };
});

vi.mock('./pty-manager', () => ({
  spawnPty: mockSpawnPty,
  spawnShellPty: vi.fn(),
  writePty: vi.fn(),
  resizePty: vi.fn(),
  killPty: vi.fn(),
  getPtyCwd: vi.fn(),
  getFullPath: vi.fn(() => '/usr/bin'),
}));

vi.mock('./session-transcript-sync', () => ({
  registerTranscriptSync: mockRegisterSync,
  unregisterTranscriptSync: mockUnregisterSync,
  getSyncedTranscriptPath: mockGetSyncedPath,
}));

vi.mock('./providers/registry', () => ({
  getProvider: mockGetProvider,
  getAllProviderMetas: vi.fn(),
  getAllProviders: vi.fn(),
  getAvailableProviderIdsAsync: mockGetAvailableAsync,
}));

vi.mock('./store', () => ({
  loadState: vi.fn(() => ({ projects: [], preferences: {} })),
  saveState: vi.fn(),
  saveStateSync: vi.fn(),
  getKnownProjectPaths: () => knownPaths,
  getRemoteProjectRoots: () => remoteRoots,
}));

vi.mock('./hook-status', () => ({
  startWatching: vi.fn(),
  cleanupSessionStatus: vi.fn(),
  resyncAllSessions: vi.fn(),
  registerSession: mockRegisterSession,
}));

vi.mock('./claude-cli', autoStub);
vi.mock('./providers/resume-handoff', autoStub);
vi.mock('./session-deep-search', autoStub);
vi.mock('./git-status', autoStub);
vi.mock('./git-watcher', autoStub);
vi.mock('./file-watcher', autoStub);
vi.mock('./mcp-ipc-handlers', autoStub);
vi.mock('./auto-updater', autoStub);
vi.mock('./menu', autoStub);
vi.mock('./readiness/analyzer', autoStub);
vi.mock('./github-cli', autoStub);
vi.mock('./fs-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('./fs-utils')>(),
  expandUserPath: (p: string) => p,
  isBinaryBuffer: () => false,
  isMacPackagePath: () => false,
  BINARY_SNIFF_BYTES: 8000,
}));
const platformState = vi.hoisted(() => ({ os: 'win32' as 'win32' | 'darwin' | 'linux' }));
// P2: the clipboard probes branch on the platform, so tests must be able to
// pick one — the autoStub alone made every isWin/isMac/isLinux a truthy
// mock function. The getters re-evaluate per access (vitest's ESM interop
// reads the namespace property at each use), so one assignment flips the OS.
// Default 'win32': the P0-measured live file format (FileNameW) is Windows'.
// fs:cloneRepo spawns `git clone` through execFile; the suite swaps in a spy
// (keeping every other child_process export real for transitive importers) so
// the gate tests can assert git is never launched on a rejected request.
const mockGitCloneSpawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: mockGitCloneSpawn,
}));

vi.mock('./platform', async () => ({
  ...(autoStub() as object),
  get isWin() { return platformState.os === 'win32'; },
  get isMac() { return platformState.os === 'darwin'; },
  get isLinux() { return platformState.os === 'linux'; },
}));
vi.mock('./chrome-import/importer', autoStub);
vi.mock('./settings-guard', autoStub);
vi.mock('./finevibeignore', autoStub);
vi.mock('./close-state', autoStub);
vi.mock('./profiles', autoStub);
vi.mock('./claude-keychain', autoStub);
vi.mock('../shared/token-estimate', autoStub);
// Per-host providers T1: the channel tests drive the host record lookup and
// the shared tool refresh; the SSH stack must never load in this suite.
vi.mock('./hosts/host-registry', autoStub);
const sshExec = vi.hoisted(() => vi.fn());
vi.mock('./hosts/ssh-client', () => ({
  exec: (...args: unknown[]) => sshExec(...args),
  sftpRead: vi.fn(),
}));
vi.mock('./hosts/enrollment', autoStub);
vi.mock('./hosts/remote-provider-config', autoStub);
vi.mock('./hosts/settings-sync', autoStub);
vi.mock('./hosts/remote-fs', autoStub);

import {
  registerIpcHandlers, _resetEnumerateCacheForTesting, _resetHomeOutsideConsentForTesting,
  sweepEnumerationCaches, ENUMERATE_CACHE_MAX, TOP_FILES_CACHE_MAX, OUTSIDE_HOME_CONSENT_MAX,
} from './ipc-handlers';
import { isManagedMcpConfigDir, removeMcpServer } from './claude-cli';
import { loadState } from './store';
import { shouldWarnStatusLine, getDirConsent, recordDirConsent } from './settings-guard';
import { cleanupSessionStatus } from './hook-status';
import { analyzeReadiness } from './readiness/analyzer';
import { detectRepo } from './github-cli';
import { buildFineVibeIgnoreMatcher } from './finevibeignore';
import { estimateTokens } from '../shared/token-estimate';

import { getAllProviders, getAvailableProviderIdsAsync } from './providers/registry';
import { getHost } from './hosts/host-registry';
import { refreshHostTools, provisionRemoteProfileDir } from './hosts/enrollment';
import { syncSettingsToHost } from './hosts/settings-sync';
import { getRemoteProviderConfig } from './hosts/remote-provider-config';
import { listRemoteDir, readRemoteFile, statRemotePath, walkRemoteFiles } from './hosts/remote-fs';
function makeProvider(): CliProvider {
  return {
    // hookStatus off keeps the post-spawn settings-warning block out of the way.
    meta: { id: 'claude', capabilities: { hookStatus: false } },
    onSessionStarted: vi.fn(() => { calls.push('started'); }),
    onSessionResumed: vi.fn(() => { calls.push('resumed'); }),
    onSessionExited: vi.fn(() => { calls.push('exited'); }),
    validateSettings: vi.fn(() => ({ statusLine: 'ok', hooks: 'complete' })),
    reinstallSettings: vi.fn(),
  } as unknown as CliProvider;
}

let provider: CliProvider;

/** Invoke the captured `pty:create` handler with the real positional shape. */
async function create(
  sessionId: string,
  cliSessionId: string | null,
  opts: { isResume?: boolean; providerId?: string; configDir?: string } = {}
): Promise<void> {
  const handler = handlers.get('pty:create');
  if (!handler) throw new Error('pty:create was not registered');
  // The launch gate binds cwd to the project tier; the lifecycle tests
  // launch in '/proj', so make it a known project.
  knownPaths.push('/proj');
  await handler(
    {},
    sessionId,
    '/proj',
    cliSessionId,
    opts.isResume ?? false,
    '',
    opts.providerId ?? 'pi',
    undefined,
    undefined,
    '',
    opts.configDir
  );
}

/** The exit callback spawnPty was handed (positional arg 10). */
function exitCallback(): ExitCallback {
  return mockSpawnPty.mock.calls[0][10] as ExitCallback;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Order-independence: clearAllMocks clears CALLS but keeps implementations
  // and leaked mockResolvedValueOnce chains. Several tests document and rely
  // on the factory default "showMessageBox resolves response 0 (Cancel)" -
  // a shuffled predecessor's mockResolvedValueOnce({response:1}) survived and
  // made a denied-consent test enumerate the directory. Restore the factory
  // baselines; clipboard.writeText is a bare vi.fn (reset to default).
  vi.mocked(dialog.showMessageBox).mockReset().mockImplementation(() => Promise.resolve({ response: 0 } as never));
  vi.mocked(clipboard.writeText).mockReset();
  // Same class on the store mock: the fs:listDirs enumerate gate reads
  // preferences.defaultProjectsFolder via loadState; a shuffled predecessor's
  // throwing loadState impl ("state cache corrupted" at the corrupt-store
  // test) survived clearAllMocks and made the gate catch -> [] with NO
  // dialog. Restore the factory default every case.
  vi.mocked(loadState).mockReset().mockImplementation(() => ({ projects: [], preferences: {} } as never));
  calls.length = 0;
  // The home-outside consent Map is module state; each test starts fresh.
  _resetHomeOutsideConsentForTesting();
  handlers.clear();
  knownPaths.length = 0;
  remoteRoots.length = 0;
  provider = makeProvider();
  mockGetProvider.mockReturnValue(provider);
  // pty:create gates a renderer-supplied configDir through the managed
  // profile allowlist (claude-cli, autoStubbed here): tests that want the
  // gate exercised override it per-test.
  vi.mocked(isManagedMcpConfigDir).mockReturnValue(true);
  registerIpcHandlers();
});

describe('project file read boundary', () => {
  it('rejects a link inside a project whose target is outside it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ipc-test-'));
    try {
      const project = path.join(root, 'project');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(project);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
      fs.symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      knownPaths.push(project);
      const read = handlers.get('fs:readFile')!;
      await expect(read({}, path.join(project, 'linked', 'secret.txt'))).resolves.toEqual({ ok: false, reason: 'error' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a text file larger than the bounded reader limit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ipc-test-'));
    try {
      const large = path.join(root, 'large.txt');
      const fd = fs.openSync(large, 'w');
      try { fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
      knownPaths.push(root);
      const read = handlers.get('fs:readFile')!;
      await expect(read({}, large)).resolves.toEqual({ ok: false, reason: 'error' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// PA-07: Quick Open enumerated the whole repo (a fresh `git ls-files` spawn)
// per debounced keystroke. The enumeration is now cached per cwd and
// invalidated by the git:changed signal and a TTL.
describe('fs:listFiles enumeration cache (PA-07)', () => {
  const list = (cwd: string, query = ''): Promise<string[]> =>
    handlers.get('fs:listFiles')!({}, cwd, query) as Promise<string[]>;

  function stubGitLsFiles(stdout: string | null) {
    mockGitCloneSpawn.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: unknown, stderr?: string) => void;
      // enumerateProjectFiles awaits promisify(execFile) over the MOCK: the
      // vi.fn() carries no util.promisify.custom, so the generic promisify
      // resolves the FIRST callback arg and the source destructures
      // { stdout }. Hand it the envelope (same convention as
      // resolve-binary.test.ts), not the raw execFile string.
      if (stdout === null) cb(new Error('not a git repository'), '', '');
      else cb(null, { stdout }, '');
    }) as never);
  }

  async function gitChangedListener(): Promise<() => void> {
    const gitWatcher = await import('./git-watcher');
    const calls = vi.mocked(gitWatcher.onGitChanged).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0] as () => void;
  }

  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-enumerate-'));
    knownPaths.push(root);
    _resetEnumerateCacheForTesting();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('enumerates once per cwd across keystrokes; git:changed and the TTL invalidate', async () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    stubGitLsFiles('a.ts\n');
    expect(await list(root, 'a')).toEqual(['a.ts']);

    // A new file + new keystroke: served from the cache, NO new git spawn.
    fs.writeFileSync(path.join(root, 'b.ts'), 'b');
    stubGitLsFiles('a.ts\nb.ts\n');
    expect(await list(root, 'b')).toEqual([]); // stale by design — TTL-bound:
    // the cache still holds ['a.ts'], so 'b' matches nothing AND no new
    // git spawn fires (the staleness proof below).
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(1);

    // The git:changed signal the renderer also receives clears the cache.
    (await gitChangedListener())();
    expect(await list(root, 'b')).toEqual(['b.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(2);

    // TTL backstop for trees the watcher never touches.
    fs.writeFileSync(path.join(root, 'c.ts'), 'c');
    stubGitLsFiles('a.ts\nb.ts\nc.ts\n');
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(31_000);
    expect(await list(root, 'c')).toEqual(['c.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(3);
  });

  it('filters the cached list per query without re-enumerating', async () => {
    stubGitLsFiles('src/alpha.ts\nsrc/beta.ts\nREADME.md\n');
    expect(await list(root, 'beta')).toEqual(['src/beta.ts']);
    expect(await list(root, 'src')).toEqual(['src/alpha.ts', 'src/beta.ts']);
    expect(await list(root, '')).toEqual(['src/alpha.ts', 'src/beta.ts', 'README.md']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(1);
  });

  it('walks non-git trees asynchronously (PA-07 fallback)', async () => {
    stubGitLsFiles(null); // git ls-files fails → fallback walk
    fs.mkdirSync(path.join(root, 'sub'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'sub', 'b.ts'), 'b');
    fs.writeFileSync(path.join(root, 'node_modules', 'x.ts'), 'x');
    const files = await list(root);
    // '/'-separated on every OS — the enumeration contract (see toPosixRel).
    expect(new Set(files)).toEqual(new Set(['a.ts', 'sub/b.ts']));
  });

  it('asks git for unquoted paths so a non-ASCII filename survives enumeration', async () => {
    stubGitLsFiles('café/AGENTS.md\n');
    expect(await list(root, 'café')).toEqual(['café/AGENTS.md']);
    const [cmd, argv] = mockGitCloneSpawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('git');
    // The same flag readiness/utils.ts pins, for the same reason: by default
    // git octal-escapes non-ASCII paths, so Quick Open listed
    // "caf\303\251/AGENTS.md" — a name that is neither what the user types nor
    // what the file tree shows, so the file was unopenable from Quick Open.
    expect(argv).toContain('core.quotePath=false');
    expect(argv).toContain('ls-files');
  });

  it('reports fallback-walked paths with \'/\' separators on a Windows host', async () => {
    // `git ls-files` prints '/' on every OS, and every consumer of the listing
    // matches on that shape. The walk handed them path.relative's native
    // spelling instead: on Windows `generated\out.js` matched no `generated/`
    // pattern. POSIX is a no-op (sep === '/'), so this is the Windows pin.
    // The directory is NOT one of the walk's built-in IGNORE names, which are
    // dropped by entry name and would hide the separator contract.
    platformState.os = 'win32';
    stubGitLsFiles(null);
    fs.mkdirSync(path.join(root, 'generated'));
    fs.writeFileSync(path.join(root, 'generated', 'out.js'), 'x');
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    expect(new Set(await list(root))).toEqual(new Set(['a.ts', 'generated/out.js']));
  });

  it('a trailing-slash ignore pattern excludes a fallback-walked directory', async () => {
    platformState.os = 'win32';
    stubGitLsFiles(null);
    fs.mkdirSync(path.join(root, 'generated'));
    fs.writeFileSync(path.join(root, 'generated', 'bundle.js'), 'bundled');
    fs.writeFileSync(path.join(root, 'a.ts'), 'source');
    // picomatch's `generated/` semantics over '/' paths — finevibeignore builds
    // exactly this, and mocking it is this suite's convention.
    vi.mocked(buildFineVibeIgnoreMatcher).mockReturnValue((rel: string) => rel.split('/')[0] === 'generated');

    const res = await handlers.get('fs:topFilesByTokens')!({}, root, 10) as {
      ok: boolean;
      files: Array<{ path: string }>;
    };
    expect(res.ok).toBe(true);
    // The excluded directory never reaches the scan; on the pre-fix native
    // spelling (`generated\bundle.js`) the pattern missed and it was read.
    expect(res.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('a git:changed invalidation drops the enumeration already in flight (UI3-11)', async () => {
    // Park enumeration #1: its git spawn never calls back, so the tree is
    // "being walked" while the repo changes underneath it.
    let releaseStale: (() => void) | null = null;
    mockGitCloneSpawn.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: unknown) => void;
      releaseStale = () => cb(null, { stdout: 'a.ts\ngone.ts\n' });
    }) as never);

    const stale = list(root, 'a'); // enumeration #1 — parked mid-walk
    await Promise.resolve();

    // The repo changes; the debounced git:changed signal invalidates.
    stubGitLsFiles('a.ts\nb.ts\n');
    (await gitChangedListener())();

    // The invalidation must drop the parked walk as well: a new caller starts a
    // fresh enumeration instead of being handed the superseded one.
    expect(await list(root, 'b')).toEqual(['b.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(2);

    // #1 lands late, carrying the pre-change listing.
    releaseStale!();
    expect(await stale).toEqual(['a.ts']);

    // Its cache write must be dropped too: the cache keeps the fresh listing, so
    // 'gone' matches nothing with no third spawn. Clearing only the Map let the
    // late write repopulate it, undoing the invalidation for a whole TTL.
    stubGitLsFiles('a.ts\nb.ts\ngone.ts\n');
    expect(await list(root, 'gone')).toEqual([]);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(2);
    expect(await list(root, 'b')).toEqual(['b.ts']);
  });
});

// The file tree's two shell channels. `shell.trashItem` moves a file into the
// trash of ITS OWN volume, so it rejects EXDEV for a project under os.tmpdir()
// or on a secondary drive; the renderer caller has to see that reason, and the
// reveal has to keep passing the file (not the parent) to be selected.
describe('fs:trashItem / fs:showInFolder shell wiring', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-shell-'));
    knownPaths.push(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('surfaces an EXDEV trash rejection to the caller as { ok:false, error }', async () => {
    const file = path.join(root, 'shot.png');
    fs.writeFileSync(file, 'x');
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
    vi.mocked(shell.trashItem).mockRejectedValueOnce(exdev);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await handlers.get('fs:trashItem')!({}, file)).toEqual({ ok: false, error: exdev.message });
      expect(warn).toHaveBeenCalledWith('fs:trashItem failed:', exdev);
    } finally {
      warn.mockRestore();
    }
  });

  it('reveals a file with showItemInFolder(file) — the file path is what selects it', async () => {
    const file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'x');
    expect(await handlers.get('fs:showInFolder')!({}, file)).toEqual({ ok: true });
    // Electron's Linux reveal passes `--select <file>` to the file manager
    // (Nautilus, Nemo, …), which needs the FILE; handing it the parent dir
    // would open the folder with nothing highlighted.
    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('opens a directory itself with openPath, never as a reveal', async () => {
    const dir = path.join(root, 'src');
    fs.mkdirSync(dir);
    expect(await handlers.get('fs:showInFolder')!({}, dir)).toEqual({ ok: true });
    expect(shell.openPath).toHaveBeenCalledWith(dir);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });
});

// PA-24: the stats widget rendered this every poll; the JSON file used to be
// read and parsed in full each time. Memoized by (path, mtime, size).
describe('stats:getCache memoization (PA-24)', () => {
  it('re-parses only when the file mtime/size changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-statscache-'));
    osHomeOverride.value = root;
    try {
      fs.mkdirSync(path.join(root, '.claude'));
      const file = path.join(root, '.claude', 'stats-cache.json');
      const get = () => handlers.get('stats:getCache')!({}) as Promise<unknown>;

      fs.writeFileSync(file, JSON.stringify({ v: 1, pad: 'x'.repeat(64) }));
      // NTFS records sub-ms mtime; utimesSync only accepts integer ms.
      // Quantize the file's clock BEFORE the memo takes its first
      // (mtime, size) snapshot, so the mtime restore below (Date-precision)
      // lands exactly on the memo key — a sub-ms delta re-parses.
      const q = fs.statSync(file);
      fs.utimesSync(file, new Date(Math.floor(q.atimeMs)), new Date(Math.floor(q.mtimeMs)));
      expect(await get()).toEqual({ v: 1, pad: 'x'.repeat(64) });

      // Rewrite with identical size, restored mtime: the memo answers, no re-parse.
      const st = fs.statSync(file);
      fs.writeFileSync(file, JSON.stringify({ v: 2, pad: 'y'.repeat(64) }));
      fs.utimesSync(file, new Date(st.atimeMs), new Date(st.mtimeMs));
      expect(await get()).toEqual({ v: 1, pad: 'x'.repeat(64) });

      // A real write bumps the mtime → re-read.
      fs.utimesSync(file, new Date(st.atimeMs), new Date(st.mtimeMs + 5000));
      expect(await get()).toEqual({ v: 2, pad: 'y'.repeat(64) });

      // Unreadable file → null, memo dropped.
      fs.rmSync(file);
      expect(await get()).toBeNull();
    } finally {
      osHomeOverride.value = '';
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Phase 3 coherence belt: a remote project's path must never be served by
// the LOCAL git/fs sinks. The belt compares raw posix strings (no local
// canonicalization), so it fires exactly where the old shared-fiction gate
// passed: a controller whose local paths mirror the host's (Linux/macOS).
// On Windows a remote posix path canonicalizes to a phantom drive path that
// fails on its own, so the belt is inert there - skip.
describe.skipIf(process.platform === 'win32')('remote-scope belt (git/fs)', () => {
  it('git:getStatus refuses a remote project root and its subtrees', () => {
    remoteRoots.push({ path: '/srv/app', hostId: 'host-1' });
    // Same-path LOCAL record (the mirror-path lie): the shared-fiction gate
    // passes, the belt must catch it.
    knownPaths.push('/srv/app');
    expect(() => handlers.get('git:getStatus')!({}, '/srv/app')).toThrow(/remote host/);
    expect(() => handlers.get('git:getStatus')!({}, '/srv/app/sub')).toThrow(/remote host/);
    // Trailing slash on the record, deep path in the call - both normalize.
    remoteRoots[0].path = '/srv/app/';
    expect(() => handlers.get('git:getStatus')!({}, '/srv/app/a/b')).toThrow(/remote host/);
  });

  it('fs:listFiles refuses a remote-rooted cwd with a greppable warn', async () => {
    remoteRoots.push({ path: '/srv/app', hostId: 'host-1' });
    knownPaths.push('/srv/app');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files = await handlers.get('fs:listFiles')!({}, '/srv/app', '');
    expect(files).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fs:listFiles blocked'));
    warn.mockRestore();
  });

  // R2 Phase 4a: naming the host routes to the sftp walk sibling instead of
  // the belt refusal above.
  it('fs:listFiles with a remote hostId answers from the sftp walk (Phase 4a)', async () => {
    vi.mocked(walkRemoteFiles).mockReset().mockResolvedValue(['src/a.ts', 'src/b.ts', 'README.md']);
    const files = await handlers.get('fs:listFiles')!({}, '/home/u/app', 'src/', 'host-1') as string[];
    expect(walkRemoteFiles).toHaveBeenCalledWith('host-1', '/home/u/app');
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('local projects are untouched by the belt', async () => {
    knownPaths.push(path.resolve('/local/proj'));
    expect(() => handlers.get('git:getStatus')!({}, path.resolve('/local/proj'))).not.toThrow();
  });
});

// Phase 3.5 (git-on.ts): a remote project with a live host record ROUTES to
// the exec lane instead of the belt refusal; mutations still refuse (the
// panel is read-only until the remote write-side lands in Phase 4).
describe('git:* remote routing (Phase 3.5)', () => {
  it('git:getStatus routes a remote project to the exec lane', async () => {
    remoteRoots.push({ path: '/srv/rout', hostId: 'host-1' });
    const record = { id: 'host-1', name: 'h', host: 'h.example' } as never;
    vi.mocked(getHost).mockReturnValueOnce(record);
    sshExec.mockResolvedValueOnce('# branch.head main\n# branch.ab +1 -0\n');
    const gitStatus = await import('./git-status');
    await handlers.get('git:getStatus')!({}, '/srv/rout');
    // The exec command is the routing contract; parsing itself is pinned in
    // git-on.test.ts (here git-status is autoStubbed, so the parsed value is stub noise).
    expect(sshExec).toHaveBeenCalledWith(
      record,
      "git -C '/srv/rout' status --porcelain=v2 --branch --untracked-files=all",
      { timeoutMs: 5000 },
    );
    expect(vi.mocked(gitStatus.getGitStatus)).not.toHaveBeenCalled();
  });

  // Phase 4b retired the read-only refusal: remote stage now routes to the
  // exec lane sibling instead of throwing.
  it('git:stageFile on a remote project routes to the exec lane (Phase 4b)', async () => {
    remoteRoots.push({ path: '/srv/rout2', hostId: 'host-1' });
    const record = { id: 'host-1', name: 'h', host: 'h.example' } as never;
    vi.mocked(getHost).mockReturnValueOnce(record);
    sshExec.mockResolvedValueOnce('');
    await expect(handlers.get('git:stageFile')!({}, '/srv/rout2', 'x.ts')).resolves.toBeUndefined();
    expect(sshExec).toHaveBeenCalledWith(record, "git -C '/srv/rout2' add -- 'x.ts'", { timeoutMs: 5000 });
  });
});

describe('git:* root gate', () => {
  it('blocks git handlers aimed at a cwd the renderer invented', async () => {
    const gitStatus = await import('./git-status');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      const outside = path.join(root, 'worktree');
      fs.mkdirSync(outside);

      expect(() => handlers.get('git:getStatus')!({}, outside)).toThrow(/not within a known project/);
      expect(() => handlers.get('git:getWorktrees')!({}, outside)).toThrow(/not within a known project/);
      // The discard sink is the reason this gate exists at all. Its handler is
      // async, so the gate surfaces as a rejection, not a synchronous throw.
      await expect(handlers.get('git:discardFile')!({}, outside, 'x.txt')).rejects.toThrow(/not within a known project/);
      expect(vi.mocked(gitStatus.getGitStatus)).not.toHaveBeenCalled();
      expect(vi.mocked(gitStatus.getGitWorktrees)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a known project directory', async () => {
    const gitStatus = await import('./git-status');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      knownPaths.push(root);
      handlers.get('git:getStatus')!({}, root);
      expect(vi.mocked(gitStatus.getGitStatus)).toHaveBeenCalledWith(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a watched worktree git-capable after its project is closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      const project = path.join(root, 'project');
      const worktree = path.join(project, '.wt', 'w1');
      fs.mkdirSync(worktree, { recursive: true });
      knownPaths.push(project);
      handlers.get('git:watchProject')!({}, worktree);
      knownPaths.length = 0;

      expect(() => handlers.get('git:getStatus')!({}, worktree)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes a watched root reached through a link', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      const project = path.join(root, 'project');
      const worktree = path.join(project, '.wt', 'w1');
      fs.mkdirSync(worktree, { recursive: true });
      const alias = path.join(root, 'alias');
      fs.symlinkSync(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');

      knownPaths.push(project);
      handlers.get('git:watchProject')!({}, worktree);
      knownPaths.length = 0;

      // Same directory, different spelling: the gate compares canonical paths,
      // so the alias resolves to the registered root instead of counting as an
      // unregistered cwd.
      expect(() => handlers.get('git:getStatus')!({}, alias)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a git file path that escapes the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      knownPaths.push(root);
      expect(() => handlers.get('git:getDiff')!({}, root, '../escape.txt', 'staged'))
        .toThrow(/escapes the project/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a git file path that resolves to the root itself', async () => {
    const gitStatus = await import('./git-status');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      knownPaths.push(root);
      // P1-17: '' resolves (path.resolve(root,'')===root) and `isWithin`
      // accepts the root itself, so the old gate let an untracked "discard"
      // of the whole tree reach gitDiscardFile's recursive rm. The root
      // spelling is now refused at requireGitFilePath, for every git file
      // channel — a single-file op is never the tree root.
      for (const target of ['', '.', '.wt/..']) {
        await expect(handlers.get('git:discardFile')!({}, root, target, 'untracked'))
          .rejects.toThrow(/not the project root/);
      }
      expect(vi.mocked(gitStatus.gitDiscardFile)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to make a CLI config dir a git-capable watched root', async () => {
    const gitStatus = await import('./git-status');
    const gitWatcher = await import('./git-watcher');
    // The real home: isAllowedReadPath matches ~/.claude by spelling, and the
    // P1-17 chain started exactly there — config dirs ARE read-allowed, which
    // is what made watchProject a route into requireGitRoot's admit set.
    const claudeDir = path.join(os.homedir(), '.claude');
    handlers.get('git:watchProject')!({}, claudeDir);
    expect(vi.mocked(gitWatcher.startGitWatcher)).not.toHaveBeenCalled();
    // Today the watched root becomes git-capable; after the fix the config
    // tree never joins gitWatchedRoots, so git handlers reject it.
    expect(() => handlers.get('git:getStatus')!({}, claudeDir)).toThrow(/not within a known project/);
    expect(vi.mocked(gitStatus.getGitStatus)).not.toHaveBeenCalled();
  });
});

// P1-12: the gate's root set is main-owned. The store suite proves the store
// validates every writer; this pins the handler wiring: store:save hands the
// payload to the store verifier and never feeds the gate, so a payload
// inventing a root cannot open fs/git channels outside the known set.
describe('store:save cannot widen the root set', () => {
  it('routes the renderer payload through the store verifier, not the gate', async () => {
    const store = await import('./store');
    knownPaths.length = 0;
    const poison = { projects: [{ id: 'x', path: 'C:\\' }], preferences: {} };
    handlers.get('store:save')!({}, poison);
    expect(vi.mocked(store.saveState)).toHaveBeenCalledWith(poison);
    expect(knownPaths).not.toContain('C:\\');
    await expect(handlers.get('fs:readFile')!({}, 'C:\\')).resolves.toEqual({ ok: false, reason: 'error' });
  });
});

// S1-03: the sync quit flush must carry the SAME verifier as store:save —
// a payload inventing a root may not widen the gate through the new channel,
// and it must reach saveStateSync (the synchronous writer), not saveState.
describe('store:save-sync (S1-03)', () => {
  it('routes through the store verifier into saveStateSync and answers the sync send', async () => {
    const store = await import('./store');
    knownPaths.length = 0;
    const poison = { projects: [{ id: 'x', path: 'C:\\' }], preferences: {} };
    const event = { returnValue: false as unknown };
    handlers.get('store:save-sync')!(event, poison);
    expect(vi.mocked(store.saveStateSync)).toHaveBeenCalledWith(poison);
    expect(vi.mocked(store.saveState)).not.toHaveBeenCalled();
    expect(event.returnValue).toBe(true);
    expect(knownPaths).not.toContain('C:\\');
    await expect(handlers.get('fs:readFile')!({}, 'C:\\')).resolves.toEqual({ ok: false, reason: 'error' });
  });

  // SEC-02: the channel is an `ipcMain.on` (sendSync) body, so a throw is a
  // fatal main-process exception, not a rejected invoke. The wrap answers the
  // renderer's best-effort quit flush with `false` and main keeps running.
  it('answers false without throwing when the sync write fails', async () => {
    const store = await import('./store');
    vi.mocked(store.saveStateSync).mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    const event = { returnValue: undefined as unknown };
    expect(() => handlers.get('store:save-sync')!(event, { projects: [], preferences: {} })).not.toThrow();
    expect(event.returnValue).toBe(false);
  });
});

// SA-P2-4: the store:save payload was unvalidated — gate-root validation
// covered `projects[].path` only, so `preferences` reached disk verbatim and
// an injected unknown key re-hydrated into every consumer on the next boot.
describe('store:save preferences allowlist (SA-P2-4)', () => {
  it('drops an unknown preferences key before it reaches the store', async () => {
    const store = await import('./store');
    handlers.get('store:save')!({}, {
      projects: [],
      preferences: { theme: 'dark', injectedKey: '<script>' },
    } as never);
    const passed = vi.mocked(store.saveState).mock.calls[0][0];
    expect(passed.preferences).not.toHaveProperty('injectedKey');
  });

  it('keeps every known preferences key', async () => {
    const store = await import('./store');
    handlers.get('store:save')!({}, {
      projects: [],
      preferences: { theme: 'light', zoomFactor: 1.25, locale: 'zh-CN', keybindings: { 'a': 'b' } },
    } as never);
    expect(vi.mocked(store.saveState).mock.calls[0][0].preferences).toEqual({
      theme: 'light', zoomFactor: 1.25, locale: 'zh-CN', keybindings: { 'a': 'b' },
    });
  });

  // The store's graft (S1-02/SA-P1-1) runs inside saveState, AFTER this
  // filter, and overwrites the main-owned keys with the authoritative cache —
  // so the filter must pass them through untouched. The graft itself is pinned
  // by store.test.ts 'grafts main-owned statusLine-consent keys onto every
  // write (S1-02)'.
  it('passes the main-owned consent keys through for the store graft', async () => {
    const store = await import('./store');
    handlers.get('store:save')!({}, {
      projects: [],
      preferences: { statusLineConsent: 'granted', chromeImport: { importedAt: 1 } },
    } as never);
    expect(vi.mocked(store.saveState).mock.calls[0][0].preferences).toEqual({
      statusLineConsent: 'granted', chromeImport: { importedAt: 1 },
    });
  });

  it('applies the same allowlist on the synchronous quit flush', async () => {
    const store = await import('./store');
    const event = { returnValue: undefined as unknown };
    handlers.get('store:save-sync')!(event, {
      projects: [],
      preferences: { theme: 'dark', injectedKey: 1 },
    } as never);
    const passed = vi.mocked(store.saveStateSync).mock.calls[0][0];
    expect(passed.preferences).not.toHaveProperty('injectedKey');
    expect(passed.preferences).toMatchObject({ theme: 'dark' });
  });
});

describe('readiness/github git-executing handlers share the root gate', () => {
  it('blocks a cwd the renderer invented before any git runs', async () => {
    // Both handlers shell out to git in the named cwd (`git ls-files`,
    // `git remote get-url`) - the same sink the 13 git:* handlers gate.
    // The analyzer/detectRepo stubs are the autoStub proxies; importing them
    // statically is what lets these assertions see the calls.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      const outside = path.join(root, 'invented');
      fs.mkdirSync(outside);

      // S4-03: readiness:analyze is async now — the gate throw lands on
      // the invoke promise, the renderer-visible rejection over IPC.
      await expect(handlers.get('readiness:analyze')!({}, outside))
        .rejects.toThrow(/not within a known project/);
      expect(vi.mocked(analyzeReadiness)).not.toHaveBeenCalled();
      expect(vi.mocked(detectRepo)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs them for a known project, on the resolved path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      knownPaths.push(root);

      await handlers.get('readiness:analyze')!({}, root, ['codex']);
      await handlers.get('github:detectRepo')!({}, root);

      expect(vi.mocked(analyzeReadiness)).toHaveBeenCalledWith(root, ['codex']);
      expect(vi.mocked(detectRepo)).toHaveBeenCalledWith(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('probes provider availability through the async twin before the analyzer (S4-03)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-git-gate-'));
    try {
      knownPaths.push(root);
      const order: string[] = [];
      vi.mocked(getAvailableProviderIdsAsync).mockImplementationOnce(async () => { order.push('probe'); return []; });
      vi.mocked(analyzeReadiness).mockImplementationOnce(async () => { order.push('analyze'); return {} as never; });
      await handlers.get('readiness:analyze')!({}, root);
      expect(order).toEqual(['probe', 'analyze']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});

const OUTSIDE_HOME = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

describe('pty launch path gate (P1-15)', () => {
  it('refuses a cwd outside every known project before any side effect', async () => {
    // pty:create is the one process-launch channel: it runs the provider
    // CLI with renderer-supplied flags in a renderer-supplied cwd. The gate
    // must fire before provider hooks, transcript sync, and the spawn.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-pty-gate-'));
    try {
      const invented = path.join(root, 'invented');
      fs.mkdirSync(invented);
      await handlers.get('pty:create')!({}, 'ui-1', invented, null, false, '', 'pi');
      expect(mockSpawnPty).not.toHaveBeenCalled();
      expect(provider.onSessionStarted).not.toHaveBeenCalled();
      expect(mockRegisterSync).not.toHaveBeenCalled();
      // Channel contract: the reason lands in the pane via pty:data and the
      // exit carries the spawn-rejected sentinel, so the renderer keeps the
      // pane open instead of archiving a crash.
      expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:data', 'ui-1', expect.stringContaining('not a known project'));
      expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a configDir that is not a managed profile dir', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValue(false);
    await create('ui-1', null, { configDir: '/home/attacker/.claude' });
    expect(mockSpawnPty).not.toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:data', 'ui-1', expect.stringContaining('managed profile'));
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
  });

  it('spawns for a known-project cwd with a managed configDir', async () => {
    await create('ui-1', null, { configDir: '/profiles/work' });
    expect(mockSpawnPty).toHaveBeenCalled();
  });

  it('gates pty:createShell cwd the same way', async () => {
    const ptyManager = await import('./pty-manager');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-pty-gate-'));
    try {
      const invented = path.join(root, 'invented');
      fs.mkdirSync(invented);
      handlers.get('pty:createShell')!({}, 'sh-1', invented);
      expect(ptyManager.spawnShellPty).not.toHaveBeenCalled();

      knownPaths.push('/proj');
      handlers.get('pty:createShell')!({}, 'sh-1', '/proj');
      expect(ptyManager.spawnShellPty).toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fs:listDirs home gate (P1-19)', () => {
  it('returns nothing for a home-outside, root-outside directory when the confirm is denied', async () => {
    // dialog.showMessageBox resolves response 0 (Cancel) by default.
    const dirs = await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME);
    expect(dirs).toEqual([]);
    expect(dialog.showMessageBox).toHaveBeenCalled();
  });

  it('enumerates a home-outside directory only after an explicit confirm', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    const dirs = (await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME)) as string[];
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('lists a home-tree directory with no confirm (pre-project picker flow)', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-listdirs-'));
    try {
      fs.mkdirSync(path.join(homeDir, 'proj'));
      const dirs = await handlers.get('fs:listDirs')!({}, homeDir);
      expect(dirs).toEqual([path.join(homeDir, 'proj')]);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  // C2M-10 + CI-09: the debounced keystroke burst fires concurrent listDirs
  // for one directory while the first confirm is still open, and every
  // caller used to stack its own native modal on top of it. One dialog,
  // answered by every waiter.
  it('shares one in-flight confirm across concurrent requests for the same dir', async () => {
    let release!: (value: { response: number }) => void;
    // mockImplementationOnce: the shared in-flight confirm opens exactly one
    // dialog, and the default Cancel answer survives for later tests.
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(
      () => new Promise<Electron.MessageBoxReturnValue>((resolve) => { release = resolve as (v: { response: number }) => void; }),
    );
    const first = handlers.get('fs:listDirs')!({}, OUTSIDE_HOME) as Promise<string[]>;
    const second = handlers.get('fs:listDirs')!({}, OUTSIDE_HOME) as Promise<string[]>;
    const third = handlers.get('fs:listDirs')!({}, OUTSIDE_HOME) as Promise<string[]>;
    release({ response: 1 });
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a.length).toBeGreaterThan(0);
  });

  // SEC-05: the enumeration follows the canonical target, so the dialog must
  // name that target — a link spelled `~/safe-dir` pointing at a directory
  // outside home must not be confirmed on the link's friendly name.
  it('names the canonical target in the confirm, not the link spelling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-consent-'));
    try {
      // The tree lives under the real tmpdir, i.e. INSIDE the real home, so
      // point home (the suite's os.homedir override) at a sibling: the link
      // is then home-outside and the confirm fires.
      const fakeHome = path.join(root, 'home');
      fs.mkdirSync(fakeHome);
      osHomeOverride.value = fakeHome;
      const target = path.join(root, 'real-target');
      fs.mkdirSync(target);
      const link = path.join(root, 'friendly-name');
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      await handlers.get('fs:listDirs')!({}, link);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      const args = vi.mocked(dialog.showMessageBox).mock.calls[0] as unknown as unknown[];
      const options = args[args.length - 1] as { message: string };
      // The listing walks the canonical target; the dialog must name it.
      expect(options.message).toContain(fs.realpathSync(target));
      expect(options.message).not.toContain('friendly-name');
    } finally {
      osHomeOverride.value = '';
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fs:isDirectory home gate (P2-38)', () => {
  it('asks for a home-outside directory and reports false on Cancel', async () => {
    // dialog.showMessageBox resolves response 0 (Cancel) by default.
    // The old silent-false oracle (fs:exists denies, no dialog) is gone:
    // home-outside now gets the same explicit confirm fs:listDirs uses.
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalled();
  });

  it('reports the honest stat for a home-outside directory after an explicit confirm', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    // OUTSIDE_HOME is a real existing directory (C:\\Windows / /etc), so
    // the post-confirm answer is the honest stat: true, not the old deny.
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(true);
  });

  it('caches the confirm per directory — repeats answer from the cache with one dialog', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(true);
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('reports true for a home-tree directory with no confirm (pre-project add flow)', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-isdir-'));
    try {
      await expect(handlers.get('fs:isDirectory')!({}, homeDir)).resolves.toBe(true);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// The New Project picker's native selection (fs:browseDirectory) IS the
// consent: the picked dir is recorded in the home-outside answer cache, so
// the post-pick label probes for that dir answer from the cache and never
// pop a second confirm.
describe('fs:browseDirectory pick records consent', () => {
  const pickOutsideHome = () =>
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce(
      { canceled: false, filePaths: [OUTSIDE_HOME] } as never,
    );

  it('a native pick answers a later fs:isDirectory from the cache with no confirm', async () => {
    pickOutsideHome();
    await expect(handlers.get('fs:browseDirectory')!({})).resolves.toBe(OUTSIDE_HOME);
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('a native pick answers a later fs:listDirs from the cache with no confirm', async () => {
    pickOutsideHome();
    await expect(handlers.get('fs:browseDirectory')!({})).resolves.toBe(OUTSIDE_HOME);
    const dirs = (await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME)) as string[];
    expect(dirs.length).toBeGreaterThan(0);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('a canceled pick records nothing — the gate still fires', async () => {
    // The default showOpenDialog mock cancels.
    await expect(handlers.get('fs:browseDirectory')!({})).resolves.toBeNull();
    // Default showMessageBox answer is Cancel (response 0) → the old deny.
    await expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalled();
  });

  /** The options the handler handed the picker. The handler uses the
   *  `showOpenDialog(browserWindow, options)` overload; the module mock is
   *  typed with the 1-arg overload, so the args tuple is read untyped. */
  const lastPickerOptions = (): { defaultPath?: string } => {
    const call = vi.mocked(dialog.showOpenDialog).mock.calls.at(-1) as unknown as unknown[];
    return (call[1] ?? call[0]) as { defaultPath?: string };
  };

  // The picker opens at the preferences' default projects folder: with no
  // defaultPath the native dialog starts wherever the OS last was (Documents
  // on a fresh Windows install, the portal default on Linux), so picking
  // inside `E:\dev` is a walk every single time. A stale preference must not
  // break the picker, so only an EXISTING directory is passed.
  it('opens at the default projects folder when it exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-pick-default-'));
    try {
      vi.mocked(loadState).mockReturnValueOnce(
        { projects: [], preferences: { defaultProjectsFolder: root } } as never,
      );
      await expect(handlers.get('fs:browseDirectory')!({})).resolves.toBeNull();
      expect(lastPickerOptions().defaultPath).toBe(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes no defaultPath for a blank, whitespace or missing preference', async () => {
    for (const configured of ['', '   ', path.join(os.tmpdir(), 'fv-pick-missing-zz')]) {
      vi.mocked(loadState).mockReturnValueOnce(
        { projects: [], preferences: { defaultProjectsFolder: configured } } as never,
      );
      await expect(handlers.get('fs:browseDirectory')!({})).resolves.toBeNull();
      expect(lastPickerOptions().defaultPath).toBeUndefined();
    }
  });
});

// The parent-consent cascade (fs:isDirectory only): a consented dir's
// enumeration (fs:listDirs / the New Project autocomplete) NAMED its
// children, so answering "is child X a directory" asks nothing the parent
// dialog already published — no child dialogs. Cancel never cascades, and
// fs:listDirs keeps asking per dir (contents were never authorized).
describe('fs:isDirectory parent-consent cascade', () => {
  // A child dir that really exists under the home-outside root, on every
  // platform: the first directory entry of C:\\Windows / /etc.
  const existingChildDir = () => {
    const name = fs.readdirSync(OUTSIDE_HOME).find((n) => {
      try { return fs.statSync(path.join(OUTSIDE_HOME, n)).isDirectory(); } catch { return false; }
    });
    if (!name) throw new Error('no child dir under ' + OUTSIDE_HOME);
    return path.join(OUTSIDE_HOME, name);
  };

  it('answers a child from the parent listDirs consent with no child dialog', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME); // the consent burst
    await expect(handlers.get('fs:isDirectory')!({}, existingChildDir())).resolves.toBe(true);
    // Exactly the parent's dialog; the child probe added none.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('a canceled parent does not cascade — the child asks its own confirm', async () => {
    // Default showMessageBox answer is Cancel: the parent's answer caches
    // false, and a Cancel must never auto-answer a child.
    await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    await expect(handlers.get('fs:isDirectory')!({}, existingChildDir())).resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2); // child's own confirm
  });

  it('a consented parent answers a vanished child honestly (false) with no dialog', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME);
    await expect(handlers.get('fs:isDirectory')!({}, path.join(OUTSIDE_HOME, 'finevibe-cascade-missing-zz')))
      .resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('cascade is parent-only: fs:listDirs on the child keeps its own confirm', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME); // parent consented
    const child = existingChildDir();
    // Cancel (default) for the child's own enumeration — listing a listed
    // dir's CONTENTS was never authorized by the parent consent.
    await expect(handlers.get('fs:listDirs')!({}, child)).resolves.toEqual([]);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });
});

describe('fs:unwatchDir gate (P2-30)', () => {
  it('mirrors fs:watchDir: a blocked path never reaches the watcher', async () => {
    const fileWatcher = await import('./file-watcher');
    handlers.get('fs:unwatchDir')!({}, OUTSIDE_HOME);
    expect(fileWatcher.unwatchDir).not.toHaveBeenCalled();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-watch-gate-'));
    try {
      knownPaths.push(root);
      handlers.get('fs:unwatchDir')!({}, root);
      expect(fileWatcher.unwatchDir).toHaveBeenCalledWith(path.resolve(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('session transcript channels: configDir boundary gate (P2-113)', () => {
  it('denies at the boundary: an unallowlisted configDir never reaches a provider scan root', async () => {
    provider.getTranscriptPath = vi.fn(() => null);
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    // PA-25: the main-side handler is sync (ipcMain.handle wraps the return
    // into the renderer's invoke Promise), so a direct call yields the boolean.
    expect(
      handlers.get('session:transcriptExists')!({}, 'claude', 'cli-1', '/proj', '/foreign/dir', undefined),
    ).toBe(false);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
  });
  it('passes an allowlisted configDir to the provider; null path still means absent', async () => {
    provider.getTranscriptPath = vi.fn(() => null);
    // C3A-03: the projectPath gate admits the legit active project.
    knownPaths.push('/proj');
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(true);
    expect(
      handlers.get('session:transcriptExists')!({}, 'claude', 'cli-1', '/proj', '/profiles/work', undefined),
    ).toBe(false);
    expect(isManagedMcpConfigDir).toHaveBeenCalledWith('/profiles/work');
    expect(provider.getTranscriptPath).toHaveBeenCalledWith('cli-1', '/proj', '/profiles/work', undefined);
  });
  it('buildResumeWithPrompt rejects before reading any transcript', async () => {
    provider.getTranscriptPath = vi.fn(() => '/t.jsonl');
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    await expect(
      handlers.get('session:buildResumeWithPrompt')!({}, 'claude', 'cli-1', '/proj', 'S', '/foreign/dir'),
    ).rejects.toThrow('Not a managed profile config dir');
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
  });
  it('session:exportArchive rejects before touching the archive writer', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    await expect(
      handlers.get('session:exportArchive')!({}, 'claude', 'cli-1', '/proj', '/foreign/dir', {} as never, 'zip'),
    ).rejects.toThrow('Not a managed profile config dir');
  });
  it('transcriptExists denies a projectPath outside the known projects', () => {
    provider.getTranscriptPath = vi.fn(() => '/t.jsonl');
    // C3A-03: the provider:getConfig project gate; deny, not fail-open.
    expect(
      handlers.get('session:transcriptExists')!({}, 'claude', 'cli-1', '/foreign/proj', undefined, undefined),
    ).toBe(false);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
  });
  it('buildResumeWithPrompt rejects a projectPath outside the known projects', async () => {
    provider.getTranscriptPath = vi.fn(() => '/t.jsonl');
    await expect(
      handlers.get('session:buildResumeWithPrompt')!({}, 'claude', 'cli-1', '/foreign/proj', 'S'),
    ).rejects.toThrow(/not within a known project/);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
  });
  it('session:exportArchive rejects a projectPath outside the known projects', async () => {
    await expect(
      handlers.get('session:exportArchive')!({}, 'claude', 'cli-1', '/foreign/proj', undefined, {} as never, 'zip'),
    ).rejects.toThrow(/not within a known project/);
  });
});

// SEC-03: provider:getConfig took both paths from the renderer verbatim and
// handed them to provider.getConfig — the same two gates every other
// config-reading channel enforces (managed profile dir, known project).
describe('provider:getConfig path gates (SEC-03)', () => {
  beforeEach(() => {
    provider.getConfig = vi.fn(async () => ({ servers: ['s'] })) as unknown as typeof provider.getConfig;
  });

  it('rejects an unallowlisted configDir before the provider is consulted', async () => {
    knownPaths.push('/proj');
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    await expect(handlers.get('provider:getConfig')!({}, 'claude', '/proj', '/foreign/dir'))
      .rejects.toThrow('Not a managed profile config dir');
    expect(provider.getConfig).not.toHaveBeenCalled();
  });

  it('rejects a projectPath outside the known projects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-getconfig-'));
    try {
      knownPaths.length = 0;
      await expect(handlers.get('provider:getConfig')!({}, 'claude', root))
        .rejects.toThrow(/not within a known project/);
      expect(provider.getConfig).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes the legit active project plus a pinned profile dir through', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-getconfig-'));
    try {
      knownPaths.push(root);
      await expect(handlers.get('provider:getConfig')!({}, 'pi', root, '/profiles/work'))
        .resolves.toEqual({ servers: ['s'] });
      expect(provider.getConfig).toHaveBeenCalledWith(root, '/profiles/work');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
describe('pty:create provider hooks', () => {
  it('a fresh session registers for cli-session-id discovery', async () => {
    await create('ui-1', null);
    expect(calls).toEqual(['started']);
    expect(mockRegisterSync).not.toHaveBeenCalled();
  });

  it('a resumed session mirrors the transcript AND re-attaches the provider watcher', async () => {
    await create('ui-1', 'cli-1', { isResume: true, providerId: 'pi', configDir: '/profiles/work' });
    // Without onSessionResumed a resumed session never joins the Pi/OMP
    // sessions-tree watcher, so a later /clear is never re-adopted.
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-1', 'pi', 'cli-1', '/proj', '/profiles/work', { sessionDir: expect.stringContaining('pi-sessions') });
    expect(provider.onSessionResumed).toHaveBeenCalledWith('ui-1', '/proj', fakeWin, '/profiles/work', 'cli-1');
    expect(calls).toEqual(['resumed']);
    expect(provider.onSessionStarted).not.toHaveBeenCalled();
  });

  it('a resumed Pi-Bolt session seeds the transcript sync on its own pi-bolt-sessions dir', async () => {
    await create('ui-1', 'cli-1', { isResume: true, providerId: 'pi-bolt', configDir: '/profiles/work' });
    // Pi-Bolt owns a third launch base — the seed must name pi-bolt-sessions,
    // not the Pi/OMP dirs (launch-session-dir.ts:44-46).
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-1', 'pi-bolt', 'cli-1', '/proj', '/profiles/work', { sessionDir: expect.stringContaining('pi-bolt-sessions') });
    expect(provider.onSessionResumed).toHaveBeenCalledWith('ui-1', '/proj', fakeWin, '/profiles/work', 'cli-1');
    expect(calls).toEqual(['resumed']);
  });

  it('a provider with no resume hook still spawns', async () => {
    delete provider.onSessionResumed;
    await create('ui-1', 'cli-1', { isResume: true });
    expect(mockRegisterSync).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('session:syncRestored', () => {
  const syncRestored = (sessions: unknown[]) =>
    handlers.get('session:syncRestored')!({}, sessions);

  it('mirrors a known-id session title-only and registers it for forwarding', () => {
    mockRegisterSync.mockReturnValue(true);
    syncRestored([
      { sessionId: 'ui-1', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z' },
    ]);
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true, sessionDir: expect.stringContaining('omp-sessions') });
    expect(mockRegisterSession).toHaveBeenCalledWith('ui-1');
  });

  it('mirrors a Pi-Bolt session title-only against its own pi-bolt-sessions dir', () => {
    mockRegisterSync.mockReturnValue(true);
    syncRestored([
      { sessionId: 'ui-pb', providerId: 'pi-bolt', cliSessionId: 'cli-pb', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z', configDir: '/profiles/work' },
    ]);
    // Third restore arm (besides pi/omp): the titleOnly registration names the
    // Pi-Bolt launch base, so a restored tab polls its own transcripts.
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-pb', 'pi-bolt', 'cli-pb', '/proj', '/profiles/work', { titleOnly: true, sessionDir: expect.stringContaining('pi-bolt-sessions') });
    expect(mockRegisterSession).toHaveBeenCalledWith('ui-pb');
  });

  it('leaves a null-id session unresolved: no title mirror, no recovery', () => {
    mockRegisterSync.mockReturnValue(true);
    // A session whose cliSessionId was never persisted is left unresolved:
    // no title mirror, no recovery, no registration.
    syncRestored([
      { sessionId: 'ui-2', providerId: 'omp', cliSessionId: null, cwd: '/proj', createdAt: '2026-09-30T10:23:20.000Z' },
    ]);
    expect(mockRegisterSync).not.toHaveBeenCalled();
    expect(mockRegisterSession).not.toHaveBeenCalled();
  });

  it('skips a malformed record without aborting the valid one after it', () => {
    mockRegisterSync.mockReturnValue(true);
    syncRestored([
      { sessionId: 'bad', providerId: 'omp' }, // missing cliSessionId, cwd, createdAt
      { sessionId: 'ui-1', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z' },
    ]);
    expect(mockRegisterSync).toHaveBeenCalledTimes(1);
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true, sessionDir: expect.stringContaining('omp-sessions') });
  });

  it('skips a record with a non-finite creation timestamp', () => {
    mockRegisterSync.mockReturnValue(true);
    syncRestored([
      { sessionId: 'ui-1', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: 'not-a-date' },
    ]);
    expect(mockRegisterSync).not.toHaveBeenCalled();
  });

  it('skips an unknown provider id without aborting the batch', () => {
    // The real registerTranscriptSync calls getProvider, which throws for an
    // unknown id; mirror that so the handler's per-record guard is exercised.
    mockRegisterSync.mockImplementation((...args) => {
      if (args[1] === 'bogus') throw new Error('Unknown CLI provider: bogus');
      return true;
    });
    syncRestored([
      { sessionId: 'ui-x', providerId: 'bogus', cliSessionId: 'cli-x', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z' },
      { sessionId: 'ui-1', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z' },
    ]);
    // The valid record is still processed; the bogus one is dropped (no registration).
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true, sessionDir: expect.stringContaining('omp-sessions') });
    expect(mockRegisterSession).toHaveBeenCalledTimes(1);
    expect(mockRegisterSession).toHaveBeenCalledWith('ui-1');
  });

  it('registers the same copied CLI id in two profiles independently', () => {
    mockRegisterSync.mockReturnValue(true);
    syncRestored([
      { sessionId: 'ui-a', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z', configDir: '/profiles/a' },
      { sessionId: 'ui-b', providerId: 'omp', cliSessionId: 'cli-1', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z', configDir: '/profiles/b' },
    ]);
    expect(mockRegisterSync).toHaveBeenCalledTimes(2);
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-a', 'omp', 'cli-1', '/proj', '/profiles/a', { titleOnly: true, sessionDir: expect.stringContaining('omp-sessions') });
    expect(mockRegisterSync).toHaveBeenCalledWith('ui-b', 'omp', 'cli-1', '/proj', '/profiles/b', { titleOnly: true, sessionDir: expect.stringContaining('omp-sessions') });
  });

  it('skips registerSession when the provider polls neither title nor status', () => {
    mockRegisterSync.mockReturnValue(false);
    syncRestored([
      { sessionId: 'ui-3', providerId: 'omp', cliSessionId: 'cli-3', cwd: '/proj', createdAt: '2026-09-30T10:00:00.000Z' },
    ]);
    expect(mockRegisterSession).not.toHaveBeenCalled();
  });
});

describe('session:release', () => {
  it('unregisters the sync and cleans the status files', () => {
    const release = handlers.get('session:release')!;
    release({}, 'ui-1');
    expect(mockUnregisterSync).toHaveBeenCalledWith('ui-1');
    expect(cleanupSessionStatus).toHaveBeenCalledWith('ui-1');
  });
});

// P5 (R4): one `webContents.send('pty:data')` per node-pty chunk meant a
// paste echo arrived as a storm of IPCs — the P0 probe measured a 1 MB
// paste returning through ConPTY as 1,383 chunks (median 396 B;
// docs/performance.md). Main now coalesces per session: ≤ 4 ms window,
// ≤ 64 KiB per message, immediate ship when one chunk fills the budget
// (the window degrades to a no-op, never an added delay), and a flush
// before `pty:exit` so the renderer never sees exit-before-data.
describe('pty:data coalescing (P5)', () => {
  /** The data callback spawnPty was handed (positional arg 9). */
  function dataCallback(): (data: string) => void {
    return mockSpawnPty.mock.calls[0][9] as (data: string) => void;
  }

  function dataSends(): string[] {
    return (fakeWin.webContents.send.mock.calls as unknown as Array<[string, string, string]>)
      .filter((c) => c[0] === 'pty:data')
      .map((c) => c[2]);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins chunks of one window into a single pty:data message', async () => {
    await create('ui-1', null);
    const push = dataCallback();

    push('hello ');
    push('world');
    expect(fakeWin.webContents.send).not.toHaveBeenCalledWith('pty:data', 'ui-1', 'hello world');

    vi.advanceTimersByTime(4);

    expect(dataSends()).toEqual(['hello world']);
  });

  it('ships a chunk that fills the 64 KiB budget immediately — no window delay', async () => {
    await create('ui-1', null);
    const push = dataCallback();

    push('x'.repeat(64 * 1024));

    expect(dataSends()).toEqual(['x'.repeat(64 * 1024)]);
    vi.advanceTimersByTime(10);
    expect(dataSends()).toHaveLength(1);
  });

  it('flushes buffered data BEFORE the pty:exit message', async () => {
    await create('ui-1', 'cli-1', { isResume: true });
    fakeWin.webContents.send.mockClear();
    const push = dataCallback();

    push('last words');
    exitCallback()(0);

    const channels = (fakeWin.webContents.send.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(channels).toEqual(['pty:data', 'pty:exit']);
    expect(dataSends()).toEqual(['last words']);
  });

  it('keeps sessions independent', async () => {
    await create('ui-1', null);
    await create('ui-2', null);
    const push1 = mockSpawnPty.mock.calls[0][9] as (d: string) => void;
    const push2 = mockSpawnPty.mock.calls[1][9] as (d: string) => void;

    push1('a');
    push2('b');
    vi.advanceTimersByTime(4);

    const sends = fakeWin.webContents.send.mock.calls as unknown as Array<[string, string, string]>;
    expect(sends.filter((c) => c[0] === 'pty:data').map((c) => [c[1], c[2]]))
      .toEqual([['ui-1', 'a'], ['ui-2', 'b']]);
  });

  // C2M-04: a re-spawn under the SAME sessionId (tab restore over a live id,
  // pty-manager's replace) registers a new outbox. The replaced process's
  // exit used to flush-and-delete by session id, so the new pane lost its
  // exit flush and the renderer tore the pane down before its last data.
  it('a re-spawn keeps its own outbox when the replaced process exits', async () => {
    await create('ui-1', null);
    await create('ui-1', null);
    const oldPush = mockSpawnPty.mock.calls[0][9] as (d: string) => void;
    const newPush = mockSpawnPty.mock.calls[1][9] as (d: string) => void;
    const oldExit = mockSpawnPty.mock.calls[0][10] as ExitCallback;
    const newExit = mockSpawnPty.mock.calls[1][10] as ExitCallback;

    oldPush('old words');
    oldExit(0);
    // The guard leaves the superseded sink alone, so its own window still
    // ships its buffer — the guard loses nothing.
    vi.advanceTimersByTime(4);
    expect(dataSends()).toEqual(['old words']);
    fakeWin.webContents.send.mockClear();

    newPush('new words');
    newExit(0);
    const channels = (fakeWin.webContents.send.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(channels).toEqual(['pty:data', 'pty:exit']);
    expect(dataSends()).toEqual(['new words']);
  });
});

describe('pty exit teardown ordering', () => {
  it('unregisters the sync on a real exit', async () => {
    await create('ui-1', 'cli-1', { isResume: true });
    // The resumed spawn above legitimately pushed 'resumed' during setup;
    // this test is about the exit callback's ordering only.
    calls.length = 0;
    exitCallback()(0);
    expect(calls).toEqual(['unregister', 'exited']);
  });
});

describe('pty:exit crash reason', () => {
  it('sends the transcript reason on a non-zero exit when the sync resolved a path', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'unhandled_rejection', kind: 'fatal' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(1);
    expect(provider.readSessionExitReason).toHaveBeenCalledWith('/sessions/dir-a/2026.jsonl');
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, 'unhandled_rejection', undefined);
  });

  it('sends the spawn-rejected sentinel verbatim when no PTY ever existed', async () => {
    // A launch rejected before the PTY spawn writes its reason into the pane
    // via pty:data; the renderer must see a sentinel, not a crash reason, or
    // it destroys that pane and archives a crash for a session that never ran.
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'unhandled_rejection', kind: 'fatal' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    calls.length = 0;
    exitCallback()(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
    // No transcript can exist for a session that never spawned — the whole
    // exit-reason read is skipped, so a stale marker cannot be blamed on it.
    expect(provider.readSessionExitReason).not.toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
    expect(calls).toEqual(['unregister', 'exited']);
  });

  it('keeps reporting a real exit code 1 as the crash reason the renderer archives', async () => {
    mockGetSyncedPath.mockReturnValue(null);
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(1);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, 'exited with code 1', undefined);
  });

  it('falls back to the exit code when no transcript path is resolved', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'dispose', kind: 'normal' }));
    mockGetSyncedPath.mockReturnValue(null);
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(2);
    expect(provider.readSessionExitReason).not.toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 2, undefined, 'exited with code 2', undefined);
  });

  it('falls back to the exit code when the provider has no reason reader', async () => {
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(1);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 1, undefined, 'exited with code 1', undefined);
  });

  it('falls back to the exit code when the reason read throws', async () => {
    provider.readSessionExitReason = vi.fn(() => { throw new Error('read failed'); });
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(3);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 3, undefined, 'exited with code 3', undefined);
  });

  it('sends no exit reason on a clean exit', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'dispose', kind: 'normal' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(0);
    expect(provider.readSessionExitReason).toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 0, undefined, undefined, undefined);
  });

  it('reports a fatal transcript reason even when the PTY exit code is zero', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'unhandled_rejection', kind: 'fatal' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(0, undefined, 2028);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 0, undefined, 'unhandled_rejection', 2028);
  });

  it('keeps a signal exit distinct from a fatal rejection', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'sighup', kind: 'signal' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(0, 1, 2028);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 0, 1, 'sighup', 2028);
  });

  it('does not reuse a fatal marker from before this launch', async () => {
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'unhandled_rejection', kind: 'fatal', timestamp: '2020-01-01T00:00:00.000Z' }));
    mockGetSyncedPath.mockReturnValue('/sessions/dir-a/2026.jsonl');
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(0);
    expect(fakeWin.webContents.send).toHaveBeenCalledWith('pty:exit', 'ui-1', 0, undefined, undefined, undefined);
  });

  it('uses the provider lookup if the watcher has not resolved the transcript yet', async () => {
    mockGetSyncedPath.mockReturnValue(null);
    provider.getTranscriptPath = vi.fn(() => '/sessions/dir-a/2026.jsonl');
    provider.readSessionExitReason = vi.fn(() => ({ reason: 'unhandled_rejection', kind: 'fatal' }));
    await create('ui-1', 'cli-1', { isResume: true });
    exitCallback()(1);
    expect(provider.getTranscriptPath).toHaveBeenCalled();
    expect(provider.readSessionExitReason).toHaveBeenCalledWith('/sessions/dir-a/2026.jsonl');
  });
});

describe('failed spawn teardown', () => {
  it('unregisters the sync registered before spawnPty', async () => {
    mockSpawnPty.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(create('ui-1', 'cli-1', { isResume: true })).rejects.toThrow('spawn failed');
    // The exit callback was never installed, so nothing else would clean this up.
    expect(mockUnregisterSync).toHaveBeenCalledWith('ui-1');
    expect(provider.onSessionExited).toHaveBeenCalledWith('ui-1');
  });

  it('still unwinds a fresh session whose spawn failed', async () => {
    mockSpawnPty.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(create('ui-1', null)).rejects.toThrow('spawn failed');
    expect(provider.onSessionExited).toHaveBeenCalledWith('ui-1');
    expect(mockUnregisterSync).toHaveBeenCalledWith('ui-1');
  });
});


it('cancels superseded IPC searches, palette cancellation and window destruction', async () => {
  const sender = new EventEmitter();
  const signals: AbortSignal[] = [];
  const complete: Array<() => void> = [];
  vi.mocked(searchSessions).mockImplementation((_query, signal) => {
    signals.push(signal!);
    return new Promise(resolve => complete.push(() => resolve([])));
  });
  const handler = handlers.get('session:deepSearch')!;
  const first = handler({sender}, 'first');
  const second = handler({sender}, 'second');
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  handlers.get('session:cancelDeepSearch')!({sender});
  expect(signals[1].aborted).toBe(true);
  const third = handler({sender}, 'third');
  sender.emit('destroyed');
  expect(signals[2].aborted).toBe(true);
  for (const resolve of complete) resolve();
  await Promise.all([first, second, third]);
  expect(sender.listenerCount('destroyed')).toBe(0);
});

describe('store:startup-prefs', () => {
  /** Call the sync channel the way `ipcRenderer.sendSync` does and read the reply. */
  function reply(preferences: Record<string, unknown>): unknown {
    // `projects` is populated so a payload that leaked the whole state fails.
    vi.mocked(loadState).mockReturnValueOnce({ projects: [{ id: 'p' }], preferences } as never);
    const event: { returnValue?: unknown } = {};
    handlers.get('store:startup-prefs')!(event);
    return event.returnValue;
  }

  it('serves the theme/zoom slice only, so startup never clones the full state', () => {
    expect(reply({ theme: 'light', zoomFactor: 1.25 })).toEqual({ theme: 'light', zoomFactor: 1.25 });
  });

  it('reports never-saved preferences as null so the renderer keeps its defaults', () => {
    expect(reply({})).toEqual({ theme: null, zoomFactor: null });
  });
});

// The main-read paste route (context menu, Windows Ctrl+V): a copied file
// reaches main as one of four clipboard formats, and each decoder has a
// layout the OS fixes in stone.
describe('clipboard:readForPaste file lists', () => {

  // clearAllMocks keeps per-test mockImplementation; restore each test's
  // clipboard to the mock's defaults so the next read starts on an empty clipboard.
  afterEach(() => {
    platformState.os = 'win32';
    for (const fn of [clipboard.readBuffer, clipboard.readText, clipboard.readHTML, clipboard.read, clipboard.availableFormats]) {
      vi.mocked(fn as (...args: never[]) => unknown).mockReset();
    }
  });
  function formatsWith(...names: string[]) {
    vi.mocked(clipboard.availableFormats).mockReturnValue(names);
  }

  function bufferFor(format: string, build: () => Buffer) {
    vi.mocked(clipboard.readBuffer).mockImplementation((fmt: string) => {
      if (fmt === format) return build();
      throw new Error(`${fmt} not on clipboard`);
    });
  }

  // DROPFILES header: pFiles @0, pt @4-11, fWide @12; names follow at pFiles.
  function dropfiles(names: string, wide: boolean, headerSize = 20): Buffer {
    const body = Buffer.from(names, wide ? 'utf16le' : 'latin1');
    const buf = Buffer.alloc(headerSize + body.length);
    buf.writeUInt32LE(headerSize, 0);
    buf.writeUInt32LE(wide ? 1 : 0, 12);
    body.copy(buf, headerSize);
    return buf;
  }

  async function readPaste(): Promise<ClipboardPastePayload> {
    return await handlers.get('clipboard:readForPaste')!({}) as never;
  }

  // The CF_HDROP/FileNameW decoders emit Windows paths and the handler's
  // absolute-path filter is the running OS's `path.isAbsolute`, so these
  // layouts can only validate end to end on Windows.
  it.runIf(process.platform === 'win32')('reads Explorer copies from CF_HDROP with the wide flag at offset 12', async () => {
    // fWide lives at offset 12; offset 16 is fNoCompact (0 for Explorer).
    // Reading fNoCompact decoded the UTF-16LE names as latin1, and every path
    // collapsed to single characters that the absolute-path filter dropped.
    formatsWith('FileNameW', 'CF_HDROP', 'text/plain');
    bufferFor('CF_HDROP', () => dropfiles('C:\\repo\\report.pdf\0C:\\repo\\data.csv\0\0', true));
    // Explorer echoes the file name as clipboard text; files must still win.
    vi.mocked(clipboard.readText).mockReturnValue('report.pdf');

    const payload = await readPaste();
    expect(payload.files).toEqual(['C:\\repo\\report.pdf', 'C:\\repo\\data.csv']);
    expect(payload.hasContent).toBe(true);
  });

  it.runIf(process.platform === 'win32')('reads pre-wide CF_HDROP senders through the single-byte decode', async () => {
    formatsWith('CF_HDROP');
    bufferFor('CF_HDROP', () => dropfiles('D:\\notes\\a.txt\0\0', false));

    expect((await readPaste()).files).toEqual(['D:\\notes\\a.txt']);
  });

  it.runIf(process.platform === 'win32')('reads browser copies from FileNameW', async () => {
    formatsWith('FileNameW');
    bufferFor('FileNameW', () => Buffer.from('C:\\tmp\\shot.png\0C:\\tmp\\clip.mp4\0\0', 'utf16le'));

    expect((await readPaste()).files).toEqual(['C:\\tmp\\shot.png', 'C:\\tmp\\clip.mp4']);
  });

  it('reads Finder copies from the XML plist and decodes entities', async () => {
    platformState.os = 'darwin';
    formatsWith('NSFilenamesPboardType');
    bufferFor('NSFilenamesPboardType', () => Buffer.from(
      '<array><string>/tmp/a &amp; b.txt</string><string>/tmp/caf&#xE9;.md</string></array>',
      'utf8',
    ));

    expect((await readPaste()).files).toEqual(['/tmp/a & b.txt', '/tmp/café.md']);
  });

  it('reads file-manager copies on Linux from text/uri-list, skipping web links', async () => {
    platformState.os = 'linux';
    formatsWith('text/uri-list', 'text/plain');
    const target = '/tmp/report.pdf';
    // A rootless file URL is not absolute on Windows, so build the URL from a
    // path the platform considers absolute; the handler decodes it back.
    const uri = pathToFileURL(target).href;
    vi.mocked(clipboard.read).mockReturnValue(`${uri}\r\nhttps://example.com/x\r\n`);

    expect((await readPaste()).files).toEqual([fileURLToPath(uri)]);
  });

  it.runIf(process.platform === 'win32')('drops relative names and keeps only paths a CLI can read', async () => {
    formatsWith('FileNameW');
    bufferFor('FileNameW', () => Buffer.from('notes.txt\0C:\\repo\\ok.md\0\0', 'utf16le'));

    expect((await readPaste()).files).toEqual(['C:\\repo\\ok.md']);
  });

  it('sends markup source when a copy carries no plain text', async () => {
    formatsWith('text/html');
    vi.mocked(clipboard.readText).mockReturnValue('');
    vi.mocked(clipboard.readHTML).mockReturnValue('<b>notes</b>');

    const payload = await readPaste();
    expect(payload.html).toBe('<b>notes</b>');
  });
});
// P2: one clipboard acquisition per `readForPaste`, probed per platform. A
// plain-text copy used to pay six OpenClipboard cycles (formats, text, plus
// four file-list probes that are meaningless on text, three of them throwing
// and logging). The live formats per OS are from the P0 baseline
// (docs/performance.md): Windows FileNameW (Electron's readBuffer('CF_HDROP')
// answers 0 bytes — Chromium maps the drop list onto text/uri-list), macOS
// NSFilenamesPboardType, Linux text/uri-list (X11; portal-gated on Wayland).
describe('clipboard:readForPaste acquisition gating (P2)', () => {
  afterEach(() => {
    platformState.os = 'win32';
    for (const fn of [clipboard.readBuffer, clipboard.readText, clipboard.readHTML, clipboard.read, clipboard.availableFormats]) {
      vi.mocked(fn as (...args: never[]) => unknown).mockReset();
    }
  });

  function formatsWith(...names: string[]) {
    vi.mocked(clipboard.availableFormats).mockReturnValue(names);
  }

  function bufferFor(format: string, build: () => Buffer) {
    vi.mocked(clipboard.readBuffer).mockImplementation((fmt: string) => {
      if (fmt === format) return build();
      throw new Error(`${fmt} not on clipboard`);
    });
  }

  async function readPaste(): Promise<ClipboardPastePayload> {
    return await handlers.get('clipboard:readForPaste')!({}) as never;
  }

  async function expectPlainTextCost(os: 'win32' | 'darwin' | 'linux'): Promise<void> {
    platformState.os = os;
    formatsWith('text/plain', 'text/html', 'UTF8 String');
    vi.mocked(clipboard.readText).mockReturnValue('hello');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const payload = await readPaste();
      expect(payload.text).toBe('hello');
      expect(payload.hasContent).toBe(true);
      // Two acquisitions: availableFormats + readText. No file probes, no
      // HTML read (text is non-empty), no image read, no thrown probe.
      expect(clipboard.availableFormats).toHaveBeenCalledTimes(1);
      expect(clipboard.readText).toHaveBeenCalledTimes(1);
      expect(clipboard.readBuffer).not.toHaveBeenCalled();
      expect(clipboard.read).not.toHaveBeenCalled();
      expect(clipboard.readHTML).not.toHaveBeenCalled();
      expect(clipboard.readImage).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }

  it('Windows plain-text paste costs 2 clipboard opens (formats, text)', async () => {
    await expectPlainTextCost('win32');
  });

  it('macOS plain-text paste costs 2 clipboard opens (formats, text)', async () => {
    await expectPlainTextCost('darwin');
  });

  it('Linux plain-text paste costs 2 clipboard opens (formats, text)', async () => {
    await expectPlainTextCost('linux');
  });

  it('Linux file-list paste costs 3 opens through text/uri-list only', async () => {
    platformState.os = 'linux';
    formatsWith('text/uri-list', 'text/plain');
    const uri = pathToFileURL('/tmp/report.pdf').href;
    vi.mocked(clipboard.read).mockReturnValue(`${uri}\n`);

    expect((await readPaste()).files).toEqual([fileURLToPath(uri)]);
    // formats, text, uri-list — and nothing else.
    expect(clipboard.read).toHaveBeenCalledTimes(1);
    expect(clipboard.readBuffer).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')('Windows file-list paste reads the live FileNameW branch, never the POSIX formats', async () => {
    platformState.os = 'win32';
    formatsWith('FileNameW', 'text/plain');
    bufferFor('FileNameW', () => Buffer.from('C:\\tmp\\x.png\0\0', 'utf16le'));

    expect((await readPaste()).files).toEqual(['C:\\tmp\\x.png']);
    expect(clipboard.readBuffer).toHaveBeenCalledTimes(1);
    expect(clipboard.readBuffer).toHaveBeenCalledWith('FileNameW');
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('macOS file-list paste reads NSFilenamesPboardType only', async () => {
    platformState.os = 'darwin';
    formatsWith('NSFilenamesPboardType', 'text/plain');
    bufferFor('NSFilenamesPboardType', () => Buffer.from('<array><string>/tmp/a.md</string></array>', 'utf8'));

    expect((await readPaste()).files).toEqual(['/tmp/a.md']);
    expect(clipboard.readBuffer).toHaveBeenCalledTimes(1);
    expect(clipboard.readBuffer).toHaveBeenCalledWith('NSFilenamesPboardType');
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('an empty format list probes nothing and keeps the passthrough shape (Wayland portals)', async () => {
    platformState.os = 'linux';
    // availableFormats() defaults to []: portal permission denial empties
    // the readable set. hasContent stays false so the renderer answers with
    // the CLI's own paste, not a silent no-op.
    const payload = await readPaste();

    expect(payload.hasContent).toBe(false);
    expect(clipboard.readBuffer).not.toHaveBeenCalled();
    expect(clipboard.read).not.toHaveBeenCalled();
  });
});

// P3: `clipboard:write` moved from `ipcMain.handle` to `ipcMain.on` —
// fire-and-forget, no promise round trip per copy. The Linux PRIMARY split
// survives: a selection-driven copy writes CLIPBOARD + PRIMARY, an explicit
// copy never touches PRIMARY (docs/ui-conventions.md, shared/types.ts
// ClipboardSource). As an `on` body it must also swallow throws (P2-108).
describe('clipboard:write (P3 fire-and-forget)', () => {
  afterEach(() => {
    platformState.os = 'win32';
  });

  it('is registered on the send channel (ipcMain.on)', () => {
    expect(handlers.has('clipboard:write')).toBe(true);
  });

  it('a selection copy on Linux writes CLIPBOARD and PRIMARY', () => {
    platformState.os = 'linux';
    handlers.get('clipboard:write')!({}, 'selected text', 'selection');
    expect(clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(clipboard.writeText).toHaveBeenNthCalledWith(1, 'selected text');
    expect(clipboard.writeText).toHaveBeenNthCalledWith(2, 'selected text', 'selection');
  });

  it('an explicit copy never touches PRIMARY, on any platform', () => {
    platformState.os = 'linux';
    handlers.get('clipboard:write')!({}, 'copied', 'explicit');
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith('copied');

    vi.mocked(clipboard.writeText).mockClear();
    handlers.get('clipboard:write')!({}, 'copied');
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith('copied');
  });

  it('a selection copy on Windows/macOS writes CLIPBOARD only', () => {
    platformState.os = 'win32';
    handlers.get('clipboard:write')!({}, 'sel', 'selection');
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    vi.mocked(clipboard.writeText).mockClear();
    platformState.os = 'darwin';
    handlers.get('clipboard:write')!({}, 'sel', 'selection');
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it('swallows a clipboard throw instead of killing main (P2-108 on-body contract)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(clipboard.writeText).mockImplementation(() => {
        throw new Error('clipboard busy');
      });
      expect(() => handlers.get('clipboard:write')!({}, 'text', 'selection')).not.toThrow();
      expect(warn).toHaveBeenCalledWith('clipboard:write failed:', expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
});


// P4: bound and offload the image paste (plan P4). P0 measured the
// screenshot freeze as readImage + toPNG = 96 %+ of `readForPaste`
// (261/421 ms p50 at 1080p/1440p, max 741 ms; docs/performance.md). Three
// changes: (1) text is bounded at 8 Mi characters with a user-visible flag;
// (2) a clipboard that already carries encoded PNG (Windows' registered
// `PNG` flavor from Snipping Tool, macOS `png`, X11 `image/png`) is read as
// bytes — no decode, no encode, main idle; (3) a raw-image-only clipboard
// (CF_DIB/TIFF) decodes on main (Electron's clipboard API is main-only)
// and encodes in a utilityProcess — with a documented degrade to the
// main-thread encode when the worker cannot start, never a crash.
describe('clipboard:readForPaste bounds + off-main encode (P4)', () => {
  afterEach(() => {
    platformState.os = 'win32';
    for (const fn of [clipboard.readBuffer, clipboard.readText, clipboard.readHTML, clipboard.read, clipboard.availableFormats, clipboard.readImage]) {
      vi.mocked(fn as (...args: never[]) => unknown).mockReset();
    }
    vi.mocked(utilityProcess.fork).mockReset().mockReturnValue(null as never);
  });

  function formatsWith(...names: string[]) {
    vi.mocked(clipboard.availableFormats).mockReturnValue(names);
  }

  async function readPaste(): Promise<ClipboardPastePayload> {
    return await handlers.get('clipboard:readForPaste')!({}) as never;
  }

  it('bounds pasted text at 8 Mi characters and flags the truncation', async () => {
    formatsWith('text/plain');
    vi.mocked(clipboard.readText).mockReturnValue('a'.repeat(8 * 1024 * 1024 + 7));

    const payload = await readPaste();

    expect(payload.text).toHaveLength(8 * 1024 * 1024);
    expect(payload.textTruncated).toBe(true);
  });

  it('leaves text inside the bound untouched and unflagged', async () => {
    formatsWith('text/plain');
    vi.mocked(clipboard.readText).mockReturnValue('notes');

    const payload = await readPaste();

    expect(payload.text).toBe('notes');
    expect(payload.textTruncated).toBeUndefined();
  });

  it('reads a PNG clipboard flavor as bytes — no decode, no encode (per-OS flavor table)', async () => {
    platformState.os = 'win32';
    formatsWith('PNG', 'bitmap', 'text/plain');
    vi.mocked(clipboard.readBuffer).mockImplementation((fmt: string) => {
      if (fmt === 'PNG') return Buffer.from('PNGBYTES');
      throw new Error(`${fmt} not on clipboard`);
    });

    const payload = await readPaste();

    expect(clipboard.readImage).not.toHaveBeenCalled();
    // POSIX suffixes the dir with the uid (see the test below); Windows keeps
    // the bare name, and this suite defaults to the Windows platform.
    expect(payload.imagePath).toMatch(/[\\/]finevibe-paste(-\d+)?[\\/].*\.png$/);
    expect(fs.readFileSync(payload.imagePath!)).toEqual(Buffer.from('PNGBYTES'));
  });

  it('encodes a raw-image flavor off the main thread through the utility worker', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const listeners = new Map<string, (e: unknown) => void>();
    const proc = {
      on: (ev: string, cb: (e: unknown) => void) => { listeners.set(ev, cb); },
      postMessage: (msg: { id: number }) => {
        queueMicrotask(() => listeners.get('message')?.({
          data: { id: msg.id, ok: true, png: pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength) },
        }));
      },
      kill: vi.fn(),
    };
    vi.mocked(utilityProcess.fork).mockReturnValue(proc as never);
    formatsWith('image/bmp', 'bitmap');
    const toPNG = vi.fn(() => Buffer.from('MAIN-PNG'));
    vi.mocked(clipboard.readImage).mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([1, 2, 3, 255]),
      toPNG,
    } as never);

    const payload = await readPaste();

    expect(fs.readFileSync(payload.imagePath!)).toEqual(pngBytes);
    // The encode left the main thread: the synchronous encoder never ran.
    expect(toPNG).not.toHaveBeenCalled();
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
  });

  it('degrades to the main-thread encode when the worker cannot start — never a crash', async () => {
    vi.mocked(utilityProcess.fork).mockReturnValue(null as never);
    formatsWith('image/tiff');
    vi.mocked(clipboard.readImage).mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.from([1, 2, 3, 255]),
      toPNG: () => Buffer.from('MAIN-PNG'),
    } as never);

    const payload = await readPaste();

    expect(fs.readFileSync(payload.imagePath!)).toEqual(Buffer.from('MAIN-PNG'));
  });

  it('a clipboard with no image flavor (Wayland) skips every image read', async () => {
    platformState.os = 'linux';
    formatsWith('text/plain');
    vi.mocked(clipboard.readText).mockReturnValue('');

    const payload = await readPaste();

    expect(clipboard.readImage).not.toHaveBeenCalled();
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    expect(payload.imagePath).toBeNull();
  });

  it('suffixes the POSIX paste dir with the uid — a shared /tmp name is a free DoS', async () => {
    // os.tmpdir() is /tmp: world-writable and shared. A fixed name created
    // under 0700 is claimed by whoever gets there first, and every other
    // user's mkdir then fails EACCES — one local `mkdir /tmp/finevibe-paste`
    // switches off pasted images for the whole machine. The uid suffix is
    // hook-status's getStatusDir shape; Windows' per-user %TEMP% needs none.
    platformState.os = 'linux';
    const realGetuid = process.getuid;
    (process as { getuid?: unknown }).getuid = () => 4321;
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      registerIpcHandlers(); // the dir name is resolved per registration
      formatsWith('image/png');
      vi.mocked(clipboard.readBuffer).mockReturnValue(Buffer.from('PNGBYTES'));

      const payload = await readPaste();

      expect(payload.imagePath).toContain(`finevibe-paste-4321${path.sep}`);
      // 0700: the parent is world-writable and a pasted screenshot is
      // whatever the user just copied.
      expect(mkdir.mock.calls[0][1]).toEqual({ recursive: true, mode: 0o700 });
    } finally {
      (process as { getuid?: unknown }).getuid = realGetuid;
      mkdir.mockRestore();
    }
  });
});

// P2-108: an `ipcMain.on` body runs on Electron's main-process dispatch path
// and src/main installs no uncaughtException handler (the only mentions in
// src/main are comments stating its absence), so a throw escaping any `on`
// body is a fatal main-process exception — every live PTY and window dies.
// Every `on` body must therefore swallow-and-log, and the sendSync twins must
// answer with a benign shape.
describe('ipcMain.on bodies are non-fatal', () => {
  it('swallows a throw from a non-string payload instead of killing the main process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The real registry throws `Unknown CLI provider: …` for ids it does
      // not know (registry.ts), and the git/fs bodies hit
      // ERR_INVALID_ARG_TYPE inside path.resolve on the same payload.
      mockGetProvider.mockImplementation(() => {
        throw new Error('Unknown CLI provider: [object Object]');
      });
      expect(() => handlers.get('config:watchProject')!({}, {}, '/proj')).not.toThrow();
      expect(() => handlers.get('git:watchProject')!({}, {})).not.toThrow();
      expect(() => handlers.get('fs:unwatchDir')!({}, {})).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('a sync channel answers with a benign shape when its body throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(loadState).mockImplementationOnce(() => {
        throw new Error('state cache corrupted');
      });
      const event: { returnValue?: unknown } = {};
      expect(() => handlers.get('store:startup-prefs')!(event)).not.toThrow();
      // The renderer's sendSync gets the never-saved shape, not an
      // "interface not implemented" throw on its own side.
      expect(event.returnValue).toEqual({ theme: null, zoomFactor: null });
    } finally {
      warn.mockRestore();
    }
  });
});

// P1-14 / P2-127: the per-session banner is computed from the profiled
// session's config dir, so (a) its consent lookup must be the PER-DIR
// record (a Keep on ~/.claude must not mute a profile banner, and vice
// versa), (b) the payload carries the dir the banner was computed from so
// the Fix Settings CTA repairs THAT dir, and (c) banner dismissal on a
// profile records the per-dir Keep — the banner is the profile's single
// consent surface (spawn is a hot path and never shows the modal).
describe('settings banner + repair profile threading (P1-14 / P2-127)', () => {
  beforeEach(() => {
    provider.meta.capabilities.hookStatus = true;
    vi.mocked(getDirConsent).mockReturnValue({ consent: undefined, command: undefined });
    provider.validateSettings = vi.fn(() => ({
      statusLine: 'foreign', hooks: 'complete', foreignStatusLineCommand: '/usr/bin/other-statusline',
    })) as never;
    vi.mocked(shouldWarnStatusLine).mockReturnValue(true);
  });

  it('carries the profile configDir the validation was computed from', async () => {
    await create('ui-1', null, { configDir: '/profiles/work' });
    expect(fakeWin.webContents.send).toHaveBeenCalledWith(
      'settings:warning',
      expect.objectContaining({
        sessionId: 'ui-1',
        statusLine: 'foreign',
        configDir: '/profiles/work',
        projectPath: '/proj',
        providerId: 'claude',
      }),
    );
  });

  // SA-P1-2: the payload names the provider the banner came from, so the
  // Fix Settings CTA repairs codex/gemini/copilot, not Claude.
  it('carries the provider id the validation was computed from', async () => {
    provider.meta.id = 'codex';
    await create('ui-1', null, { providerId: 'codex' });
    expect(fakeWin.webContents.send).toHaveBeenCalledWith(
      'settings:warning',
      expect.objectContaining({ sessionId: 'ui-1', providerId: 'codex' }),
    );
  });

  it('consults the per-dir consent record for a profiled session', async () => {
    await create('ui-1', null, { configDir: '/profiles/work' });
    expect(getDirConsent).toHaveBeenCalledWith(expect.anything(), '/profiles/work');
  });

  it('settings:reinstall repairs the profile dir the banner was computed from', async () => {
    await handlers.get('settings:reinstall')!({}, 'claude', '/profiles/work');
    expect(provider.reinstallSettings).toHaveBeenCalledWith('/profiles/work', undefined);
  });

  it('settings:reinstall refuses a configDir outside the managed-profile allowlist', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    const result = await handlers.get('settings:reinstall')!({}, 'claude', '/home/attacker/.claude');
    expect(result).toMatchObject({ success: false });
    expect(provider.reinstallSettings).not.toHaveBeenCalled();
  });

  it('settings:reinstall without a configDir keeps repairing the default dir', async () => {
    await handlers.get('settings:reinstall')!({}, 'claude');
    expect(provider.reinstallSettings).toHaveBeenCalledWith(undefined, undefined);
  });

  // P2-55: Copilot's hooks are project-scoped — the CTA must repair the
  // project the banner was validated against, not the user scope.
  it('settings:reinstall threads the banner project to project-scoped providers', async () => {
    knownPaths.push('/proj');
    await handlers.get('settings:reinstall')!({}, 'copilot', undefined, '/proj');
    expect(provider.reinstallSettings).toHaveBeenCalledWith(undefined, '/proj');
  });

  // SA-P2-5: projectPath reaches installCopilotHooks' mkdirSync+writeFileSync,
  // so it carries the same known-project gate as mcp:removeServer — a project
  // the board never registered is refused before any provider runs.
  it('settings:reinstall refuses a projectPath outside the known project roots', async () => {
    knownPaths.push('/proj');
    const result = await handlers.get('settings:reinstall')!({}, 'copilot', undefined, '/home/attacker/victim');
    expect(result).toMatchObject({ success: false });
    expect(provider.reinstallSettings).not.toHaveBeenCalled();
  });

  it('settings:reinstall accepts a projectPath inside a known project root', async () => {
    knownPaths.push('/proj');
    const result = await handlers.get('settings:reinstall')!({}, 'copilot', undefined, '/proj/sub');
    expect(result).toEqual({ success: true });
    expect(provider.reinstallSettings).toHaveBeenCalledWith(undefined, '/proj/sub');
  });

  // P2-86: settings:validate must dispatch scoped like the post-spawn
  // validation (pty:create passes (cwd, configDir)); the unscoped dispatch
  // read the user-global file and reported a broken project as `complete`.
  it('settings:validate scopes to the project and dir it was given', async () => {
    // SA-P3: the handler now gates its scope args — this case exercises the
    // IN-scope dispatch, so satisfy the gates (managed dir + known root).
    vi.mocked(isManagedMcpConfigDir).mockReturnValue(true);
    knownPaths.push('/proj');
    await handlers.get('settings:validate')!({}, 'copilot', '/proj', '/profiles/work');
    expect(provider.validateSettings).toHaveBeenCalledWith('/proj', '/profiles/work');
  });

  it('settings:validate without scope keeps the user-scope check', async () => {
    await handlers.get('settings:validate')!({}, 'copilot');
    expect(provider.validateSettings).toHaveBeenCalledWith(undefined, undefined);
  });

  // SA-P2-1: a foreign statusLine covered by the dir's declined consent is
  // the user's Keep — validate marks it so Setup renders the neutral tier
  // and the badge stays silent instead of a red dot + a Replace-performing Fix.
  it('settings:validate marks a kept foreign statusLine (SA-P2-1)', async () => {
    provider.validateSettings = vi.fn(() => ({
      statusLine: 'foreign' as const, hooks: 'complete' as const,
      foreignStatusLineCommand: '/usr/bin/other-statusline', hookDetails: {},
    }));
    vi.mocked(loadState).mockReturnValue({ projects: [], preferences: {} } as never);

    // Matching declined record → Keep.
    vi.mocked(getDirConsent).mockReturnValue({ consent: 'declined', command: '/usr/bin/other-statusline' });
    const kept = (await handlers.get('settings:validate')!({}, 'claude', undefined, '/profiles/work')) as SettingsValidationResult;
    expect(kept.userKeptStatusLine).toBe(true);

    // Command-less declined record freezes onto the current foreign command.
    vi.mocked(getDirConsent).mockReturnValue({ consent: 'declined', command: null });
    const frozen = (await handlers.get('settings:validate')!({}, 'claude', undefined, '/profiles/work')) as SettingsValidationResult;
    expect(frozen.userKeptStatusLine).toBe(true);

    // Stale declined command (a NEW tool overwrote it) → not a Keep.
    vi.mocked(getDirConsent).mockReturnValue({ consent: 'declined', command: '/usr/bin/OLD-tool' });
    const notKept = (await handlers.get('settings:validate')!({}, 'claude', undefined, '/profiles/work')) as SettingsValidationResult;
    expect(notKept.userKeptStatusLine).toBeUndefined();

    // Granted consent (the overwrite is an issue to repair) → not a Keep.
    vi.mocked(getDirConsent).mockReturnValue({ consent: 'granted', command: null });
    const granted = (await handlers.get('settings:validate')!({}, 'claude', undefined, '/profiles/work')) as SettingsValidationResult;
    expect(granted.userKeptStatusLine).toBeUndefined();
  });

  it('settings:declineStatusLine records the per-dir Keep and gates unmanaged dirs', () => {
    handlers.get('settings:declineStatusLine')!({}, '/profiles/work', '/usr/bin/other-statusline');
    expect(recordDirConsent).toHaveBeenCalledWith('/profiles/work', 'declined', '/usr/bin/other-statusline');
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    handlers.get('settings:declineStatusLine')!({}, '/home/attacker/.claude', '/x');
    expect(recordDirConsent).toHaveBeenCalledTimes(1);
  });

  // SA-P3: a dir-less banner dismissal must NOT write the global declined
  // record — that mutes the boot consent modal, which owns global consent.
  it('settings:declineStatusLine refuses a dir-less global write (SA-P3)', () => {
    handlers.get('settings:declineStatusLine')!({}, undefined, '/usr/bin/other-statusline');
    expect(recordDirConsent).not.toHaveBeenCalled();
  });

  // SA-P3: validate read and echoed files under any renderer-supplied dir;
  // the reinstall/decline gates now cover it — refused scopes return the
  // all-clear shape (no banner, no echo of a foreign command).
  it('settings:validate refuses unmanaged dirs and foreign projects (SA-P3)', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    const refusedDir = (await handlers.get('settings:validate')!({}, 'claude', undefined, '/home/attacker/.claude')) as SettingsValidationResult;
    expect(refusedDir).toEqual({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });

    knownPaths.push('/proj');
    const refusedPath = (await handlers.get('settings:validate')!({}, 'claude', '/home/attacker/victim')) as SettingsValidationResult;
    expect(refusedPath).toEqual({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });
    expect(provider.validateSettings).not.toHaveBeenCalled();

    // In-scope args still dispatch normally (this describe's mock returns
    // a foreign statusLine — the point is that validateSettings RAN).
    const ok = (await handlers.get('settings:validate')!({}, 'copilot', '/proj/sub')) as SettingsValidationResult;
    expect(provider.validateSettings).toHaveBeenCalledWith('/proj/sub', undefined);
    expect(ok.statusLine).toBe('foreign');
  });
});

describe('team-agent install/remove scope (P2-116 / P2-117)', () => {
  // Install stamps this frontmatter marker; remove gates every unlink on it.
  const markerLine = (slug: string) => `# installed-by: finevibe ${slug}`;
  const stamped = (slug: string) => `---\n${markerLine(slug)}\nname: ${slug}\n---\nbody\n`;

  /** Fake team-capable provider writing under a real temp agents dir. */
  function agentProvider(id: string, dir: string) {
    return {
      meta: { id },
      validatePrerequisites: () => true,
      agentsDir: () => dir,
      installAgent: vi.fn(async (slug: string, _content: string, configDir?: string) => ({
        filePath: path.join(configDir ?? dir, `${slug}.md`),
      })),
      removeAgent: vi.fn(async (slug: string, configDir?: string) => {
        fs.rmSync(path.join(configDir ? path.join(configDir, 'agents') : dir, `${slug}.md`), { force: true });
      }),
    };
  }

  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-agents-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('install stamps the finevibe marker and threads a managed configDir to claude only', async () => {
    const claude = agentProvider('claude', path.join(root, 'claude-agents'));
    const gemini = agentProvider('gemini', path.join(root, 'gemini-agents'));
    vi.mocked(getAllProviders).mockReturnValue([claude, gemini] as never);
    const results = await handlers.get('provider:installAgent')!(
      {}, 'auditor', '---\nname: auditor\n---\nbody\n', '/profiles/work'
    ) as Array<{ providerId: string; ok: boolean }>;
    expect(results.every((r) => r.ok)).toBe(true);
    const [slug, stampedContent, claudeDir] = claude.installAgent.mock.calls[0];
    expect(slug).toBe('auditor');
    expect(claudeDir).toBe('/profiles/work');
    expect(stampedContent.startsWith(`---\n${markerLine('auditor')}\n`)).toBe(true);
    // Other providers have no profiled agents tree; they keep the default dir.
    expect(gemini.installAgent.mock.calls[0][2]).toBeUndefined();
    expect(gemini.installAgent.mock.calls[0][1]).toContain(markerLine('auditor'));
  });

  it('install rejects a configDir outside the managed allowlist before any write', async () => {
    const claude = agentProvider('claude', path.join(root, 'claude-agents'));
    vi.mocked(getAllProviders).mockReturnValue([claude] as never);
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    await expect(
      handlers.get('provider:installAgent')!({}, 'auditor', 'x', '/home/attacker/.claude')
    ).rejects.toThrow(/managed/);
    expect(claude.installAgent).not.toHaveBeenCalled();
  });

  it('remove of a never-installed name does NOT unlink a pre-existing user file', async () => {
    const dir = path.join(root, 'gemini-agents');
    fs.mkdirSync(dir);
    const userFile = path.join(dir, 'security-auditor.md');
    fs.writeFileSync(userFile, '---\nname: security-auditor\n---\nuser-authored, never installed by FineVibe\n');
    const gemini = agentProvider('gemini', dir);
    vi.mocked(getAllProviders).mockReturnValue([gemini] as never);
    const results = await handlers.get('provider:removeAgent')!({}, 'security-auditor') as Array<{ status: string }>;
    expect(fs.existsSync(userFile)).toBe(true);
    expect(gemini.removeAgent).not.toHaveBeenCalled();
    expect(results).toEqual([
      { providerId: 'gemini', filePath: userFile, status: 'skipped' },
    ]);
  });

  it('uninstall of an installed agent removes exactly it, leaving neighbors', async () => {
    const dir = path.join(root, 'gemini-agents');
    fs.mkdirSync(dir);
    const target = path.join(dir, 'auditor.md');
    const neighbor = path.join(dir, 'designer.md');
    fs.writeFileSync(target, stamped('auditor'));
    fs.writeFileSync(neighbor, stamped('designer'));
    const gemini = agentProvider('gemini', dir);
    vi.mocked(getAllProviders).mockReturnValue([gemini] as never);
    const results = await handlers.get('provider:removeAgent')!({}, 'auditor') as Array<{ status: string }>;
    expect(results).toEqual([
      { providerId: 'gemini', filePath: target, status: 'removed' },
    ]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(neighbor)).toBe(true);
  });

  it('remove probes the .agent.md naming and skips unmarked same-slug files', async () => {
    const dir = path.join(root, 'copilot-agents');
    fs.mkdirSync(dir);
    const installed = path.join(dir, 'cmo.agent.md');
    const userNote = path.join(dir, 'cmo.md');
    fs.writeFileSync(installed, stamped('cmo'));
    fs.writeFileSync(userNote, 'user note, no marker\n');
    const copilot = agentProvider('copilot', dir);
    copilot.removeAgent = vi.fn(async (slug: string) => {
      fs.rmSync(path.join(dir, `${slug}.agent.md`), { force: true });
    });
    vi.mocked(getAllProviders).mockReturnValue([copilot] as never);
    const results = await handlers.get('provider:removeAgent')!({}, 'cmo') as Array<{ filePath: string; status: string }>;
    expect(results).toEqual([
      { providerId: 'copilot', filePath: userNote, status: 'skipped' },
      { providerId: 'copilot', filePath: installed, status: 'removed' },
    ]);
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(userNote)).toBe(true);
  });

  it('remove scans claude profile agents dirs, not just the default tree', async () => {
    const profDir = path.join(root, 'profile');
    const defDir = path.join(root, 'claude-agents');
    fs.mkdirSync(path.join(profDir, 'agents'), { recursive: true });
    fs.mkdirSync(defDir);
    const inProfile = path.join(profDir, 'agents', 'lead.md');
    const inDefault = path.join(defDir, 'lead.md');
    fs.writeFileSync(inProfile, stamped('lead'));
    fs.writeFileSync(inDefault, stamped('lead'));
    vi.mocked(loadState).mockImplementationOnce(() => ({
      projects: [], preferences: {}, profiles: [{ id: 'p1', providerId: 'claude', configDir: profDir }],
    } as never));
    const claude = agentProvider('claude', defDir);
    vi.mocked(getAllProviders).mockReturnValue([claude] as never);
    const results = await handlers.get('provider:removeAgent')!({}, 'lead') as Array<{ status: string }>;
    expect(results.map((r) => r.status)).toEqual(['removed', 'removed']);
    expect(fs.existsSync(inProfile)).toBe(false);
    expect(fs.existsSync(inDefault)).toBe(false);
    expect(claude.removeAgent).toHaveBeenCalledWith('lead', profDir);
    expect(claude.removeAgent).toHaveBeenCalledWith('lead', undefined);
  });

  it('remove surfaces a provider unlink failure per file instead of swallowing it', async () => {
    const dir = path.join(root, 'gemini-agents');
    fs.mkdirSync(dir);
    const target = path.join(dir, 'auditor.md');
    fs.writeFileSync(target, stamped('auditor'));
    const gemini = agentProvider('gemini', dir);
    gemini.removeAgent = vi.fn(async () => { throw new Error('EPERM: operation not permitted'); });
    vi.mocked(getAllProviders).mockReturnValue([gemini] as never);
    const results = await handlers.get('provider:removeAgent')!({}, 'auditor') as Array<{ status: string; error?: string }>;
    expect(results).toEqual([
      { providerId: 'gemini', filePath: target, status: 'failed', error: 'EPERM: operation not permitted' },
    ]);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('install/remove reject an unsafe slug before touching the filesystem', async () => {
    const gemini = agentProvider('gemini', path.join(root, 'gemini-agents'));
    vi.mocked(getAllProviders).mockReturnValue([gemini] as never);
    await expect(handlers.get('provider:removeAgent')!({}, '../evil')).rejects.toThrow(/Unsafe agent slug/);
    await expect(handlers.get('provider:installAgent')!({}, '..\\evil', 'x')).rejects.toThrow(/Unsafe agent slug/);
    expect(gemini.removeAgent).not.toHaveBeenCalled();
    expect(gemini.installAgent).not.toHaveBeenCalled();
  });
});

// "Checkout and create" (plan 65-67): the clone destination is a pre-project
// WRITE, so fs:cloneRepo takes the fs:listDirs gate shape — home tree / known
// roots pass, home-outside needs the explicit confirm — and re-validates the
// URL against the shared allowlist before any spawn. Every rejection must
// happen before git is launched, so `git clone` is the child_process spy's
// canary: the suite mocks node:child_process wholesale.
describe('fs:cloneRepo gates', () => {
  it('rejects an off-allowlist URL before touching the filesystem', async () => {
    const res = await handlers.get('fs:cloneRepo')!({}, 'https://gitlab.com/owner/repo', path.join(os.homedir(), 'repo'));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('URL') });
    expect(mockGitCloneSpawn).not.toHaveBeenCalled();
  });

  it('refuses a home-outside, root-outside destination when the confirm is denied', async () => {
    // dialog.showMessageBox resolves response 0 (Cancel) by default.
    const res = await handlers.get('fs:cloneRepo')!({}, 'https://github.com/owner/repo', OUTSIDE_HOME);
    expect(res).toMatchObject({ ok: false });
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(mockGitCloneSpawn).not.toHaveBeenCalled();
  });

  it('rejects a destination that exists and is not empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-clone-'));
    try {
      fs.writeFileSync(path.join(dir, 'occupied'), 'x');
      const res = await handlers.get('fs:cloneRepo')!({}, 'https://github.com/owner/repo', dir);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not empty') });
      expect(mockGitCloneSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a destination that exists as a file, not a directory', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.homedir(), '.finevibe-clone-')), 'blocker');
    try {
      fs.writeFileSync(file, 'x');
      const res = await handlers.get('fs:cloneRepo')!({}, 'https://github.com/owner/repo', file);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not a directory') });
      expect(mockGitCloneSpawn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('spawns git clone -- <url> <dest> argv for a home-tree target and reports stderr on failure', async () => {
    mockGitCloneSpawn.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      // Real execFile errors carry the child's stderr on the error object;
      // promisify drops the separate callback args.
      cb(Object.assign(new Error('Command failed'), { stderr: 'fatal: repository \x27https://github.com/owner/repo\x27 not found' }));
    });
    const dest = path.join(os.homedir(), 'repo');
    const res = await handlers.get('fs:cloneRepo')!({}, 'https://github.com/owner/repo', dest);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockGitCloneSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('git');
    // `--` before the URL: an allowlisted-shape URL must never parse as an
    // option (`--upload-pack`, ext:: transport) no matter what the renderer sent.
    expect(args).toEqual(['clone', '--', 'https://github.com/owner/repo', dest]);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
  });

  it('reports a missing git binary without throwing', async () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    mockGitCloneSpawn.mockImplementationOnce((_cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null) => void) => cb(enoent));
    const res = await handlers.get('fs:cloneRepo')!({}, 'https://github.com/owner/repo', path.join(os.homedir(), 'repo'));
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('git') });
  });

  it('reports ok for a successful clone', async () => {
    mockGitCloneSpawn.mockImplementationOnce((_cmd: string, _args: unknown, _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => cb(null, '', ''));
    const res = await handlers.get('fs:cloneRepo')!({}, 'git@github.com:owner/repo.git', path.join(os.homedir(), 'repo'));
    expect(res).toEqual({ ok: true });
  });
});

// S4-04: the sidebar's Add-Project path input fires fs:listDirs per
// keystroke; the handler must stay cheap (async readdir, sort only the
// prefix-matched slice, join only the 20-slice) and prompt home-outside
// consent at most once per directory.
describe('fs:listDirs keystroke path (S4-04)', () => {
  it('returns the first 20 directories in name order, prefix-filtered, with no confirm inside home', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-listdirs-'));
    try {
      const names: string[] = [];
      for (let i = 1; i <= 25; i++) names.push(`p${String(i).padStart(2, '0')}`);
      names.push('beta', '.hidden');
      for (const n of names) fs.mkdirSync(path.join(homeDir, n));
      fs.writeFileSync(path.join(homeDir, 'afile.txt'), 'x');

      const dirs = (await handlers.get('fs:listDirs')!({}, homeDir)) as string[];
      // localeCompare order: 'beta' collates before 'p01', so the 20-slice
      // is beta + p01..p18 — the full dir list sorted, sliced, joined.
      expect(dirs).toEqual(
        names.filter(n => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)).slice(0, 20).map(n => path.join(homeDir, n))
      );
      const beta = (await handlers.get('fs:listDirs')!({}, homeDir, 'be')) as string[];
      expect(beta).toEqual([path.join(homeDir, 'beta')]);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('asks home-outside consent at most once per directory — repeats never re-prompt', async () => {
    // Private fixture OUTSIDE the home tree, user-writable and
    // machine-deterministic (C:\Windows\Temp on Windows, /tmp elsewhere) -
    // enumerating C:\Windows itself depends on machine ACLs and flipped
    // under shuffled order; C:\Users refuses creation (EPERM). Consent
    // semantics are per-directory, so a private dir tests the same contract.
    const base = process.platform === 'win32' && fs.existsSync('C:\\Windows\\Temp') ? 'C:\\Windows\\Temp' : fs.mkdtempSync(path.join(os.tmpdir(), 'fv-base-'));
    const dir = fs.mkdtempSync(path.join(base, 'finevibe-consent-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'));
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
      const first = (await handlers.get('fs:listDirs')!({}, dir)) as string[];
      const second = (await handlers.get('fs:listDirs')!({}, dir)) as string[];
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (base !== 'C:\\Windows\\Temp') fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('caches a Cancel too: every repeat on the declined directory returns empty with no new dialog', async () => {
    // dialog.showMessageBox resolves response 0 (Cancel) by default.
    await expect(handlers.get('fs:listDirs')!({}, OUTSIDE_HOME)).resolves.toEqual([]);
    await expect(handlers.get('fs:listDirs')!({}, OUTSIDE_HOME)).resolves.toEqual([]);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

// S4-03: Preferences→Setup fires provider:checkBinary for all seven providers
// per section mount, installAgent filters targets, and readiness:analyze
// probes availability — all must ride the async probe twin (Wave E), not the
// sync `where`/`npm prefix -g` chain, and keep their response shapes.
describe('provider binary probes are async (S4-03)', () => {
  it('provider:checkBinary uses the async probe twin when the provider has one', async () => {
    const asyncProbe = vi.fn(async () => true);
    provider.validatePrerequisites = vi.fn(() => { throw new Error('sync probe on the IPC hot path'); });
    provider.validatePrerequisitesAsync = asyncProbe;
    await expect(handlers.get('provider:checkBinary')!({}, 'pi')).resolves.toBe(true);
    expect(asyncProbe).toHaveBeenCalledTimes(1);
    expect(provider.validatePrerequisites).not.toHaveBeenCalled();
  });

  it('provider:checkBinary falls back to the sync probe for providers without the twin', async () => {
    provider.validatePrerequisites = vi.fn(() => false);
    await expect(handlers.get('provider:checkBinary')!({}, 'pi')).resolves.toBe(false);
    expect(provider.validatePrerequisites).toHaveBeenCalledTimes(1);
  });

  it('provider:installAgent filters targets with the async twin, preserving the response shape', async () => {
    const asyncProbe = vi.fn(async () => true);
    const fake = {
      meta: { id: 'claude' },
      validatePrerequisites: () => { throw new Error('sync probe on the IPC hot path'); },
      validatePrerequisitesAsync: asyncProbe,
      installAgent: vi.fn(async () => ({ filePath: '/tmp/claude/agents/auditor.md' })),
    };
    vi.mocked(getAllProviders).mockReturnValue([fake] as never);
    const results = await handlers.get('provider:installAgent')!({}, 'auditor', 'body') as Array<Record<string, unknown>>;
    expect(results).toEqual([{ providerId: 'claude', ok: true, filePath: '/tmp/claude/agents/auditor.md' }]);
    expect(asyncProbe).toHaveBeenCalledTimes(1);
  });
});

// UI3-11: whole-repo top-files scans stacked per widget mount. Concurrent
// scans of one cwd must share a single walk, each caller slicing to its own
// limit from the shared sorted result.
describe('fs:topFilesByTokens shared walk (UI3-11)', () => {
  it('coalesces concurrent scans of one cwd into a single file walk', async () => {
    vi.mocked(buildFineVibeIgnoreMatcher).mockReturnValue(() => false);
    // The enumeration suite leaks its execFile stub; reject git here so the
    // walk fallback sees the real temp tree.
    vi.mocked(mockGitCloneSpawn).mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error('not a git repository'));
    }) as never);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-topfiles-'));
    const openSpy = vi.spyOn(fs.promises, 'open');
    try {
      for (const n of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(dir, n), 'word '.repeat(10));
      knownPaths.push(dir);

      openSpy.mockClear();
      const [r10, r2] = await Promise.all([
        handlers.get('fs:topFilesByTokens')!({}, dir, 10),
        handlers.get('fs:topFilesByTokens')!({}, dir, 2),
      ]);

      expect(r10, JSON.stringify(r10)).toMatchObject({ ok: true });
      expect((r10 as { ok: boolean; files: unknown[] }).files).toHaveLength(3);
      expect((r2 as { ok: boolean; files: unknown[] }).files).toHaveLength(2);
      // One shared walk: each file opened once, not once per caller.
      expect(openSpy).toHaveBeenCalledTimes(3);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      const i = knownPaths.indexOf(dir);
      if (i >= 0) knownPaths.splice(i, 1);
    }
  });
});

// C2M-03: the shared walk deduped CONCURRENT mounts only — every mount after
// a walk settled re-scanned the whole tree (the stats widget polls). The
// settled result is now cached per cwd on the enumeration's contract: TTL,
// cleared by git:changed.
describe('fs:topFilesByTokens result cache (C2M-03)', () => {
  let dir: string;
  let openSpy: ReturnType<typeof vi.spyOn>;

  async function gitChangedListener(): Promise<() => void> {
    const gitWatcher = await import('./git-watcher');
    const subscribed = vi.mocked(gitWatcher.onGitChanged).mock.calls;
    expect(subscribed.length).toBeGreaterThan(0);
    return subscribed[subscribed.length - 1][0] as () => void;
  }

  beforeEach(() => {
    vi.mocked(buildFineVibeIgnoreMatcher).mockReturnValue(() => false);
    // Real temp tree, so reject git: the walk fallback does the enumerating.
    vi.mocked(mockGitCloneSpawn).mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(new Error('not a git repository'));
    }) as never);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-topfiles-cache-'));
    for (const n of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(dir, n), 'word '.repeat(10));
    knownPaths.push(dir);
    // The cache is module state (the enumerate suite resets it the same way).
    _resetEnumerateCacheForTesting();
    openSpy = vi.spyOn(fs.promises, 'open');
  });
  afterEach(() => {
    openSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    const i = knownPaths.indexOf(dir);
    if (i >= 0) knownPaths.splice(i, 1);
  });

  const scan = (): Promise<Record<string, unknown>> =>
    handlers.get('fs:topFilesByTokens')!({}, dir, 10) as Promise<Record<string, unknown>>;

  it('serves a repeat scan from the cache without re-reading any file', async () => {
    expect((await scan()).files).toHaveLength(3);
    expect(openSpy).toHaveBeenCalledTimes(3);

    openSpy.mockClear();
    const again = await scan();
    expect(again.files).toHaveLength(3);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('re-scans after the git:changed invalidation the renderer also receives', async () => {
    expect((await scan()).files).toHaveLength(3);

    (await gitChangedListener())();
    openSpy.mockClear();
    fs.writeFileSync(path.join(dir, 'd.ts'), 'word '.repeat(10));
    const rescan = await scan();
    expect(openSpy).toHaveBeenCalledTimes(4);
    expect(rescan.files).toHaveLength(4);
  });

  // C2M-05: the scan allocated and read every file IN FULL (Buffer.alloc of
  // the size gate, 16-way) to compute a heuristic token estimate. The read is
  // now one 1 MiB head sample, scaled back up to the file's size.
  it('reads one 1 MiB head sample and scales the estimate to the file size', async () => {
    vi.mocked(estimateTokens).mockImplementation((text: string) => text.length);
    // vitest's `fs` namespace carries no FileHandle export; take the
    // prototype off a real handle (the spy is prototype-wide, as needed).
    const probe = await fs.promises.open(path.join(dir, 'a.ts'), 'r');
    const readSpy = vi.spyOn(Object.getPrototypeOf(probe) as Record<string, (...args: any[]) => any>, 'read');
    await probe.close();
    const size = 1024 * 1024 + 4096;
    fs.writeFileSync(path.join(dir, 'big.ts'), 'a'.repeat(size));
    try {
      const res = await scan();
      const lengths = readSpy.mock.calls.map((c) => (c as unknown as [unknown, number, number])[2]);
      expect(Math.max(...lengths)).toBe(1024 * 1024);
      const big = (res.files as Array<{ path: string; tokens: number; size: number }>)
        .find((f) => f.path === 'big.ts');
      // head-sample estimate × (size / readBytes) = the full-file estimate
      expect(big?.tokens).toBe(size);
      expect(big?.size).toBe(size);
    } finally {
      readSpy.mockRestore();
      vi.mocked(estimateTokens).mockReset();
    }
  });
});

// C3A-02: the config watcher reads the provider config tree under a
// renderer-supplied projectPath — the channel takes git:watchProject's
// PROJECT tier, so a config tree (a read-allowed dir) never starts a watcher.
describe('config:watchProject gate (C3A-02)', () => {
  it('never starts a watcher for a path outside the known projects', () => {
    provider.startConfigWatcher = vi.fn();
    handlers.get('config:watchProject')!({}, 'claude', path.join(os.homedir(), '.claude'));
    expect(provider.startConfigWatcher).not.toHaveBeenCalled();
  });
  it('starts the watcher for a known project', () => {
    provider.startConfigWatcher = vi.fn();
    knownPaths.push('/proj');
    handlers.get('config:watchProject')!({}, 'claude', '/proj');
    expect(provider.startConfigWatcher).toHaveBeenCalledWith(fakeWin, path.resolve('/proj'));
  });
});

// C3A-01: removeMcpServer's write allowlist is derived from the renderer's
// own projectPath+configDir, so the handler gates both before the call.
describe('mcp:removeServer path gates (C3A-01)', () => {
  it('refuses a configDir outside the managed-profile allowlist', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    const result = await handlers.get('mcp:removeServer')!(
      {}, 'srv', '/home/attacker/.claude/.claude.json', 'user', undefined, '/home/attacker/.claude',
    );
    expect(result).toMatchObject({ success: false });
    expect(removeMcpServer).not.toHaveBeenCalled();
  });
  it('refuses a project scope outside the known projects', async () => {
    knownPaths.push('/proj');
    const result = await handlers.get('mcp:removeServer')!(
      {}, 'srv', '/foreign/.mcp.json', 'project', '/foreign', undefined,
    );
    expect(result).toMatchObject({ success: false, error: 'Path is not within a known project' });
    expect(removeMcpServer).not.toHaveBeenCalled();
  });
  it('passes a known project plus a managed configDir through', async () => {
    knownPaths.push('/proj');
    const result = await handlers.get('mcp:removeServer')!(
      {}, 'srv', '/proj/.mcp.json', 'project', '/proj', '/profiles/work',
    );
    expect(result).toEqual({ success: true });
    expect(removeMcpServer).toHaveBeenCalledWith('srv', '/proj/.mcp.json', 'project', '/proj', '/profiles/work');
  });
});

// The vibeyard: channel is thin glue over the pure legacy-import module;
// the suite exercises the wiring (channel name, arg plumbing through the
// store mock) rather than the enumeration logic, which has its own suite.
describe('vibeyard:listImportableProjects', () => {
  it('is registered and answers with an array', async () => {
    const handler = handlers.get('vibeyard:listImportableProjects');
    expect(handler).toBeTypeOf('function');
    // ./legacy-import is unmocked, so this reads the developer's real
    // homedir; the module never throws, so the contract is "an array".
    expect(await handler!({})).toBeInstanceOf(Array);
  });
});

// B1: the two per-cwd caches were unbounded — one entry per project opened
// in the session, freed only by TTL/git:changed on the cwds someone
// revisited. Cap + touch-refresh LRU (fs-utils.ts idiom), plus the
// TTL-expiry sweep exported for the idle housekeeper.
describe('enumeration cache caps and sweep (B1)', () => {
  const list = (cwd: string, query = ''): Promise<string[]> =>
    handlers.get('fs:listFiles')!({}, cwd, query) as Promise<string[]>;
  const scan = (cwd: string): Promise<Record<string, unknown>> =>
    handlers.get('fs:topFilesByTokens')!({}, cwd, 10) as Promise<Record<string, unknown>>;

  function stubGit(stdout: string | null) {
    mockGitCloneSpawn.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: unknown, stderr?: string) => void;
      if (stdout === null) cb(new Error('not a git repository'), '', '');
      else cb(null, { stdout }, ''); // envelope convention, as stubGitLsFiles
    }) as never);
  }

  let root: string;
  function subdir(name: string): string {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a.ts'), 'a');
    return d;
  }
  beforeEach(() => {
    vi.mocked(buildFineVibeIgnoreMatcher).mockReturnValue(() => false);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-cache-cap-'));
    knownPaths.push(root);
    _resetEnumerateCacheForTesting();
  });
  afterEach(() => {
    // A failed expect() must not leak a recording open-spy into the next
    // test: vi.spyOn on an already-spied method reuses the live spy, so a
    // leaked spy reports the NEXT test's own opens as unexpected calls.
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('bounds enumerateCache at the cap; a touched cwd survives, the oldest re-enumerates', async () => {
    stubGit('a.ts\n');
    const dirs = Array.from({ length: ENUMERATE_CACHE_MAX }, (_, i) => subdir(`c${i}`));
    for (const d of dirs) expect(await list(d)).toEqual(['a.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(ENUMERATE_CACHE_MAX);

    // Touch-refresh dirs[0] (recency tail), then overflow with a fresh cwd.
    expect(await list(dirs[0]!)).toEqual(['a.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(ENUMERATE_CACHE_MAX); // served from cache
    await list(subdir('overflow'));
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(ENUMERATE_CACHE_MAX + 1);

    // LRU eviction hit dirs[1] (the oldest now), not the touched dirs[0].
    await list(dirs[1]!);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(ENUMERATE_CACHE_MAX + 2);
    await list(dirs[0]!);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(ENUMERATE_CACHE_MAX + 2); // survived: no spawn
  });

  it('bounds topFilesCache at the cap; a touched cwd survives, the oldest re-reads', async () => {
    stubGit(null); // reject git: the walk fallback enumerates (readdir only)
    const openSpy = vi.spyOn(fs.promises, 'open');
    const dirs = Array.from({ length: TOP_FILES_CACHE_MAX }, (_, i) => subdir(`t${i}`));
    for (const d of dirs) {
      openSpy.mockClear();
      expect(((await scan(d)).files as unknown[]).length).toBe(1);
      expect(openSpy).toHaveBeenCalledTimes(1); // the one file was read
    }
    await scan(dirs[0]!); // touch-refresh to the recency tail
    await scan(subdir('overflow'));

    openSpy.mockClear();
    await scan(dirs[1]!); // evicted: the file is opened again
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockClear(); // the dirs[1] re-read above is the expected eviction cost
    await scan(dirs[0]!); // touched: served from the cache
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('sweepEnumerationCaches drops TTL-expired entries and keeps fresh ones', async () => {
    vi.useFakeTimers();
    stubGit('a.ts\n');
    const a = subdir('sweep-a');
    const b = subdir('sweep-b');
    expect(await list(a)).toEqual(['a.ts']); // enumerateCache: a
    expect(await scan(a)).toMatchObject({ ok: true }); // topFilesCache: a
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001); // a is now TTL-expired
    expect(await list(b)).toEqual(['a.ts']); // b enters fresh (spawn 2)
    expect(await scan(b)).toMatchObject({ ok: true }); // b's scan shares the listing

    sweepEnumerationCaches();

    expect(await list(a)).toEqual(['a.ts']);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(3);
    // b's fresh entries survived the sweep: no spawn, no file open.
    const openSpy = vi.spyOn(fs.promises, 'open');
    console.log('SPY created; calls so far:', openSpy.mock.calls.length);
    expect(await list(b)).toEqual(['a.ts']);
    expect(((await scan(b)).files as unknown[]).length).toBe(1);
    expect(mockGitCloneSpawn).toHaveBeenCalledTimes(3);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

// B1: the consent answer cache was unbounded — one canonical dir per prefix
// typed into the Add-Project dialog for the life of the session. FIFO cap;
// an eviction costs a re-prompt, the safe direction for consent.
describe('home-outside consent cache cap (B1)', () => {
  it('caps the consent cache at the cap, oldest answer evicted first', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1 } as never);
    // Keys only — the dirs never need to exist: enumeration asks before it
    // reads, so a missing dir is answered from the cache like a real one.
    const dirs = Array.from({ length: OUTSIDE_HOME_CONSENT_MAX + 1 }, (_, i) =>
      path.join(OUTSIDE_HOME, `fv-consent-cap-${i}`));
    for (const d of dirs) await handlers.get('fs:listDirs')!({}, d);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(OUTSIDE_HOME_CONSENT_MAX + 1);

    // The cap+1-th insert evicted dirs[0]; the newest answer is cached.
    await handlers.get('fs:listDirs')!({}, dirs[dirs.length - 1]!);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(OUTSIDE_HOME_CONSENT_MAX + 1);

    await handlers.get('fs:listDirs')!({}, dirs[0]!); // evicted: asks again
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(OUTSIDE_HOME_CONSENT_MAX + 2);
  });
});

// The New Project modal's "Create" verb: the renderer composes
// `<folder>/<name>` (its own `/` joins) and main creates the directory,
// answering with ITS resolved + canonical spelling. As a pre-project WRITE it
// takes fs:cloneRepo's gate shape, and a denied consent is an ERROR: the old
// fs:isDirectory `false` conflated "you pressed Cancel" with "the folder is
// not there", which is how an existing `E:\AI\Brillance` came to be reported
// as non-existent on a non-home drive.
describe('fs:ensureDirectory', () => {
  it('rejects a non-string or blank path before any filesystem work', async () => {
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      const expected = { ok: false, error: 'No directory path was given' };
      await expect(handlers.get('fs:ensureDirectory')!({}, '')).resolves.toEqual(expected);
      await expect(handlers.get('fs:ensureDirectory')!({}, '   ')).resolves.toEqual(expected);
      await expect(handlers.get('fs:ensureDirectory')!({}, 42)).resolves.toEqual(expected);
      await expect(handlers.get('fs:ensureDirectory')!({}, undefined)).resolves.toEqual(expected);
      expect(mkdir).not.toHaveBeenCalled();
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
  });

  it('answers an existing directory with its canonical path and creates nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ensure-'));
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      await expect(handlers.get('fs:ensureDirectory')!({}, dir)).resolves.toEqual({
        ok: true,
        path: fs.realpathSync(dir),
      });
      expect(mkdir).not.toHaveBeenCalled();
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers the renderer\'s `/`-joined spelling with the resolved path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ensure-'));
    try {
      // `${root}/Brillance` is what the modal sends on Windows
      // (`E:\AI` + '/' + name); the answer is the platform spelling.
      await expect(handlers.get('fs:ensureDirectory')!({}, `${root}/Brillance`)).resolves.toEqual({
        ok: true,
        path: path.join(fs.realpathSync(root), 'Brillance'),
      });
      expect(fs.statSync(path.join(root, 'Brillance')).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a path that exists as a file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ensure-'));
    const blocker = path.join(root, 'blocker');
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      fs.writeFileSync(blocker, 'x');
      await expect(handlers.get('fs:ensureDirectory')!({}, blocker)).resolves.toEqual({
        ok: false,
        error: `Not a directory: ${blocker}`,
      });
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing directory inside an allowed root recursively and answers its path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-ensure-'));
    const target = path.join(root, 'Brillance', 'nested');
    // No mockImplementation: the spy calls through, so the directory is real.
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      await expect(handlers.get('fs:ensureDirectory')!({}, target)).resolves.toEqual({
        ok: true,
        path: path.join(fs.realpathSync(root), 'Brillance', 'nested'),
      });
      expect(mkdir).toHaveBeenCalledWith(target, { recursive: true });
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a denied home-outside consent as an error and creates nothing', async () => {
    const target = path.join(OUTSIDE_HOME, 'finevibe-ensure-denied-zz');
    // A REPLACING spy: on a deny nothing may reach the filesystem, and this
    // suite runs as the real user, whose mkdir in C:\\Windows / /etc is a
    // permission error at best and a real directory at worst.
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    try {
      // The Cancel answer is pinned per test: an earlier suite leaves a
      // persistent confirm-true implementation on this mock.
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0 } as never);
      await expect(handlers.get('fs:ensureDirectory')!({}, target)).resolves.toEqual({
        ok: false,
        error: 'Location is outside your home directory and was not confirmed',
      });
      expect(dialog.showMessageBox).toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
  });

  it('creates after an explicit confirm for a home-outside directory', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    const target = path.join(OUTSIDE_HOME, 'finevibe-ensure-confirmed-zz');
    // The spy REPLACES mkdir: nothing gets created inside C:\\Windows / /etc.
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    try {
      await expect(handlers.get('fs:ensureDirectory')!({}, target)).resolves.toMatchObject({ ok: true });
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(mkdir).toHaveBeenCalledWith(target, { recursive: true });
    } finally {
      mkdir.mockRestore();
    }
  });

  it('creates a child of a consented directory with no second dialog (cascade)', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1 } as never);
    // The New Project autocomplete's enumeration: the parent's consent NAMED
    // this child, so creating it asks nothing the dialog did not publish.
    await handlers.get('fs:listDirs')!({}, OUTSIDE_HOME);
    const target = path.join(OUTSIDE_HOME, 'finevibe-ensure-cascade-zz');
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    try {
      await expect(handlers.get('fs:ensureDirectory')!({}, target)).resolves.toEqual({
        ok: true,
        path: path.join(fs.realpathSync(OUTSIDE_HOME), 'finevibe-ensure-cascade-zz'),
      });
      expect(mkdir).toHaveBeenCalledWith(target, { recursive: true });
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1); // the parent's, only
    } finally {
      mkdir.mockRestore();
    }
  });
});

// The preferences' default projects folder is an enumerate root: the New
// Project modal composes `<defaultProjectsFolder>/<name>` and probes it with
// fs:isDirectory BEFORE the project exists, so a non-home folder (the Windows
// `E:\dev` norm) has to answer honestly — under the old gate the probe opened
// a confirm whose Cancel was reported as "Directory does not exist". The READ
// gate is untouched: naming a folder for new projects never authorizes reading
// arbitrary files inside it.
describe('default projects folder in the enumerate gate', () => {
  // A real existing child dir of the home-outside root, on every platform.
  const existingChildDir = () => {
    const name = fs.readdirSync(OUTSIDE_HOME).find((n) => {
      try { return fs.statSync(path.join(OUTSIDE_HOME, n)).isDirectory(); } catch { return false; }
    });
    if (!name) throw new Error('no child dir under ' + OUTSIDE_HOME);
    return path.join(OUTSIDE_HOME, name);
  };
  const withDefaultFolder = (folder: string) =>
    vi.mocked(loadState).mockReturnValueOnce({ projects: [], preferences: { defaultProjectsFolder: folder } } as never);

  it('answers fs:isDirectory for a child with zero confirms', async () => {
    withDefaultFolder(OUTSIDE_HOME);
    await expect(handlers.get('fs:isDirectory')!({}, existingChildDir())).resolves.toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('admits fs:ensureDirectory into the same folder with zero confirms', async () => {
    withDefaultFolder(OUTSIDE_HOME);
    const target = path.join(OUTSIDE_HOME, 'fv-default-folder-zz');
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
    try {
      await expect(handlers.get('fs:ensureDirectory')!({}, target)).resolves.toMatchObject({ ok: true });
      expect(mkdir).toHaveBeenCalledWith(target, { recursive: true });
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
  });

  it('leaves the old confirm behavior unchanged when the preference is blank', async () => {
    // `path.resolve('')` is the cwd: a blank folder must admit NOTHING, or
    // every cwd subtree would join the gate.
    withDefaultFolder('');
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0 } as never);
    await expect(handlers.get('fs:isDirectory')!({}, existingChildDir())).resolves.toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalled();
  });

  it('does not widen the read gate: fs:listDir still refuses the folder', async () => {
    withDefaultFolder(OUTSIDE_HOME);
    await expect(handlers.get('fs:listDir')!({}, OUTSIDE_HOME)).resolves.toEqual([]);
  });
});

describe('P2-110: the five channels the coverage map overclaimed', () => {
  it('git:openInEditor gates the root, keeps the file inside it, and opens the joined path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-openin-'));
    try {
      expect(() => handlers.get('git:openInEditor')!({}, root, 'a.ts')).toThrow(/not within a known project/);
      expect(shell.openPath).not.toHaveBeenCalled();

      knownPaths.push(root);
      expect(() => handlers.get('git:openInEditor')!({}, root, '../escape.ts')).toThrow(/escapes the project/);
      expect(() => handlers.get('git:openInEditor')!({}, root, '.')).toThrow(/not the project root/);
      expect(shell.openPath).not.toHaveBeenCalled();

      await handlers.get('git:openInEditor')!({}, root, path.join('src', 'a.ts'));
      expect(shell.openPath).toHaveBeenCalledWith(path.join(root, 'src', 'a.ts'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('app:openExternal opens only http(s) and rejects anything else', async () => {
    const spy = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);
    expect(() => handlers.get('app:openExternal')!({}, 'file:///etc/passwd')).toThrow(/Only HTTP\(S\)/);
    expect(() => handlers.get('app:openExternal')!({}, 'javascript:alert(1)')).toThrow(/Only HTTP\(S\)/);
    expect(() => handlers.get('app:openExternal')!({}, 'not a url')).toThrow(/Invalid URL/);
    expect(spy).not.toHaveBeenCalled();

    await handlers.get('app:openExternal')!({}, 'https://example.com/x');
    expect(spy).toHaveBeenCalledWith('https://example.com/x');
  });

  it('app:getBrowserPreloadPath resolves to the browser-tab preload next to the build', () => {
    const p = handlers.get('app:getBrowserPreloadPath')!({}) as string;
    expect(p.endsWith(path.join('preload', 'preload', 'browser-tab-preload.js'))).toBe(true);
  });

  it('browser:saveScreenshot validates the payload and sanitizes the session id', async () => {
    await expect(handlers.get('browser:saveScreenshot')!({}, 's1', 'data:image/jpeg;base64,AAAA')).rejects.toThrow(/Invalid screenshot data URL/);
    await expect(handlers.get('browser:saveScreenshot')!({}, 's1', 42 as never)).rejects.toThrow(/Invalid screenshot data URL/);
    await expect(
      handlers.get('browser:saveScreenshot')!({}, 's1', 'data:image/png;base64,' + 'A'.repeat(72_000_000)),
    ).rejects.toThrow(/exceeds size limit/);

    const written = await handlers.get('browser:saveScreenshot')!({}, '../evil', 'data:image/png;base64,iVBORw0KGgo=') as string;
    try {
      expect(path.dirname(written)).toBe(path.join(os.tmpdir(), 'finevibe-screenshots'));
      expect(path.basename(written)).toMatch(/^draw-___evil-\d+\.png$/);
      expect(fs.existsSync(written)).toBe(true);
    } finally {
      fs.rmSync(written, { force: true });
    }
  });

  it('clipboard:saveImage answers null for malformed/mime/cap and saves a valid png', async () => {
    await expect(handlers.get('clipboard:saveImage')!({}, 'not a data url')).resolves.toBeNull();
    await expect(handlers.get('clipboard:saveImage')!({}, {} as never)).resolves.toBeNull();
    await expect(handlers.get('clipboard:saveImage')!({}, 'data:text/plain;base64,AAAA')).resolves.toBeNull();
    await expect(
      handlers.get('clipboard:saveImage')!({}, 'data:image/png;base64,' + 'A'.repeat(35_000_000)),
    ).resolves.toBeNull();

    const saved = await handlers.get('clipboard:saveImage')!({}, 'data:image/png;base64,iVBORw0KGgo=') as string;
    try {
      expect(typeof saved).toBe('string');
      expect(path.basename(saved)).toMatch(/^paste-\d+-[0-9a-f]{6,}\.png$/);
      expect(fs.existsSync(saved)).toBe(true);
    } finally {
      fs.rmSync(saved, { force: true });
    }
  });
});

// Per-host providers T1 (plan §2, §9): the provider channels accept a hostId
// and answer remote queries from the registry record — never by probing,
// never by falling back to the local machine.
describe('per-host provider channels (per-host providers T1)', () => {
  const freshProbeAt = new Date().toISOString();
  const lab = {
    id: 'lab', name: 'Lab', user: 'dev', host: '192.168.1.50', port: 22,
    prerequisites: { pi: { ok: true, path: '/home/dev/.local/bin/pi' } },
    lastProbeAt: freshProbeAt,
  };

  it('provider:checkBinary answers a registry host from its record, without probing', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    provider.validatePrerequisitesAsync = vi.fn(async () => true);
    provider.validatePrerequisites = vi.fn(() => { throw new Error('sync probe on a remote answer'); });
    await expect(handlers.get('provider:checkBinary')!({}, 'pi', 'lab')).resolves.toBe(true);
    await expect(handlers.get('provider:checkBinary')!({}, 'codex', 'lab')).resolves.toBe(false);
    expect(provider.validatePrerequisitesAsync).not.toHaveBeenCalled();
    // Fresh record: no background refresh either.
    expect(refreshHostTools).not.toHaveBeenCalled();
  });

  it('provider:checkBinary on a stale record answers AND fires the shared background refresh', async () => {
    const stale = { ...lab, lastProbeAt: '2020-01-01T00:00:00.000Z' };
    vi.mocked(getHost).mockReturnValue(stale as never);
    vi.mocked(refreshHostTools).mockResolvedValue({} as never);
    await expect(handlers.get('provider:checkBinary')!({}, 'pi', 'lab')).resolves.toBe(true);
    expect(refreshHostTools).toHaveBeenCalledWith(stale);
  });

  it('provider:checkBinary answers false for an unknown host', async () => {
    vi.mocked(getHost).mockReturnValue(null as never);
    await expect(handlers.get('provider:checkBinary')!({}, 'pi', 'ghost')).resolves.toBe(false);
  });

  it('hosts:tools delegates to the shared refresh (one implementation, two callers)', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    vi.mocked(refreshHostTools).mockResolvedValue({ pi: { ok: true } } as never);
    await expect(handlers.get('hosts:tools')!({}, 'lab')).resolves.toEqual({ pi: { ok: true } });
    expect(refreshHostTools).toHaveBeenCalledWith(lab);
  });

  it('hosts:syncSettings gates the payload and delegates (ids only cross the bridge)', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    vi.mocked(syncSettingsToHost).mockResolvedValue({ ok: true, steps: [] });
    await expect(handlers.get('hosts:syncSettings')!({}, 'lab', ['pi', 42, 'omp'], true)).resolves.toEqual({ ok: true, steps: [] });
    expect(syncSettingsToHost).toHaveBeenCalledWith(lab, ['pi', 'omp'], { confirmOverwrite: true });
    vi.mocked(getHost).mockReturnValue(null as never);
    await expect(handlers.get('hosts:syncSettings')!({}, 'ghost', ['pi'])).resolves.toMatchObject({ ok: false });
    await expect(handlers.get('hosts:syncSettings')!({}, 'lab', 'pi')).resolves.toMatchObject({ ok: false });
    expect(syncSettingsToHost).toHaveBeenCalledTimes(1); // gate rejects, engine untouched
  });

  it('provider:getConfig answers a registry host through the seam (T2), host-gated', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    // Audit T2 #4: the containment roots are the project paths RECORDED FOR
    // THIS HOST — never the local-disk gate roots.
    vi.mocked(loadState).mockReset().mockReturnValue({
      projects: [{ id: 'p', path: '/home/dev/dev', hostId: 'lab' }],
      preferences: {},
    } as never);
    const config = { mcpServers: [{ name: 'x', url: 'u', status: 'configured', scope: 'user', filePath: 'f' }], agents: [], skills: [], commands: [] };
    vi.mocked(getRemoteProviderConfig).mockResolvedValue(config as never);
    // posix containment against the host's project paths; '/home/dev/dev/x' is under it.
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/home/dev/dev/x', undefined, 'lab')).resolves.toBe(config);
    expect(getRemoteProviderConfig).toHaveBeenCalledWith('pi', 'lab', '/home/dev/dev/x', undefined);
  });

  it('provider:getConfig refuses a remote host that is not registered', async () => {
    vi.mocked(getHost).mockReturnValue(null as never);
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/proj', undefined, 'ghost'))
      .rejects.toThrow(/Unknown host/);
  });

  it('provider:getConfig refuses a remote projectPath known only to the LOCAL disk (audit T2 #4)', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    knownPaths.push('/home/dev/dev'); // the local gate root — the exact escape the audit named
    vi.mocked(loadState).mockReset().mockReturnValue({
      projects: [{ id: 'p', path: '/home/dev/dev', hostId: 'local' }],
      preferences: {},
    } as never);
    // The same path string on the queried host must NOT pass: it is recorded
    // for 'local', so reading it on 'lab' is refused (the host has no
    // matching gate roots — the loud no-scope refusal).
    await expect(handlers.get('provider:getConfig')!({}, 'claude', '/home/dev/dev', undefined, 'lab'))
      .rejects.toThrow(/No projects are registered for host|not within a known project of host/);
    // A host with no recorded projects of its own gets NO project scope.
    vi.mocked(loadState).mockReset().mockReturnValue({ projects: [], preferences: {} } as never);
    await expect(handlers.get('provider:getConfig')!({}, 'claude', '/home/dev/dev', undefined, 'lab'))
      .rejects.toThrow(/No projects are registered for host/);
  });

  it('provider:getConfig gates remote configDir on that host\'s profiles (SEC-03 host scope)', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    vi.mocked(loadState).mockReset().mockReturnValue({
      projects: [{ id: 'p', path: '/proj', hostId: 'lab' }], preferences: {},
      profiles: [{ id: 'p1', hostId: 'local', configDir: '/home/dev/.finevibe/profiles/p1', managed: true }],
    } as never);
    // A profile of the LOCAL host (or any host other than the queried one)
    // must not unlock a remote read.
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/proj', '/home/dev/.finevibe/profiles/p1', 'lab'))
      .rejects.toThrow(/managed profile config dir/);
    // The same configDir recorded FOR THIS HOST passes.
    vi.mocked(loadState).mockReset().mockReturnValue({
      projects: [{ id: 'p', path: '/proj', hostId: 'lab' }], preferences: {},
      profiles: [{ id: 'p1', hostId: 'lab', configDir: '/home/dev/.finevibe/profiles/p1', managed: true }],
    } as never);
    vi.mocked(getRemoteProviderConfig).mockResolvedValue({ mcpServers: [], agents: [], skills: [], commands: [] } as never);
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/proj', '/home/dev/.finevibe/profiles/p1', 'lab')).resolves.toBeDefined();
    expect(getRemoteProviderConfig).toHaveBeenLastCalledWith('pi', 'lab', '/proj', '/home/dev/.finevibe/profiles/p1');
  });

  it('provider:getConfig refuses a remote projectPath outside the host\'s projects', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    vi.mocked(loadState).mockReset().mockReturnValue({
      projects: [{ id: 'p', path: '/proj', hostId: 'lab' }],
      preferences: {},
    } as never);
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/etc', undefined, 'lab'))
      .rejects.toThrow(/not within a known project of host/);
    // Sibling-prefix escape ('/project' is not under '/proj') stays refused.
    await expect(handlers.get('provider:getConfig')!({}, 'pi', '/project', undefined, 'lab'))
      .rejects.toThrow(/not within a known project of host/);
  });

  it('profiles:provision routes remote managed provisioning over the exec lane helper', async () => {
    vi.mocked(getHost).mockReturnValue(lab as never);
    vi.mocked(provisionRemoteProfileDir).mockResolvedValue('/home/dev/.finevibe/profiles/p1');
    const out = await handlers.get('profiles:provision')!({}, 'p1', undefined, 'pi', 'lab') as { configDir: string; managed: boolean };
    expect(out).toEqual({ configDir: '/home/dev/.finevibe/profiles/p1', managed: true });
    expect(provisionRemoteProfileDir).toHaveBeenCalledWith(lab, 'p1');
    // Custom paths stay local-only: the renderer must never steer a remote mkdir.
    await expect(handlers.get('profiles:provision')!({}, 'p1', '/custom', 'pi', 'lab')).rejects.toThrow(/local-only/);
  });

  it('pty:create threads the trailing hostId down to spawnPty', async () => {
    knownPaths.push('/proj');
    await handlers.get('pty:create')!(
      {}, 'host-1', '/proj', null, false, '', 'pi', undefined, undefined, '',
      undefined, undefined, 'lab',
    );
    expect(mockSpawnPty).toHaveBeenCalled();
    expect(mockSpawnPty.mock.calls[0][13]).toBe('lab');
  });

  it('pty:create registers a REMOTE transcript sync with the HOST session dir (audit T2 #5)', async () => {
    knownPaths.push('/proj');
    await handlers.get('pty:create')!(
      {}, 'host-2', '/proj', 'cli-9', true, '', 'pi', undefined, undefined, '',
      undefined, undefined, 'lab',
    );
    // The mirror resolves against the same host-side spelling the spawn argv
    // carries — never the local userData path, which cannot exist on the host.
    expect(mockRegisterSync).toHaveBeenCalledWith(
      'host-2', 'pi', 'cli-9', '/proj', undefined,
      { sessionDir: '~/.finevibe/sessions/pi/host-2', hostId: 'lab' },
    );
    // A LOCAL launch keeps the local launch-dir grammar untouched.
    mockRegisterSync.mockClear();
    await handlers.get('pty:create')!(
      {}, 'host-3', '/proj', 'cli-9', true, '', 'pi', undefined, undefined, '',
      undefined, undefined, undefined,
    );
    const localOpts = mockRegisterSync.mock.calls[0][5] as { sessionDir?: string; hostId?: string };
    expect(localOpts.hostId).toBeUndefined();
    expect(localOpts.sessionDir).not.toContain('~/.finevibe/sessions');
  });
});

describe('remote fs rails (per-host providers, parent plan §11)', () => {
  const REMOTE = '/home/dev/dev/app';

  it('routes a registry hostId to the sftp lanes and keeps their shapes', async () => {
    vi.mocked(listRemoteDir).mockResolvedValueOnce({
      ok: true,
      entries: [{ name: 'a.ts', path: `${REMOTE}/a.ts`, isDirectory: false }],
    });
    await expect(handlers.get('fs:listDir')!({}, REMOTE, 'h1')).resolves.toEqual([
      { name: 'a.ts', path: `${REMOTE}/a.ts`, isDirectory: false },
    ]);
    expect(listRemoteDir).toHaveBeenCalledWith('h1', REMOTE);

    vi.mocked(readRemoteFile).mockResolvedValueOnce({ ok: true, content: 'x' });
    await expect(handlers.get('fs:readFile')!({}, `${REMOTE}/a.ts`, 'h1')).resolves.toEqual({ ok: true, content: 'x' });

    vi.mocked(statRemotePath).mockResolvedValue({ ok: true, isDirectory: true, size: 0, mtimeMs: 5 });
    await expect(handlers.get('fs:isDirectory')!({}, REMOTE, 'h1')).resolves.toBe(true);
    await expect(handlers.get('fs:exists')!({}, REMOTE, 'h1')).resolves.toBe(true);
    await expect(handlers.get('fs:stat')!({}, REMOTE, 'h1')).resolves.toEqual({ ok: true, size: 0, mtimeMs: 5 });
    vi.mocked(statRemotePath).mockResolvedValue({ ok: false });
    await expect(handlers.get('fs:exists')!({}, REMOTE, 'h1')).resolves.toBe(false);
    await expect(handlers.get('fs:stat')!({}, REMOTE, 'h1')).resolves.toEqual({ ok: false });
  });

  it('rail failures answer the local failure shapes, never a rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(listRemoteDir).mockRejectedValueOnce(new Error('host down'));
    await expect(handlers.get('fs:listDir')!({}, REMOTE, 'h1')).resolves.toEqual([]);
    // Every swallowed rail failure must be greppable in <logs>/finevibe.log.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fs:listDir remote failed'));
    vi.mocked(readRemoteFile).mockResolvedValueOnce({ ok: false, reason: 'binary' });
    await expect(handlers.get('fs:readFile')!({}, REMOTE, 'h1')).resolves.toEqual({ ok: false, reason: 'binary' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fs:readFile remote blocked'));
    warn.mockRestore();
  });

  it('local and absent hostId never touch the remote lanes', async () => {
    vi.mocked(listRemoteDir).mockClear();
    vi.mocked(statRemotePath).mockClear();
    await handlers.get('fs:listDir')!({}, OUTSIDE_HOME, 'local');
    await handlers.get('fs:listDir')!({}, OUTSIDE_HOME);
    await handlers.get('fs:exists')!({}, OUTSIDE_HOME, 'local');
    expect(listRemoteDir).not.toHaveBeenCalled();
    expect(statRemotePath).not.toHaveBeenCalled();
  });
});
