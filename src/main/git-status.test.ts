import { vi } from 'vitest';
import type { ExecFileException } from 'child_process';

// Mock child_process and fs before importing the module
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  promises: {
    rm: vi.fn(),
    open: vi.fn(),
    stat: vi.fn(),
    chmod: vi.fn(),
  },
}));

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { getGitStatus, getGitFiles, getGitDiff, getGitWorktrees, gitDiscardFile, checkoutGitBranch, createGitBranch, getGitRemoteUrl, gitStageFile, gitCandidatePaths, getGitBinary, resetGitBinaryCacheForTesting, primeGitBinaryForTesting } from './git-status';
import { whichCmd } from './platform';

const mockExecFile = vi.mocked(execFile);
const mockRm = vi.mocked(fsPromises.rm);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockStat = vi.mocked(fsPromises.stat);
const mockChmod = vi.mocked(fsPromises.chmod);

function simulateExecFile(err: ExecFileException | null, stdout: string) {
  mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
    (callback as (err: ExecFileException | null, stdout: string) => void)(err, stdout);
    return undefined as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Order-independence: clearAllMocks (mockClear) does NOT drain queued
  // mockImplementationOnce entries. A shuffled predecessor's unconsumed
  // version-probe Once shifted every simulateExecFile by one call, leaving
  // a second git command against the bare vi.fn() (callback never fires ->
  // 15s timeout). Drain the queue to the factory default every case.
  mockExecFile.mockReset();
  // Spawns must use the plain 'git' the suites assert against, and the
  // git-binary probe (which would consume the simulateExecFile queue)
  // must never fire.
  primeGitBinaryForTesting('git');
});

describe('getGitStatus', () => {
  it('parses branch name', async () => {
    simulateExecFile(null, '# branch.head main\n');
    const status = await getGitStatus('/test');
    expect(status.isGitRepo).toBe(true);
    expect(status.branch).toBe('main');
  });

  it('parses ahead/behind', async () => {
    simulateExecFile(null, '# branch.head main\n# branch.ab +3 -1\n');
    const status = await getGitStatus('/test');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(1);
  });

  it('counts staged changes (X != .)', async () => {
    simulateExecFile(null, '1 M. N... 100644 100644 100644 abc def file.ts\n');
    const status = await getGitStatus('/test');
    expect(status.staged).toBe(1);
    expect(status.modified).toBe(0);
  });

  it('counts working tree changes (Y != .)', async () => {
    simulateExecFile(null, '1 .M N... 100644 100644 100644 abc def file.ts\n');
    const status = await getGitStatus('/test');
    expect(status.staged).toBe(0);
    expect(status.modified).toBe(1);
  });

  it('counts both staged and modified', async () => {
    simulateExecFile(null, '1 MM N... 100644 100644 100644 abc def file.ts\n');
    const status = await getGitStatus('/test');
    expect(status.staged).toBe(1);
    expect(status.modified).toBe(1);
  });

  it('bounds git status with an 8 MiB maxBuffer (C5G-05)', async () => {
    simulateExecFile(null, '# branch.head main\n');
    await getGitStatus('/test');
    const opts = mockExecFile.mock.calls[0][2] as { maxBuffer: number };
    expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
  });

  it('classifies ENOBUFS as errored, not a clean tree (C5G-05)', async () => {
    const enobufs = Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }) as ExecFileException;
    simulateExecFile(enobufs, '');
    const status = await getGitStatus('/test');
    // A porcelain listing past maxBuffer must NOT read as NOT_A_REPO/0 changes:
    // the renderer needs `errored` to show a message, not a clean-tree lie.
    expect(status.errored).toBe(true);
    expect(status.isGitRepo).toBe(true);
    expect(status.modified).toBe(0);
  });

  it('raises getGitFiles maxBuffer to 8 MiB (C5G-05)', async () => {
    simulateExecFile(null, '');
    await getGitFiles('/test');
    const opts = mockExecFile.mock.calls[0][2] as { maxBuffer: number };
    expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
  });

  it('counts rename entries (type 2)', async () => {
    simulateExecFile(null, '2 R. N... 100644 100644 100644 abc def R100\told.ts\tnew.ts\n');
    const status = await getGitStatus('/test');
    expect(status.staged).toBe(1);
  });

  it('counts unmerged entries', async () => {
    simulateExecFile(null, 'u UU N... 100644 100644 100644 100644 abc def ghi file.ts\n');
    const status = await getGitStatus('/test');
    expect(status.conflicted).toBe(1);
  });

  it('counts untracked files', async () => {
    simulateExecFile(null, '? new-file.ts\n? another.ts\n');
    const status = await getGitStatus('/test');
    expect(status.untracked).toBe(2);
  });

  it('returns NOT_A_REPO on error', async () => {
    simulateExecFile(new Error('not a git repo') as ExecFileException, '');
    const status = await getGitStatus('/test');
    expect(status.isGitRepo).toBe(false);
    expect(status.branch).toBeNull();
  });

  it('handles complex output with all entry types', async () => {
    const output = [
      '# branch.head feature/test',
      '# branch.ab +2 -0',
      '1 M. N... 100644 100644 100644 abc def staged.ts',
      '1 .M N... 100644 100644 100644 abc def modified.ts',
      '2 R. N... 100644 100644 100644 abc def R100\told.ts\tnew.ts',
      'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts',
      '? untracked.ts',
      '',
    ].join('\n');

    simulateExecFile(null, output);
    const status = await getGitStatus('/test');

    expect(status.branch).toBe('feature/test');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(0);
    expect(status.staged).toBe(2); // M. + R.
    expect(status.modified).toBe(1); // .M
    expect(status.conflicted).toBe(1);
    expect(status.untracked).toBe(1);
  });
});

describe('getGitFiles', () => {
  it('returns file entries with correct status and area', async () => {
    simulateExecFile(null, '1 A. N... 100644 100644 100644 abc def added.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toEqual([{ path: 'added.ts', status: 'added', area: 'staged' }]);
  });

  it('creates entries for both staged and working changes', async () => {
    simulateExecFile(null, '1 MM N... 100644 100644 100644 abc def both.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ path: 'both.ts', status: 'modified', area: 'staged' });
    expect(files[1]).toEqual({ path: 'both.ts', status: 'modified', area: 'working' });
  });

  it('handles rename entries with NUL-delimited original path', async () => {
    simulateExecFile(null, '2 R. N... 100644 100644 100644 abc def R100 new.ts\0old.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toEqual([{ path: 'new.ts', status: 'renamed', area: 'staged' }]);
  });

  it('preserves spaces in tracked and conflicted paths', async () => {
    simulateExecFile(null,
      '1 M. N... 100644 100644 100644 abc def my notes.txt\0' +
      'u UU N... 100644 100644 100644 100644 abc def ghi merge conflict.txt\0');
    expect(await getGitFiles('/test')).toEqual([
      { path: 'my notes.txt', status: 'modified', area: 'staged' },
      { path: 'merge conflict.txt', status: 'conflicted', area: 'conflicted' },
    ]);
  });

  it('handles deleted files', async () => {
    simulateExecFile(null, '1 D. N... 100644 100644 100644 abc def removed.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toEqual([{ path: 'removed.ts', status: 'deleted', area: 'staged' }]);
  });

  it('handles unmerged files', async () => {
    simulateExecFile(null, 'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toEqual([{ path: 'conflict.ts', status: 'conflicted', area: 'conflicted' }]);
  });

  it('handles untracked files', async () => {
    simulateExecFile(null, '? new-file.ts\0');
    const files = await getGitFiles('/test');
    expect(files).toEqual([{ path: 'new-file.ts', status: 'untracked', area: 'untracked' }]);
  });

  it('returns empty array on error', async () => {
    simulateExecFile(new Error('not a git repo') as ExecFileException, '');
    const files = await getGitFiles('/test');
    expect(files).toEqual([]);
  });
});

describe('getGitDiff', () => {
  it('returns formatted diff for untracked files', async () => {
    const data = Buffer.from('line1\nline2\n');
    vi.mocked(fsPromises.open).mockResolvedValueOnce({
      stat: async () => ({ size: data.length }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: data.copy(buffer, offset, position, position + length) }),
      close: async () => {},
    } as any);
    const diff = await getGitDiff('/test', 'new.ts', 'untracked');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/new.ts');
    expect(diff).toContain('+line1');
    expect(diff).toContain('+line2');
  });

  it('returns error message when untracked file cannot be read', async () => {
    vi.mocked(fsPromises.open).mockRejectedValueOnce(new Error('ENOENT'));
    const diff = await getGitDiff('/test', 'missing.ts', 'untracked');
    expect(diff).toBe('(unable to read file)');
  });

  it('calls git diff --cached for staged files', async () => {
    simulateExecFile(null, 'diff --cached output');
    await getGitDiff('/test', 'file.ts', 'staged');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', '--cached', '--', 'file.ts'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('calls git diff for working tree files', async () => {
    simulateExecFile(null, 'diff output');
    await getGitDiff('/test', 'file.ts', 'working');

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['diff', '--', 'file.ts'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns "(no diff available)" on error with no stdout', async () => {
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      (callback as (err: ExecFileException | null, stdout: string) => void)(
        new Error('err') as ExecFileException,
        '',
      );
      return undefined as never;
    });
    const diff = await getGitDiff('/test', 'file.ts', 'working');
    expect(diff).toBe('(no diff available)');
  });
});

describe('gitDiscardFile', () => {
  // P1-17: the untracked branch is a real recursive delete. Every discard
  // must first prove the cwd is inside a git WORKING TREE
  // (`rev-parse --show-toplevel`), the target is not the tree root, git
  // reports the target as untracked, and the target carries no tracked
  // content — then, and only then, does fs.rm run.
  const workingTree = (toplevel = '/repo') => simulateExecFile(null, `${toplevel}\n`);
  const listing = (out: string) => simulateExecFile(null, out);

  it('removes an untracked file after git verifies the tree and the untracked status', async () => {
    workingTree();
    listing('new.ts\n'); // ls-files --others: the target is untracked
    listing('');         // ls-files: no tracked content at the target
    mockRm.mockResolvedValueOnce(undefined);
    await gitDiscardFile('/repo', 'new.ts', 'untracked');
    expect(mockRm).toHaveBeenCalledWith(path.join('/repo', 'new.ts'), { recursive: true, force: true });
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: '/repo' }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', 'new.ts'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('removes an untracked folder only after git lists its files as untracked', async () => {
    workingTree();
    listing('e2e/a.spec.ts\ne2e/b.spec.ts\n');
    listing('');
    mockRm.mockResolvedValueOnce(undefined);
    await gitDiscardFile('/repo', 'e2e/', 'untracked');
    expect(mockRm).toHaveBeenCalledWith(path.join('/repo', 'e2e/'), { recursive: true, force: true });
  });

  it('refuses an empty filePath and never reaches fs.rm', async () => {
    // The P1-17 kill chain: git:discardFile(root, '', 'untracked') used to
    // run rm(root, {recursive:true}) — the whole tree, no repo check.
    await expect(gitDiscardFile('/repo', '', 'untracked')).rejects.toThrow();
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses a path that resolves to the working-tree root', async () => {
    workingTree('/repo');
    await expect(gitDiscardFile('/repo', '.', 'untracked')).rejects.toThrow();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('refuses untracked discard when the cwd is not a git working tree', async () => {
    // The watched ~/.claude grant: rev-parse fails → nothing may be deleted.
    simulateExecFile({ message: 'fatal: not a git repository' } as ExecFileException, '');
    await expect(gitDiscardFile('/home/user/.claude', 'settings.json', 'untracked')).rejects.toThrow();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('refuses a path git does not report as untracked', async () => {
    // Covers tracked, ignored and missing targets — rm never runs blind.
    workingTree();
    listing('');
    await expect(gitDiscardFile('/repo', 'settings.json', 'untracked')).rejects.toThrow();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('refuses a folder that carries tracked files', async () => {
    workingTree();
    listing('src/temp.ts\n');  // something untracked under src/
    listing('src/index.ts\n'); // tracked content under src/
    await expect(gitDiscardFile('/repo', 'src', 'untracked')).rejects.toThrow();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('runs git checkout for working-tree changes', async () => {
    workingTree();
    listing(''); // checkout
    await gitDiscardFile('/repo', 'file.ts', 'working');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['checkout', '--', 'file.ts'],
      { cwd: '/repo', timeout: 5000 },
      expect.any(Function),
    );
  });
});

describe('getGitWorktrees', () => {
  it('parses porcelain output with main and linked worktree', async () => {
    const output = [
      'worktree /repo',
      'HEAD abc1234567890abcdef1234567890abcdef123456',
      'branch refs/heads/main',
      '',
      'worktree /repo-feature',
      'HEAD def4567890abcdef1234567890abcdef1234567890',
      'branch refs/heads/feature-branch',
      '',
    ].join('\n');

    simulateExecFile(null, output);
    const worktrees = await getGitWorktrees('/repo');

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: '/repo',
      head: 'abc1234567890abcdef1234567890abcdef123456',
      branch: 'main',
      isBare: false,
    });
    expect(worktrees[1]).toEqual({
      path: '/repo-feature',
      head: 'def4567890abcdef1234567890abcdef1234567890',
      branch: 'feature-branch',
      isBare: false,
    });
  });

  it('handles detached HEAD worktree', async () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo-detached',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    simulateExecFile(null, output);
    const worktrees = await getGitWorktrees('/repo');

    expect(worktrees).toHaveLength(2);
    expect(worktrees[1]).toEqual({
      path: '/repo-detached',
      head: 'def456',
      branch: null,
      isBare: false,
    });
  });

  it('handles bare worktree', async () => {
    const output = [
      'worktree /repo.git',
      'HEAD abc123',
      'bare',
      '',
      'worktree /repo-wt',
      'HEAD def456',
      'branch refs/heads/main',
      '',
    ].join('\n');

    simulateExecFile(null, output);
    const worktrees = await getGitWorktrees('/repo.git');

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].isBare).toBe(true);
    expect(worktrees[0].branch).toBeNull();
    expect(worktrees[1].isBare).toBe(false);
    expect(worktrees[1].branch).toBe('main');
  });

  it('returns empty array on error', async () => {
    simulateExecFile(new Error('not a git repo') as ExecFileException, '');
    const worktrees = await getGitWorktrees('/test');
    expect(worktrees).toEqual([]);
  });

  it('handles single worktree (no linked)', async () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
    ].join('\n');

    simulateExecFile(null, output);
    const worktrees = await getGitWorktrees('/repo');

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe('/repo');
  });
});


it('rejects oversized untracked files before reading and closes the handle', async () => {
  const read = vi.fn(), close = vi.fn(async () => {});
  vi.mocked(fsPromises.open).mockResolvedValueOnce({ stat: async () => ({size: 1024 * 1024}), read, close } as any);
  expect(await getGitDiff('/repo', 'large', 'untracked')).toContain('too large');
  expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});

it('bounds an untracked file that grows after stat', async () => {
  const close = vi.fn(async () => {});
  vi.mocked(fsPromises.open).mockResolvedValueOnce({ stat: async () => ({size: 1}),
    read: async (buffer: Buffer, offset: number, length: number) => { buffer.fill(120, offset, offset + length); return {bytesRead: length}; }, close } as any);
  expect(await getGitDiff('/repo', 'growing', 'untracked')).toContain('too large');
  expect(close).toHaveBeenCalledOnce();
});

describe('checkoutGitBranch / createGitBranch branch-name gate', () => {
  const argv = () => mockExecFile.mock.calls.map((c) => c[1] as string[]);

  it('refuses a flag-shaped branch before git ever sees it', async () => {
    // `git checkout -f` force-discards the working tree. The renderer owns the
    // branch string, so the leading '-' has to die here, not in argv.
    await expect(checkoutGitBranch('/repo', '-f')).rejects.toThrow(/Invalid branch name/);
    await expect(createGitBranch('/repo', '-f')).rejects.toThrow(/Invalid branch name/);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('validates with git check-ref-format before checking out', async () => {
    simulateExecFile(null, ''); // check-ref-format passes
    simulateExecFile(null, ''); // checkout

    await checkoutGitBranch('/repo', 'feature/x');

    expect(argv()).toEqual([
      ['check-ref-format', '--branch', 'feature/x'],
      ['checkout', 'feature/x'],
    ]);
  });

  it('creates on a validated ref only', async () => {
    simulateExecFile(null, '');
    simulateExecFile(null, '');

    await createGitBranch('/repo', 'new-branch');

    expect(argv()).toEqual([
      ['check-ref-format', '--branch', 'new-branch'],
      ['checkout', '-b', 'new-branch'],
    ]);
  });

  it('stops when git rejects the ref name', async () => {
    // `a..b` is the double-dot rev range git refuses for a branch name.
    simulateExecFile({ message: 'fatal: invalid ref format' } as ExecFileException, '');

    await expect(checkoutGitBranch('/repo', 'a..b')).rejects.toThrow(/Invalid branch name/);

    expect(argv()).toEqual([['check-ref-format', '--branch', 'a..b']]);
  });
});

describe('getGitRemoteUrl', () => {
  it('normalizes SSH remotes to HTTPS and strips the .git suffix', async () => {
    simulateExecFile(null, 'git@github.com:foo/bar.git\n');
    expect(await getGitRemoteUrl('/test')).toBe('https://github.com/foo/bar');
  });

  // P2-24: every sibling execFile in git-status.ts bounds its spawn with
  // timeout: 5000; getGitRemoteUrl was the outlier that could hang the
  // repo-detection promise forever on a git credential prompt.
  it('bounds the git spawn with the 5s sibling timeout', async () => {
    simulateExecFile(null, 'https://github.com/foo/bar.git\n');
    expect(await getGitRemoteUrl('/test')).toBe('https://github.com/foo/bar');
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as unknown as
      [string, string[], { cwd: string; timeout: number }];
    expect(cmd).toBe('git');
    expect(args).toEqual(['remote', 'get-url', 'origin']);
    expect(opts.cwd).toBe('/test');
    expect(opts.timeout).toBe(5000);
  });

  it('resolves null when git fails — the timeout kill included', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true }) as ExecFileException;
    simulateExecFile(err, '');
    expect(await getGitRemoteUrl('/test')).toBeNull();
  });
});

describe('git binary resolution (GIT-BINARY)', () => {
  beforeEach(() => {
    resetGitBinaryCacheForTesting();
  });

  function answerVersion() {
    mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      (callback as (err: ExecFileException | null, stdout: string) => void)(null, 'git version 2.45.0');
      return undefined as never;
    }) as never);
  }

  it('picks the first install candidate that exists and answers --version, in candidate order', async () => {
    const [first, second] = gitCandidatePaths();
    mockExistsSync.mockImplementation((p) => p === second);
    answerVersion();
    await expect(getGitBinary()).resolves.toBe(second);
    // Candidate order is contractual: candidate 0 is checked before 1.
    expect(mockExistsSync.mock.calls.map((c) => c[0])).toEqual([first, second]);
  });

  it('skips a candidate whose --version probe fails and takes the next', async () => {
    const [first, second] = gitCandidatePaths();
    mockExistsSync.mockImplementation((p) => p === first || p === second);
    let firstProbe = true;
    mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: ExecFileException | null, stdout: string) => void;
      if (firstProbe) {
        firstProbe = false;
        cb(new Error('broken install') as ExecFileException, '');
        return undefined as never;
      }
      cb(null, 'git version 2.45.0');
      return undefined as never;
    }) as never);
    await expect(getGitBinary()).resolves.toBe(second);
  });

  it('falls back to the PATH-widened which probe when no candidate exists', async () => {
    mockExistsSync.mockImplementation(() => false);
    mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: ExecFileException | null, stdout: string) => void;
      if (String(_cmd) === whichCmd) {
        cb(null, '/custom/bin/git\n');
        return undefined as never;
      }
      cb(null, 'git version 2.45.0');
      return undefined as never;
    }) as never);
    await expect(getGitBinary()).resolves.toBe('/custom/bin/git');
  });

  it('falls back to the plain name and warns GIT_NOT_FOUND when nothing answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockImplementation(() => false);
    mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: ExecFileException | null, stdout: string) => void;
      cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) as ExecFileException, '');
      return undefined as never;
    }) as never);
    await expect(getGitBinary()).resolves.toBe('git');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('GIT_NOT_FOUND');
  });

  it('caches the probe: a repeated getGitBinary spawns nothing new', async () => {
    mockExistsSync.mockImplementation(() => false);
    answerVersion();
    await getGitBinary();
    const calls = mockExecFile.mock.calls.length;
    await getGitBinary();
    expect(mockExecFile).toHaveBeenCalledTimes(calls);
  });
});

describe('GIT_NOT_FOUND mapping (spawn ENOENT)', () => {
  const enoent = () =>
    Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) as ExecFileException;

  it('getGitStatus reports gitNotFound, not a plain NOT_A_REPO', async () => {
    simulateExecFile(enoent(), '');
    const status = await getGitStatus('/test');
    expect(status.gitNotFound).toBe(true);
    expect(status.isGitRepo).toBe(false);
  });

  it('keeps non-ENOENT failures as NOT_A_REPO (not a repo is not a missing git)', async () => {
    simulateExecFile(new Error('fatal: not a git repository') as ExecFileException, '');
    const status = await getGitStatus('/test');
    expect(status.gitNotFound).toBeUndefined();
    expect(status.isGitRepo).toBe(false);
  });

  it('gitStageFile rejects with a GIT_NOT_FOUND-coded error', async () => {
    // TWO answers: this case makes two gitStageFile calls and must own both
    // responses (it used to pass by consuming an implicit leaked Once).
    simulateExecFile(enoent(), '');
    simulateExecFile(enoent(), '');
    await expect(gitStageFile('/test', 'a.ts')).rejects.toThrow(/GIT_NOT_FOUND/);
    await gitStageFile('/test', 'a.ts').catch((err: NodeJS.ErrnoException) => {
      expect(err.code).toBe('GIT_NOT_FOUND');
    });
  });
});

describe('gitDiscardFile read-only retry (Windows polish)', () => {
  const workingTree = () => simulateExecFile(null, '/repo\n');
  const listing = (out: string) => simulateExecFile(null, out);

  it('clears the read-only bit and retries once on EPERM', async () => {
    workingTree();
    listing('new.ts\n');
    listing('');
    const target = path.join('/repo', 'new.ts');
    mockRm
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      .mockResolvedValueOnce(undefined);
    mockStat.mockResolvedValueOnce({ mode: 0o444 } as never);
    mockChmod.mockResolvedValueOnce(undefined);
    await gitDiscardFile('/repo', 'new.ts', 'untracked');
    expect(mockChmod).toHaveBeenCalledWith(target, 0o644);
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it('retries on EBUSY too', async () => {
    workingTree();
    listing('new.ts\n');
    listing('');
    mockRm
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
      .mockResolvedValueOnce(undefined);
    mockStat.mockResolvedValueOnce({ mode: 0o644 } as never);
    mockChmod.mockResolvedValueOnce(undefined);
    await gitDiscardFile('/repo', 'new.ts', 'untracked');
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it('surfaces unrelated rm failures without touching permissions', async () => {
    workingTree();
    listing('new.ts\n');
    listing('');
    mockRm.mockRejectedValueOnce(Object.assign(new Error('ELOOP'), { code: 'ELOOP' }));
    await expect(gitDiscardFile('/repo', 'new.ts', 'untracked')).rejects.toThrow('ELOOP');
    expect(mockChmod).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledTimes(1);
  });
});

describe('untracked diff CRLF normalization', () => {
  it('counts CRLF lines once (hunk header matches the rendered lines)', async () => {
    const data = Buffer.from('a\r\nb\r\nc');
    vi.mocked(fsPromises.open).mockResolvedValueOnce({
      stat: async () => ({ size: data.length }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesRead: data.copy(buffer, offset, position, position + length),
      }),
      close: async () => {},
    } as never);
    const diff = await getGitDiff('/test', 'new.ts', 'untracked');
    expect(diff).toContain('@@ -0,0 +1,3 @@');
  });
});
