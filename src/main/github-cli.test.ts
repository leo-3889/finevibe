import { vi } from 'vitest';
import type { ExecFileException } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  promises: {},
}));

vi.mock('./pty-manager', () => ({
  getFullPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
}));

vi.mock('./git-status', () => ({
  getGitRemoteUrl: vi.fn(),
}));

import { execFile } from 'child_process';
import { getGitRemoteUrl } from './git-status';
import {
  parseGithubRepo,
  detectRepo,
  isGhAvailable,
  listPullRequests,
  listIssues,
  resetCacheForTesting,
} from './github-cli';

const mockExecFile = vi.mocked(execFile);
const mockGetGitRemoteUrl = vi.mocked(getGitRemoteUrl);

function simulateExecFile(err: ExecFileException | null, stdout: string, stderr = '') {
  mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
    (callback as (err: ExecFileException | null, stdout: string, stderr: string) => void)(err, stdout, stderr);
    return undefined as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCacheForTesting();
});

describe('parseGithubRepo', () => {
  it('extracts owner/repo from a normalized GitHub URL', () => {
    expect(parseGithubRepo('https://github.com/anthropics/claude-code'))
      .toEqual({ owner: 'anthropics', repo: 'claude-code' });
  });

  it('handles trailing slashes', () => {
    expect(parseGithubRepo('https://github.com/owner/repo/'))
      .toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns null for non-github URLs', () => {
    expect(parseGithubRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseGithubRepo(null)).toBeNull();
  });

  it('returns null when path has too many segments', () => {
    expect(parseGithubRepo('https://github.com/owner/repo/tree/main')).toBeNull();
  });
});

describe('detectRepo', () => {
  it('returns parsed repo when getGitRemoteUrl finds a github URL', async () => {
    mockGetGitRemoteUrl.mockResolvedValueOnce('https://github.com/foo/bar');
    expect(await detectRepo('/x')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('returns null when there is no remote', async () => {
    mockGetGitRemoteUrl.mockResolvedValueOnce(null);
    expect(await detectRepo('/x')).toBeNull();
  });
});

describe('isGhAvailable', () => {
  it('caches positive result via which', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    expect(await isGhAvailable()).toBe(true);
    // Subsequent call must NOT re-invoke execFile
    expect(await isGhAvailable()).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('caches negative result when which fails', async () => {
    simulateExecFile(new Error('not found') as ExecFileException, '');
    expect(await isGhAvailable()).toBe(false);
    expect(await isGhAvailable()).toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe('listPullRequests', () => {
  it('rejects invalid repo without calling gh', async () => {
    const result = await listPullRequests('not-a-repo', { state: 'open', max: 5 });
    expect(result.ok).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects a repo that escapes the repos/ scope, without calling gh', async () => {
    // `gh api` requests the path with the user's token and resolves `..`
    // before sending, so `repos/../user` reads /user; a leading '-' is a gh
    // flag, and `%2e%2e` decodes to `..` on the way to the router.
    for (const repo of ['../user', 'foo/../user', 'owner/-x', '%2e%2e/user', 'owner//x', 'owner/repo/extra']) {
      const result = await listPullRequests(repo, { state: 'open', max: 5 });
      expect(result.ok, repo).toBe(false);
      expect(result.error, repo).toBe('Invalid repo. Expected owner/name.');
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('encodes the accepted segments into the request path', async () => {
    // Dots are legal in GitHub repo names (pages repos), so they survive; the
    // encoding is what keeps a literal `%2e%2e` from becoming `..`.
    simulateExecFile(null, '/usr/local/bin/gh\n');
    simulateExecFile(null, '[]');

    const result = await listPullRequests('leo-3889/leo-3889.github.io', { state: 'open', max: 5 });

    expect(result.ok).toBe(true);
    const [, args] = mockExecFile.mock.calls[1] as unknown as [string, string[]];
    expect(args[1]).toMatch(/^repos\/leo-3889\/leo-3889\.github\.io\/pulls\?/);
    expect(args[1]).not.toContain('%2e');
  });

  it('passes the right gh api args and returns parsed items', async () => {
    // first call: which gh
    simulateExecFile(null, '/usr/local/bin/gh\n');
    // second call: gh api repos/foo/bar/pulls?...
    const items = [
      { number: 1, title: 'PR one', state: 'open', user: { login: 'a', avatar_url: '' }, html_url: 'http://x', created_at: '2024-01-01', updated_at: '2024-01-02', closed_at: null },
    ];
    simulateExecFile(null, JSON.stringify(items));

    const result = await listPullRequests('foo/bar', { state: 'open', max: 5 });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0].number).toBe(1);

    const [cmd, args] = mockExecFile.mock.calls[1] as unknown as [string, string[]];
    expect(args[0]).toBe('api');
    expect(args[1]).toMatch(/^repos\/foo\/bar\/pulls\?/);
    expect(args[1]).toContain('state=open');
    expect(args[1]).toContain('per_page=5');
    expect(cmd).toMatch(/^gh(\.exe)?$/);
  });

  it('truncates results to max', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    const items = Array.from({ length: 10 }, (_, i) => ({
      number: i, title: `PR ${i}`, state: 'open', user: null, html_url: '', created_at: '', updated_at: '', closed_at: null,
    }));
    simulateExecFile(null, JSON.stringify(items));
    const result = await listPullRequests('foo/bar', { state: 'open', max: 3 });
    expect(result.items).toHaveLength(3);
  });

  it('returns ok:false with the gh stderr when gh fails', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    simulateExecFile({ message: 'failed' } as ExecFileException, '', 'HTTP 404: Not Found');
    const result = await listPullRequests('foo/bar', { state: 'open', max: 5 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
  });
});

describe('listIssues', () => {
  it('queries the search API with is:issue and returns the items array', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    const items = [
      { number: 1, title: 'first', state: 'open', user: null, html_url: '', created_at: '', updated_at: '', closed_at: null },
      { number: 2, title: 'second', state: 'open', user: null, html_url: '', created_at: '', updated_at: '', closed_at: null },
    ];
    simulateExecFile(null, JSON.stringify({ items }));

    const result = await listIssues('foo/bar', { state: 'open', max: 10 });
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items?.[0].number).toBe(1);

    const [, args] = mockExecFile.mock.calls[1] as unknown as [string, string[]];
    expect(args[0]).toBe('api');
    expect(args[1]).toMatch(/^search\/issues\?/);
    // q is URL-encoded
    expect(args[1]).toContain('q=repo%3Afoo%2Fbar%20is%3Aissue%20state%3Aopen');
    expect(args[1]).toContain('per_page=10');
    expect(args[1]).toContain('sort=updated');
    expect(args[1]).toContain('order=desc');
  });

  it('omits the state qualifier when state is "all"', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    simulateExecFile(null, JSON.stringify({ items: [] }));

    await listIssues('foo/bar', { state: 'all', max: 5 });

    const [, args] = mockExecFile.mock.calls[1] as unknown as [string, string[]];
    expect(args[1]).toContain('q=repo%3Afoo%2Fbar%20is%3Aissue');
    expect(args[1]).not.toContain('state%3A');
  });

  it('truncates results to max', async () => {
    simulateExecFile(null, '/usr/local/bin/gh\n');
    const items = Array.from({ length: 10 }, (_, i) => ({
      number: i, title: `issue ${i}`, state: 'open', user: null, html_url: '', created_at: '', updated_at: '', closed_at: null,
    }));
    simulateExecFile(null, JSON.stringify({ items }));
    const result = await listIssues('foo/bar', { state: 'open', max: 3 });
    expect(result.items).toHaveLength(3);
  });

  it('rejects invalid repo without calling gh', async () => {
    const result = await listIssues('not-a-repo', { state: 'open', max: 5 });
    expect(result.ok).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects a name that would inject search qualifiers, without calling gh', async () => {
    // `q` carries `repo:<repo>` verbatim, so a space or colon in the name
    // becomes an extra operator and a dot segment is a path step for the
    // endpoints a future caller builds from the same value.
    for (const repo of ['../user', 'foo/bar is:pr user:evil', 'owner/-x', 'owner/repo/extra']) {
      const result = await listIssues(repo, { state: 'open', max: 5 });
      expect(result.ok, repo).toBe(false);
      expect(result.error, repo).toBe('Invalid repo. Expected owner/name.');
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
