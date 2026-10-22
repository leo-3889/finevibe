import { vi } from 'vitest';
import * as path from 'path';
import { isWin } from '../platform';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  // getTranscriptPath walks ~/.gemini/tmp through these (P1-21/P2-54 tests).
  readdirSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  openSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  // hook-status.ts calls os.tmpdir() at module load (STATUS_DIR); the
  // import chain gemini-provider → gemini-hooks → … → hook-status hits it
  // before any test runs, so the mock must carry it.
  tmpdir: () => '/tmp',
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../pty-manager', () => ({
  getFullPath: vi.fn(() => isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin'),
  getFullPathAsync: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../gemini-config', () => ({
  getGeminiConfig: vi.fn(async () => ({ mcpServers: [], agents: [], skills: [], commands: [] })),
}));

vi.mock('../config-watcher', () => ({
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
}));

vi.mock('../gemini-hooks', () => ({
  installGeminiHooks: vi.fn(),
  validateGeminiHooks: vi.fn(() => ({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} })),
  cleanupGeminiHooks: vi.fn(),
  SESSION_ID_VAR: 'FINEVIBE_SESSION_ID',
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { GeminiProvider, _resetCachedPath } from './gemini-provider';
import { getGeminiConfig } from '../gemini-config';
import { startConfigWatcher, stopConfigWatcher } from '../config-watcher';
import { installGeminiHooks, validateGeminiHooks, cleanupGeminiHooks } from '../gemini-hooks';
import { invalidateBinaryCache } from './resolve-binary';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockExecSync = vi.mocked(execSync);
const fileStat = { isFile: () => true } as fs.Stats;
const mockGetGeminiConfig = vi.mocked(getGeminiConfig);
const mockStartConfigWatcher = vi.mocked(startConfigWatcher);
const mockStopConfigWatcher = vi.mocked(stopConfigWatcher);
const mockInstallGeminiHooks = vi.mocked(installGeminiHooks);
const mockValidateGeminiHooks = vi.mocked(validateGeminiHooks);
const mockCleanupGeminiHooks = vi.mocked(cleanupGeminiHooks);

let provider: GeminiProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  _resetCachedPath();
  invalidateBinaryCache();
  provider = new GeminiProvider();
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('gemini');
    expect(provider.meta.displayName).toBe('Gemini CLI');
    expect(provider.meta.binaryName).toBe('gemini');
  });

  it('has sessionResume, hookStatus, and configReading capabilities enabled', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(false);
    expect(caps.contextWindow).toBe(false);
    expect(caps.hookStatus).toBe(true);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(false);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.planModeArg).toBe('--approval-mode=plan');
  });

  it('has defaultContextWindowSize of 1,000,000', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(1_000_000);
  });
});

describe('resolveBinaryPath', () => {
  const firstCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'gemini.cmd')
    : '/usr/local/bin/gemini';

  it('returns candidate path when statSync finds a file', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
  });

  it(`falls back to ${isWin ? 'where' : 'which'} gemini when no candidate exists`, () => {
    mockExecSync.mockReturnValue('/some/other/path/gemini\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/gemini');
  });

  it('falls back to bare "gemini" when both candidate and which fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.resolveBinaryPath()).toBe('gemini');
  });

  it('caches result on subsequent calls while the binary exists', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    provider.resolveBinaryPath();
    const probesAfterFirst = mockExecSync.mock.calls.length;
    // P2-26: cache hit = one stat, zero subprocess re-probes.
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
    expect(mockExecSync).toHaveBeenCalledTimes(probesAfterFirst);
  });

  it('re-resolves when the cached binary disappears', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    provider.resolveBinaryPath();
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mockExecSync.mockReturnValue('/some/other/path/gemini\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/gemini');
  });
});

describe('validatePrerequisites', () => {
  const validateCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'gemini.cmd')
    : '/opt/homebrew/bin/gemini';

  it('returns ok when binary found via statSync', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === validateCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns ok when binary found via which', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('/resolved/gemini\n' as any);
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns not ok when binary not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.validatePrerequisites()).toBe(false);
  });
});

describe('buildEnv', () => {
  it('sets PATH to the augmented PATH', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.PATH).toBe(isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin');
  });

  it('sets FINEVIBE_SESSION_ID to the session ID', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.FINEVIBE_SESSION_ID).toBe('sess-123');
  });

  it('preserves existing env vars', () => {
    const env = provider.buildEnv('sess-123', { GEMINI_API_KEY: 'key123', OTHER: 'val' });
    expect(env.GEMINI_API_KEY).toBe('key123');
    expect(env.OTHER).toBe('val');
  });
});

describe('buildArgs', () => {
  it('returns ["-r", id] when isResume=true with cliSessionId', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '' });
    expect(args).toEqual(['-r', 'sid-1']);
  });

  it('returns [] when isResume=false with cliSessionId', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('returns [] when cliSessionId is null', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('splits extraArgs on whitespace and appends', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--model gemini-2.5-flash  --sandbox' });
    expect(args).toEqual(['--model', 'gemini-2.5-flash', '--sandbox']);
  });

  it('combines resume args and extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '--model gemini-2.5-flash' });
    expect(args).toEqual(['-r', 'sid-1', '--model', 'gemini-2.5-flash']);
  });

  it('tokenizes quoted extra args (spaces stay inside one argument)', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--model "my model"' });
    expect(args).toEqual(['--model', 'my model']);
  });

  it('preserves empty quoted extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--flag ""' });
    expect(args).toEqual(['--flag', '']);
  });

  it('appends -i flag when initialPrompt is provided', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'Fix the hooks config' });
    expect(args).toEqual(['-i', 'Fix the hooks config']);
  });

  it('does not append -i flag when initialPrompt is absent', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('does not emit a system-prompt flag (Gemini CLI has none; team chat is gated off this provider)', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' });
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('You are the CMO.');
  });

  it('declares systemPromptInjection capability as false', () => {
    expect(provider.meta.capabilities.systemPromptInjection).toBe(false);
  });
});

describe('getShiftEnterSequence', () => {
  it('returns null', () => {
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});

describe('hooks integration', () => {
  it('installHooks delegates to installGeminiHooks', async () => {
    await provider.installHooks();
    expect(mockInstallGeminiHooks).toHaveBeenCalled();
  });

  it('validateSettings delegates to validateGeminiHooks', () => {
    const result = provider.validateSettings();
    expect(mockValidateGeminiHooks).toHaveBeenCalled();
    expect(result).toEqual({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });
  });

  it('cleanup calls cleanupGeminiHooks and stopConfigWatcher', () => {
    provider.cleanup();
    expect(mockStopConfigWatcher).toHaveBeenCalled();
    expect(mockCleanupGeminiHooks).toHaveBeenCalled();
  });

  it('reinstallSettings delegates to installGeminiHooks', () => {
    provider.reinstallSettings();
    expect(mockInstallGeminiHooks).toHaveBeenCalled();
  });
});

describe('other methods', () => {
  it('getConfig delegates to gemini config reader', async () => {
    const config = { mcpServers: [{ name: 'a', url: 'b', status: 'configured', scope: 'user' as const, filePath: '/x' }], agents: [], skills: [], commands: [] };
    mockGetGeminiConfig.mockResolvedValueOnce(config);
    await expect(provider.getConfig('/some/path')).resolves.toEqual(config);
    expect(mockGetGeminiConfig).toHaveBeenCalledWith('/some/path');
  });

  it('installStatusScripts does not throw', () => {
    expect(() => provider.installStatusScripts()).not.toThrow();
  });

  it('starts a gemini config watcher', () => {
    const win = { id: 1 } as any;
    provider.startConfigWatcher(win, '/project');
    expect(mockStartConfigWatcher).toHaveBeenCalledWith(win, '/project', 'gemini');
  });
});

describe('getTranscriptPath', () => {
  const TMP_ROOT = path.join('/mock/home', '.gemini', 'tmp');
  const REQUESTED = '0f8e2f6a-1e2c-4a44-9b3f-2a1d0c9b8a77';
  // Same first 8 chars as REQUESTED — the only identity a filename encodes.
  const FOREIGN = '0f8e2f6a-99ff-4a44-9b3f-2a1d0c9b8a77';
  const mockReaddirSync = vi.mocked<(p: string) => string[]>(fs.readdirSync);
  const mockReadFileSync = vi.mocked<(p: string, enc: string) => string>(fs.readFileSync);
  const mockOpenSync = vi.mocked<(p: string, f: string) => number>(fs.openSync);
  const mockReadSync = vi.mocked<(fd: number, buf: Buffer, off: number, len: number, pos: number) => number>(fs.readSync);

  /**
   * Fake `~/.gemini/tmp`: project key dirs with a `.project_root` (Gemini keys
   * them by the REAL cwd it ran under) and chats dirs of transcript files with
   * mtimes. A file with a `head` is readable; one without throws on open.
   * `readHeadSync` goes through openSync/readSync, so heads are served by fd.
   */
  function mockGeminiTree(opts: {
    projects: Array<{ key: string; root: string }>;
    chats: Record<string, Array<{ file: string; mtime: number; head?: string }>>;
  }): void {
    const heads = new Map<string, string>();
    for (const [key, files] of Object.entries(opts.chats)) {
      for (const f of files) {
        if (f.head !== undefined) heads.set(path.join(TMP_ROOT, key, 'chats', f.file), f.head);
      }
    }
    const fdToPath = new Map<number, string>();
    let nextFd = 100;
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockImplementation((p: string) => {
      if (p === TMP_ROOT) return opts.projects.map((x) => x.key);
      for (const [key, files] of Object.entries(opts.chats)) {
        if (p === path.join(TMP_ROOT, key, 'chats')) return files.map((f) => f.file);
      }
      return [];
    });
    mockReadFileSync.mockImplementation((p: string) => {
      for (const x of opts.projects) {
        if (p === path.join(TMP_ROOT, x.key, '.project_root')) return x.root;
      }
      throw new Error('ENOENT');
    });
    mockStatSync.mockImplementation((p: string) => {
      for (const [key, files] of Object.entries(opts.chats)) {
        for (const f of files) {
          if (p === path.join(TMP_ROOT, key, 'chats', f.file)) return { mtimeMs: f.mtime } as fs.Stats;
        }
      }
      throw new Error('ENOENT');
    });
    mockOpenSync.mockImplementation((p: string) => {
      if (!heads.has(p)) throw new Error('EACCES: unreadable transcript');
      const fd = nextFd++;
      fdToPath.set(fd, p);
      return fd;
    });
    mockReadSync.mockImplementation((fd: number, buffer: Buffer, offset: number, length: number) => {
      const head = heads.get(fdToPath.get(fd) as string) ?? '';
      const n = Math.min(Buffer.byteLength(head), length);
      buffer.write(head, offset, n);
      return n;
    });
  }

  it('returns the transcript whose head records the full session id', () => {
    const file = 'session-2026-10-20T10-00-0f8e2f6a.json';
    mockGeminiTree({
      projects: [{ key: 'proj', root: '/real/project' }],
      chats: { proj: [{ file, mtime: 2000, head: JSON.stringify({ sessionId: REQUESTED }) }] },
    });
    expect(provider.getTranscriptPath(REQUESTED, '/real/project'))
      .toBe(path.join(TMP_ROOT, 'proj', 'chats', file));
  });

  it('never returns the newest prefix-match when no file verifies the full id (P1-21)', () => {
    mockGeminiTree({
      projects: [{ key: 'proj', root: '/real/project' }],
      chats: { proj: [
        { file: 'session-2026-10-20T10-00-0f8e2f6a.json', mtime: 3000, head: JSON.stringify({ sessionId: FOREIGN }) },
        { file: 'session-2026-10-19T09-00-0f8e2f6a.json', mtime: 2000 }, // head unreadable
      ] },
    });
    expect(provider.getTranscriptPath(REQUESTED, '/real/project')).toBeNull();
  });

  it('does not cross-attach the indexed foreign transcript of the real-cwd project to an overridden-cwd session (P2-54)', () => {
    // Gemini keys the chats dir by the REAL cwd it ran under. This tab launched
    // its CLI with an overridden cwd, so its transcript lives under a project
    // key that never matches the project path; the indexed dir of the real
    // project holds only a FOREIGN session sharing the 8-char filename prefix —
    // the newest-mtime entry, exactly what the removed fallback returned.
    mockGeminiTree({
      projects: [{ key: 'real-proj', root: '/real/project' }],
      chats: { 'real-proj': [
        { file: 'session-2026-10-20T10-00-0f8e2f6a.json', mtime: 5000, head: JSON.stringify({ sessionId: FOREIGN }) },
      ] },
    });
    expect(provider.getTranscriptPath(REQUESTED, '/real/project')).toBeNull();
  });

  it('returns null when no file matches the 8-char prefix', () => {
    mockGeminiTree({
      projects: [{ key: 'proj', root: '/real/project' }],
      chats: { proj: [{ file: 'session-2026-10-20T10-00-deadbeef.json', mtime: 1, head: '{}' }] },
    });
    expect(provider.getTranscriptPath(REQUESTED, '/real/project')).toBeNull();
  });
});
