import { EventEmitter } from 'events';
import { searchSessions } from './session-deep-search';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CliProvider } from './providers/provider';
import * as fs from 'fs';
import { clipboard, dialog } from 'electron';
import * as os from 'os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ClipboardPastePayload } from '../shared/types';
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
const fakeWin = vi.hoisted(() => ({
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
}));

const mockSpawnPty = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<void> => {}));
const mockRegisterSync = vi.hoisted(() => vi.fn());
const mockUnregisterSync = vi.hoisted(() => vi.fn(() => { calls.push('unregister'); }));
const mockGetProvider = vi.hoisted(() => vi.fn());
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
    getName: () => 'vibeyard',
    getVersion: () => 'test',
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })) },
  shell: { openExternal: () => Promise.resolve() },
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
}));

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
  getProviderMeta: vi.fn(),
  getAllProviderMetas: vi.fn(),
  getAllProviders: vi.fn(),
}));

vi.mock('./store', () => ({
  loadState: vi.fn(() => ({ projects: [], preferences: {} })),
  saveState: vi.fn(),
  getKnownProjectPaths: () => knownPaths,
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
vi.mock('./platform', autoStub);
vi.mock('./chrome-import/importer', autoStub);
vi.mock('./settings-guard', autoStub);
vi.mock('./vibeyardignore', autoStub);
vi.mock('./close-state', autoStub);
vi.mock('./profiles', autoStub);
vi.mock('./claude-keychain', autoStub);
vi.mock('../shared/token-estimate', autoStub);

import { registerIpcHandlers } from './ipc-handlers';
import { isManagedMcpConfigDir } from './claude-cli';
import { loadState } from './store';
import { shouldWarnStatusLine, getDirConsent, recordDirConsent } from './settings-guard';
import { cleanupSessionStatus } from './hook-status';
import { analyzeReadiness } from './readiness/analyzer';
import { detectRepo } from './github-cli';
import { getAllProviders } from './providers/registry';

function makeProvider(): CliProvider {
  return {
    // hookStatus off keeps the post-spawn settings-warning block out of the way.
    meta: { capabilities: { hookStatus: false } },
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
  calls.length = 0;
  handlers.clear();
  knownPaths.length = 0;
  provider = makeProvider();
  mockGetProvider.mockReturnValue(provider);
  // pty:create gates a renderer-supplied configDir through the managed
  // profile allowlist (claude-cli, autoStubbed here): tests that want the
  // gate exercised override it per-test.
  vi.mocked(isManagedMcpConfigDir).mockReturnValue(true);
  registerIpcHandlers();
});

describe('project file read boundary', () => {
  it('rejects a link inside a project whose target is outside it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-ipc-test-'));
    try {
      const project = path.join(root, 'project');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(project);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
      fs.symlinkSync(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      knownPaths.push(project);
      const read = handlers.get('fs:readFile')!;
      expect(read({}, path.join(project, 'linked', 'secret.txt'))).toEqual({ ok: false, reason: 'error' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a text file larger than the bounded reader limit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-ipc-test-'));
    try {
      const large = path.join(root, 'large.txt');
      const fd = fs.openSync(large, 'w');
      try { fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
      knownPaths.push(root);
      const read = handlers.get('fs:readFile')!;
      expect(read({}, large)).toEqual({ ok: false, reason: 'error' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('git:* root gate', () => {
  it('blocks git handlers aimed at a cwd the renderer invented', async () => {
    const gitStatus = await import('./git-status');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
    try {
      knownPaths.push(root);
      handlers.get('git:getStatus')!({}, root);
      expect(vi.mocked(gitStatus.getGitStatus)).toHaveBeenCalledWith(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a watched worktree git-capable after its project is closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
    expect(handlers.get('fs:readFile')!({}, 'C:\\')).toEqual({ ok: false, reason: 'error' });
  });
});

describe('readiness/github git-executing handlers share the root gate', () => {
  it('blocks a cwd the renderer invented before any git runs', async () => {
    // Both handlers shell out to git in the named cwd (`git ls-files`,
    // `git remote get-url`) - the same sink the 13 git:* handlers gate.
    // The analyzer/detectRepo stubs are the autoStub proxies; importing them
    // statically is what lets these assertions see the calls.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
    try {
      const outside = path.join(root, 'invented');
      fs.mkdirSync(outside);

      expect(() => handlers.get('readiness:analyze')!({}, outside))
        .toThrow(/not within a known project/);
      expect(() => handlers.get('github:detectRepo')!({}, outside))
        .toThrow(/not within a known project/);
      expect(vi.mocked(analyzeReadiness)).not.toHaveBeenCalled();
      expect(vi.mocked(detectRepo)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs them for a known project, on the resolved path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-git-gate-'));
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
});

const OUTSIDE_HOME = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

describe('pty launch path gate (P1-15)', () => {
  it('refuses a cwd outside every known project before any side effect', async () => {
    // pty:create is the one process-launch channel: it runs the provider
    // CLI with renderer-supplied flags in a renderer-supplied cwd. The gate
    // must fire before provider hooks, transcript sync, and the spawn.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-pty-gate-'));
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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-pty-gate-'));
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
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.vibeyard-listdirs-'));
    try {
      fs.mkdirSync(path.join(homeDir, 'proj'));
      const dirs = await handlers.get('fs:listDirs')!({}, homeDir);
      expect(dirs).toEqual([path.join(homeDir, 'proj')]);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('fs:isDirectory home gate (P2-38)', () => {
  it('reports false for a home-outside directory - same oracle fs:exists denies', () => {
    expect(handlers.get('fs:isDirectory')!({}, OUTSIDE_HOME)).toBe(false);
  });

  it('reports true for a home-tree directory (pre-project add flow)', () => {
    const homeDir = fs.mkdtempSync(path.join(os.homedir(), '.vibeyard-isdir-'));
    try {
      expect(handlers.get('fs:isDirectory')!({}, homeDir)).toBe(true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('fs:unwatchDir gate (P2-30)', () => {
  it('mirrors fs:watchDir: a blocked path never reaches the watcher', async () => {
    const fileWatcher = await import('./file-watcher');
    handlers.get('fs:unwatchDir')!({}, OUTSIDE_HOME);
    expect(fileWatcher.unwatchDir).not.toHaveBeenCalled();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-watch-gate-'));
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
  it('denies at the boundary: an unallowlisted configDir never reaches a provider scan root', () => {
    provider.getTranscriptPath = vi.fn(() => null);
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    const event: { returnValue?: unknown } = {};
    handlers.get('session:transcriptExistsSync')!(event, 'claude', 'cli-1', '/proj', '/foreign/dir', undefined);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
    expect(event.returnValue).toBe(false);
  });
  it('passes an allowlisted configDir to the provider; null path still means absent', () => {
    provider.getTranscriptPath = vi.fn(() => null);
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(true);
    const event: { returnValue?: unknown } = {};
    handlers.get('session:transcriptExistsSync')!(event, 'claude', 'cli-1', '/proj', '/profiles/work', undefined);
    expect(isManagedMcpConfigDir).toHaveBeenCalledWith('/profiles/work');
    expect(provider.getTranscriptPath).toHaveBeenCalledWith('cli-1', '/proj', '/profiles/work', undefined);
    expect(event.returnValue).toBe(false);
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
  complete.forEach(resolve => resolve());
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

  it('reads Explorer copies from CF_HDROP with the wide flag at offset 12', async () => {
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

  it('reads pre-wide CF_HDROP senders through the single-byte decode', async () => {
    formatsWith('CF_HDROP');
    bufferFor('CF_HDROP', () => dropfiles('D:\\notes\\a.txt\0\0', false));

    expect((await readPaste()).files).toEqual(['D:\\notes\\a.txt']);
  });

  it('reads browser copies from FileNameW', async () => {
    formatsWith('FileNameW');
    bufferFor('FileNameW', () => Buffer.from('C:\\tmp\\shot.png\0C:\\tmp\\clip.mp4\0\0', 'utf16le'));

    expect((await readPaste()).files).toEqual(['C:\\tmp\\shot.png', 'C:\\tmp\\clip.mp4']);
  });

  it('reads Finder copies from the XML plist and decodes entities', async () => {
    formatsWith('NSFilenamesPboardType');
    bufferFor('NSFilenamesPboardType', () => Buffer.from(
      '<array><string>/tmp/a &amp; b.txt</string><string>/tmp/caf&#xE9;.md</string></array>',
      'utf8',
    ));

    expect((await readPaste()).files).toEqual(['/tmp/a & b.txt', '/tmp/café.md']);
  });

  it('reads file-manager copies on Linux from text/uri-list, skipping web links', async () => {
    const target = '/tmp/report.pdf';
    // A rootless file URL is not absolute on Windows, so build the URL from a
    // path the platform considers absolute; the handler decodes it back.
    const uri = pathToFileURL(target).href;
    vi.mocked(clipboard.read).mockReturnValue(`${uri}\r\nhttps://example.com/x\r\n`);

    expect((await readPaste()).files).toEqual([fileURLToPath(uri)]);
  });

  it('drops relative names and keeps only paths a CLI can read', async () => {
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
        foreignStatusLineCommand: '/usr/bin/other-statusline',
      }),
    );
  });

  it('consults the per-dir consent record for a profiled session', async () => {
    await create('ui-1', null, { configDir: '/profiles/work' });
    expect(getDirConsent).toHaveBeenCalledWith(expect.anything(), '/profiles/work');
  });

  it('settings:reinstall repairs the profile dir the banner was computed from', async () => {
    await handlers.get('settings:reinstall')!({}, 'claude', '/profiles/work');
    expect(provider.reinstallSettings).toHaveBeenCalledWith('/profiles/work');
  });

  it('settings:reinstall refuses a configDir outside the managed-profile allowlist', async () => {
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    const result = await handlers.get('settings:reinstall')!({}, 'claude', '/home/attacker/.claude');
    expect(result).toMatchObject({ success: false });
    expect(provider.reinstallSettings).not.toHaveBeenCalled();
  });

  it('settings:reinstall without a configDir keeps repairing the default dir', async () => {
    await handlers.get('settings:reinstall')!({}, 'claude');
    expect(provider.reinstallSettings).toHaveBeenCalledWith(undefined);
  });

  it('settings:declineStatusLine records the per-dir Keep and gates unmanaged dirs', () => {
    handlers.get('settings:declineStatusLine')!({}, '/profiles/work', '/usr/bin/other-statusline');
    expect(recordDirConsent).toHaveBeenCalledWith('/profiles/work', 'declined', '/usr/bin/other-statusline');
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    handlers.get('settings:declineStatusLine')!({}, '/home/attacker/.claude', '/x');
    expect(recordDirConsent).toHaveBeenCalledTimes(1);
  });
});

describe('team-agent install/remove scope (P2-116 / P2-117)', () => {
  // Install stamps this frontmatter marker; remove gates every unlink on it.
  const markerLine = (slug: string) => `# installed-by: vibeyard ${slug}`;
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-agents-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('install stamps the vibeyard marker and threads a managed configDir to claude only', async () => {
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
    fs.writeFileSync(userFile, '---\nname: security-auditor\n---\nuser-authored, never installed by Vibeyard\n');
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
