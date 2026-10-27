import { describe, it, expect, vi, beforeEach } from 'vitest';

// The exec lane is stubbed; git-on must call it with the exact command shape.
const exec = vi.fn();
const sftpRead = vi.fn();
vi.mock('./hosts/ssh-client', () => ({
  exec: (...args: unknown[]) => exec(...args),
  sftpRead: (...args: unknown[]) => sftpRead(...args),
}));

// The local sink's spawn is stubbed (same idiom as git-status.test) so the
// local dispatch assertion never touches a real git.
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import {
  gitOnStatus,
  gitOnFiles,
  gitOnDiff,
  gitOnWorktrees,
  gitOnRemoteUrl,
  gitOnBranches,
  gitOnStageFile,
  gitOnUnstageFile,
  gitOnDiscardFile,
  gitOnCheckoutBranch,
  gitOnCreateBranch,
  type GitTarget,
} from './git-on';
import { NOT_A_REPO, primeGitBinaryForTesting } from './git-status';
import type { HostRecord } from '../shared/types';

const mockExecFile = vi.mocked(execFile);
const RECORD = { id: 'host-1', name: 'h', host: 'h.example' } as HostRecord;
const REMOTE: GitTarget = { kind: 'remote', record: RECORD, cwd: '/srv/app' };
const LOCAL: GitTarget = { kind: 'local', cwd: 'C:\\repo' };

const PORCELAIN = [
  '# branch.head main',
  '# branch.oid 1234567',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 abc def staged.ts',
  '1 .M N... 100644 100644 100644 abc def work.ts',
  'u UU N... 100644 100644 100644 abc def c1 conf.ts',
  '? untracked.txt',
].join('\n');

beforeEach(() => {
  exec.mockReset();
  sftpRead.mockReset();
  mockExecFile.mockReset();
});

describe('gitOn remote sibling (exec lane)', () => {
  it('status runs git over the host and parses the shared porcelain format', async () => {
    exec.mockResolvedValue(PORCELAIN);
    const status = await gitOnStatus(REMOTE);
    expect(exec).toHaveBeenCalledWith(
      RECORD,
      "git -C '/srv/app' status --porcelain=v2 --branch --untracked-files=all",
      { timeoutMs: 5000 },
    );
    expect(status).toMatchObject({ isGitRepo: true, branch: 'main', ahead: 2, behind: 1, staged: 1, modified: 1, untracked: 1, conflicted: 1 });
  });

  it('a failed remote git (not a repo) answers NOT_A_REPO, like the local sink', async () => {
    exec.mockRejectedValue(new Error('ssh exec exit 128'));
    await expect(gitOnStatus(REMOTE)).resolves.toEqual(NOT_A_REPO);
  });

  it('single quotes in the remote path are shell-escaped', async () => {
    const target: GitTarget = { kind: 'remote', record: RECORD, cwd: `/srv/it's` };
    exec.mockResolvedValue('# branch.head main\n');
    await gitOnStatus(target);
    expect(exec.mock.calls[0][1]).toBe(`git -C '/srv/it'\\''s' status --porcelain=v2 --branch --untracked-files=all`);
  });

  it('files parses the -z porcelain from the host', async () => {
    exec.mockResolvedValue('1 M. N... 100644 100644 100644 abc def staged.ts\0? untracked.txt\0');
    const files = await gitOnFiles(REMOTE);
    expect(files).toEqual([
      { path: 'staged.ts', status: 'modified', area: 'staged' },
      { path: 'untracked.txt', status: 'untracked', area: 'untracked' },
    ]);
  });

  it('tracked diff comes from git diff on the host', async () => {
    exec.mockResolvedValue('diff --git a/x b/x\n');
    await expect(gitOnDiff(REMOTE, 'x', 'working')).resolves.toBe('diff --git a/x b/x\n');
    expect(exec.mock.calls[0][1]).toBe("git -C '/srv/app' diff -- x");
    exec.mockResolvedValue('staged\n');
    await gitOnDiff(REMOTE, 'x', 'staged');
    expect(exec.mock.calls[1][1]).toBe("git -C '/srv/app' diff --cached -- x");
  });

  it('untracked diff reads the file over sftp (no exec) and formats it', async () => {
    sftpRead.mockResolvedValue('line1\nline2');
    const diff = await gitOnDiff(REMOTE, 'new.txt', 'untracked');
    expect(exec).not.toHaveBeenCalled();
    expect(sftpRead).toHaveBeenCalledWith(RECORD, '/srv/app/new.txt');
    expect(diff).toBe('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2');
  });

  it('untracked diff caps at 256 KiB and reports binary like the local sink', async () => {
    sftpRead.mockResolvedValue('x'.repeat(256 * 1024 + 1));
    await expect(gitOnDiff(REMOTE, 'big.txt', 'untracked')).resolves.toBe('(file too large to preview; limit 256 KiB)');
    sftpRead.mockResolvedValue('a\0b');
    await expect(gitOnDiff(REMOTE, 'bin.dat', 'untracked')).resolves.toBe('(binary file; no text preview)');
    sftpRead.mockResolvedValue(null);
    await expect(gitOnDiff(REMOTE, 'gone.txt', 'untracked')).resolves.toBe('(unable to read file)');
  });

  it('worktrees/remoteUrl/branches parse host output with the shared parsers', async () => {
    exec.mockResolvedValue('worktree /srv/app\nHEAD abc\ndetached\n');
    await expect(gitOnWorktrees(REMOTE)).resolves.toEqual([{ path: '/srv/app', head: 'abc', branch: null, isBare: false }]);
    exec.mockResolvedValue('git@github.com:owner/repo.git\n');
    await expect(gitOnRemoteUrl(REMOTE)).resolves.toBe('https://github.com/owner/repo');
    exec.mockResolvedValue('* main\n  feature\n* (HEAD detached at 1234567)\n');
    await expect(gitOnBranches(REMOTE)).resolves.toEqual([
      { name: 'main', current: true },
      { name: 'feature', current: false },
    ]);
  });

  it('every read settles empty/null on failure - never an IPC rejection', async () => {
    exec.mockRejectedValue(new Error('boom'));
    await expect(gitOnFiles(REMOTE)).resolves.toEqual([]);
    await expect(gitOnDiff(REMOTE, 'x', 'working')).resolves.toBe('(no diff available)');
    await expect(gitOnWorktrees(REMOTE)).resolves.toEqual([]);
    await expect(gitOnRemoteUrl(REMOTE)).resolves.toBeNull();
    await expect(gitOnBranches(REMOTE)).resolves.toEqual([]);
  });
});

describe('gitOn local sibling dispatch', () => {
  it('local targets call the local sink unchanged', async () => {
    primeGitBinaryForTesting('/usr/bin/git');
    mockExecFile.mockImplementation((_c, _a, _o, cb) => {
      (cb as (e: Error | null, out: string) => void)(null, '# branch.head main\n# branch.ab +0 -0\n');
      return undefined as never;
    });
    await expect(gitOnStatus(LOCAL)).resolves.toMatchObject({ isGitRepo: true, branch: 'main' });
    expect(mockExecFile).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      expect.objectContaining({ cwd: 'C:\\repo' }),
      expect.any(Function),
    );
  });
});

describe('write-side lanes (Phase 4b)', () => {
  it('remote stage/unstage quote the path and hit the exec lane', async () => {
    exec.mockResolvedValue('');
    await gitOnStageFile(REMOTE, 'src/a b.ts');
    expect(exec).toHaveBeenCalledWith(RECORD, "git -C '/srv/app' add -- 'src/a b.ts'", { timeoutMs: 5000 });
    await gitOnUnstageFile(REMOTE, 'src/a.ts');
    expect(exec).toHaveBeenLastCalledWith(RECORD, "git -C '/srv/app' reset HEAD -- 'src/a.ts'", { timeoutMs: 5000 });
  });

  it('remote discard uses clean -fd for untracked, checkout for tracked', async () => {
    exec.mockResolvedValue('');
    await gitOnDiscardFile(REMOTE, 'new.txt', 'untracked');
    expect(exec).toHaveBeenLastCalledWith(RECORD, "git -C '/srv/app' clean -fd -- 'new.txt'", { timeoutMs: 5000 });
    await gitOnDiscardFile(REMOTE, 'mod.txt', 'modified');
    expect(exec).toHaveBeenLastCalledWith(RECORD, "git -C '/srv/app' checkout -- 'mod.txt'", { timeoutMs: 5000 });
  });

  it('remote checkout validates the ref via git before switching', async () => {
    exec.mockResolvedValue('');
    await gitOnCheckoutBranch(REMOTE, 'feature/x');
    expect(exec).toHaveBeenNthCalledWith(1, RECORD, "git -C '/srv/app' check-ref-format --branch 'feature/x'", { timeoutMs: 5000 });
    expect(exec).toHaveBeenNthCalledWith(2, RECORD, "git -C '/srv/app' checkout 'feature/x'", { timeoutMs: 5000 });
  });

  it('remote create branches via checkout -b after validation', async () => {
    exec.mockResolvedValue('');
    await gitOnCreateBranch(REMOTE, 'feat');
    expect(exec).toHaveBeenNthCalledWith(2, RECORD, "git -C '/srv/app' checkout -b 'feat'", { timeoutMs: 5000 });
  });

  it('rejects unsafe remote paths and flag-like branches', async () => {
    await expect(gitOnStageFile(REMOTE, '../escape')).rejects.toThrow(/not a path inside/);
    await expect(gitOnStageFile(REMOTE, '/abs')).rejects.toThrow(/not a path inside/);
    await expect(gitOnCheckoutBranch(REMOTE, '-f')).rejects.toThrow(/Invalid branch name/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('local mutations dispatch to the local sink (execFile), never ssh exec', async () => {
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null) => void;
      cb(null);
    }) as never);
    await gitOnStageFile(LOCAL, 'a.ts');
    expect(exec).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalled();
  });
});
