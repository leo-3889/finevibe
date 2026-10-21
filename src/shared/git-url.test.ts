import { describe, expect, it } from 'vitest';
import { detectGitCheckoutUrl } from './git-url.js';

describe('detectGitCheckoutUrl', () => {
  it('accepts a plain GitHub https URL and derives the repo name', () => {
    expect(detectGitCheckoutUrl('https://github.com/owner/repo')).toEqual({
      url: 'https://github.com/owner/repo',
      repoName: 'repo',
    });
  });

  it('accepts Codeberg and the www. variants', () => {
    expect(detectGitCheckoutUrl('https://codeberg.org/owner/repo')?.repoName).toBe('repo');
    expect(detectGitCheckoutUrl('https://www.github.com/owner/repo')?.repoName).toBe('repo');
    expect(detectGitCheckoutUrl('https://www.codeberg.org/owner/repo')?.repoName).toBe('repo');
  });

  it('strips a trailing .git and trailing slashes', () => {
    expect(detectGitCheckoutUrl('https://github.com/owner/repo.git')?.repoName).toBe('repo');
    expect(detectGitCheckoutUrl('https://github.com/owner/repo/')?.repoName).toBe('repo');
    expect(detectGitCheckoutUrl('https://github.com/owner/repo.git/')?.repoName).toBe('repo');
  });

  it('accepts the scp-style ssh form', () => {
    expect(detectGitCheckoutUrl('git@github.com:owner/repo.git')).toEqual({
      url: 'git@github.com:owner/repo.git',
      repoName: 'repo',
    });
    expect(detectGitCheckoutUrl('git@codeberg.org:owner/repo')?.repoName).toBe('repo');
  });

  it('accepts the ssh:// URL form', () => {
    expect(detectGitCheckoutUrl('ssh://git@github.com/owner/repo.git')?.repoName).toBe('repo');
  });

  it('trims surrounding whitespace before detecting', () => {
    expect(detectGitCheckoutUrl('  https://github.com/owner/repo  ')?.repoName).toBe('repo');
  });

  it('derives the name from dots/dashes/underscores in the last segment', () => {
    expect(detectGitCheckoutUrl('https://github.com/owner/my.repo-2_x')?.repoName).toBe('my.repo-2_x');
  });

  it('rejects hosts off the allowlist', () => {
    expect(detectGitCheckoutUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(detectGitCheckoutUrl('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com.evil.test/owner/repo')).toBeNull();
    expect(detectGitCheckoutUrl('https://notgithub.com/owner/repo')).toBeNull();
  });

  it('rejects non-git-looking paths, protocols and shapes', () => {
    expect(detectGitCheckoutUrl('/home/user/projects')).toBeNull();
    expect(detectGitCheckoutUrl('C:\\Users\\me\\project')).toBeNull();
    expect(detectGitCheckoutUrl('repo')).toBeNull();
    expect(detectGitCheckoutUrl('ftp://github.com/owner/repo')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com/owner')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com/')).toBeNull();
    expect(detectGitCheckoutUrl('')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com/owner/re po')).toBeNull();
  });

  it('rejects credential- and port-bearing URLs', () => {
    expect(detectGitCheckoutUrl('https://user:token@github.com/owner/repo')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com:8443/owner/repo')).toBeNull();
  });

  it('rejects repo segments that are not safe folder names', () => {
    expect(detectGitCheckoutUrl('https://github.com/owner/..')).toBeNull();
    expect(detectGitCheckoutUrl('https://github.com/owner/.hidden')).toBeNull();
  });
});
