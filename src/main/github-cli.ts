import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GithubFetchResult, GithubItem, GithubRepo } from '../shared/types';
import { GITHUB_MAX_PER_PAGE } from '../shared/constants';
import { getFullPath } from './pty-manager';
import { getGitRemoteUrl } from './git-status';
import { isWin, pathSep, whichCmd } from './platform';

let cachedAvailable: boolean | null = null;

function ghBinaryName(): string {
  return isWin ? 'gh.exe' : 'gh';
}

function ghCandidates(): string[] {
  const home = os.homedir();
  if (isWin) {
    return [
      path.join('C:\\Program Files\\GitHub CLI', 'gh.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'GitHub CLI', 'gh.exe'),
      path.join(home, 'scoop', 'shims', 'gh.exe'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe', 'gh.exe'),
    ];
  }
  return [
    '/usr/local/bin/gh',
    '/opt/homebrew/bin/gh',
    '/usr/bin/gh',
    path.join(home, '.local', 'bin', 'gh'),
  ];
}

export function resetCacheForTesting(): void {
  cachedAvailable = null;
}

export async function isGhAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;

  for (const candidate of ghCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        cachedAvailable = true;
        return true;
      }
    } catch {}
  }

  try {
    const which = await new Promise<string>((resolve, reject) => {
      execFile(
        whichCmd,
        [ghBinaryName()],
        { env: { ...process.env, PATH: getFullPath() }, timeout: 3000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
    });
    cachedAvailable = !!which;
    return cachedAvailable;
  } catch {
    cachedAvailable = false;
    return false;
  }
}

interface GhApiOptions {
  query?: Record<string, string | number>;
}

async function ghApi<T = unknown>(apiPath: string, opts: GhApiOptions = {}): Promise<T> {
  const qs = opts.query
    ? '?' + Object.entries(opts.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const fullPath = `${apiPath}${qs}`;

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      ghBinaryName(),
      ['api', fullPath, '-H', 'Accept: application/vnd.github+json'],
      {
        env: { ...process.env, PATH: getFullPath() },
        maxBuffer: 5 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      },
      (err, out, errOut) => {
        if (err) {
          const msg = (errOut || err.message || '').toString().trim();
          reject(new Error(msg || 'gh api failed'));
          return;
        }
        resolve(out);
      },
    );
  });

  return JSON.parse(stdout) as T;
}

export interface ListOptions {
  state: 'open' | 'closed' | 'all';
  max: number;
}

export async function listPullRequests(repo: string, opts: ListOptions): Promise<GithubFetchResult> {
  if (!repo || !repo.includes('/')) return { ok: false, error: 'Invalid repo. Expected owner/name.' };
  if (!(await isGhAvailable())) return { ok: false, error: 'gh CLI not installed' };
  try {
    const items = await ghApi<GithubItem[]>(`repos/${repo}/pulls`, {
      query: { state: opts.state, per_page: Math.min(Math.max(opts.max, 1), GITHUB_MAX_PER_PAGE), sort: 'updated', direction: 'desc' },
    });
    return { ok: true, items: items.slice(0, opts.max) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listIssues(repo: string, opts: ListOptions): Promise<GithubFetchResult> {
  if (!repo || !repo.includes('/')) return { ok: false, error: 'Invalid repo. Expected owner/name.' };
  if (!(await isGhAvailable())) return { ok: false, error: 'gh CLI not installed' };
  try {
    // /issues endpoint returns PRs too — search API filters server-side via is:issue.
    const qParts = [`repo:${repo}`, 'is:issue'];
    if (opts.state !== 'all') qParts.push(`state:${opts.state}`);
    const perPage = Math.min(Math.max(opts.max, 1), GITHUB_MAX_PER_PAGE);
    const result = await ghApi<{ items: GithubItem[] }>('search/issues', {
      query: { q: qParts.join(' '), sort: 'updated', order: 'desc', per_page: perPage },
    });
    return { ok: true, items: result.items.slice(0, opts.max) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse owner/repo from a normalized GitHub HTTPS URL like https://github.com/owner/repo.
 * Returns null if the URL isn't recognized as github.com.
 */
export function parseGithubRepo(url: string | null): GithubRepo | null {
  if (!url) return null;
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export async function detectRepo(projectPath: string): Promise<GithubRepo | null> {
  const url = await getGitRemoteUrl(projectPath);
  return parseGithubRepo(url);
}
