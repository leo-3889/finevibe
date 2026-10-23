import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GithubFetchResult, GithubItem, GithubRepo } from '../shared/types';
import { GITHUB_MAX_PER_PAGE } from '../shared/constants';
import { getFullPath } from './pty-manager';
import { getGitRemoteUrl } from './git-status';
import { isWin, whichCmd } from './platform';

/** An `isGhAvailable()` probe is trusted for this long, so installing `gh` needs at most a restart-free minute. */
const GH_AVAILABILITY_TTL_MS = 60_000;

interface GhAvailability {
  available: boolean;
  /** Timestamp of the probe; the cache expires after `GH_AVAILABILITY_TTL_MS`. */
  at: number;
  /**
   * Absolute path of the install directory candidate that exists, or null when
   * `gh` was only found through PATH — so `ghApi` invokes the same binary the
   * probe validated instead of relying on PATH resolution.
   */
  resolvedPath: string | null;
}

let cachedAvailability: GhAvailability | null = null;

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
      // WinGet installs the exe under Packages\GitHub.cli_...\<version dir>\bin\,
      // so a fixed Packages path has no gh.exe at its root and never hits.
      // The Links dir is the stable symlink WinGet maintains into that
      // versioned bin\ folder — the canonical machine-wide gh location.
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe'),
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
  cachedAvailability = null;
}

export async function isGhAvailable(): Promise<boolean> {
  if (cachedAvailability && Date.now() - cachedAvailability.at < GH_AVAILABILITY_TTL_MS) {
    return cachedAvailability.available;
  }

  for (const candidate of ghCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        cachedAvailability = { available: true, at: Date.now(), resolvedPath: candidate };
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
    cachedAvailability = { available: which.length > 0, at: Date.now(), resolvedPath: null };
    return cachedAvailability.available;
  } catch {
    cachedAvailability = { available: false, at: Date.now(), resolvedPath: null };
    return false;
  }
}

interface GhApiOptions {
  query?: Record<string, string | number>;
}

/**
 * The executable `ghApi` invokes: the candidate path the availability probe
 * validated, else the bare name resolved through `getFullPath()`. Callers reach
 * it only after `isGhAvailable()` has populated the cache.
 */
function ghExecutable(): string {
  return cachedAvailability?.resolvedPath ?? ghBinaryName();
}

async function ghApi<T = unknown>(apiPath: string, opts: GhApiOptions = {}): Promise<T> {
  const qs = opts.query
    ? '?' + Object.entries(opts.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const fullPath = `${apiPath}${qs}`;

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      ghExecutable(),
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

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`gh api returned invalid JSON for ${apiPath}`);
  }
}

/**
 * `repo` arrives verbatim from the renderer and steers a `gh api` request made
 * with the user's token: as the request path (`repos/<repo>/pulls`) and, for
 * the search endpoint, inside the `q=repo:<repo>` qualifier.
 *
 * A `..` segment is resolved away before the request goes out, so
 * `repos/../user` escapes the `repos/<owner>/<name>` scope and reads any
 * endpoint the token can reach; a leading `-` is parsed by gh as a flag; a
 * space or colon in the name escapes the `repo:` qualifier and injects search
 * operators. GitHub's own grammar is one segment of alphanumerics with inner
 * `.`/`_`/`-` (owners drop the dot), so require exactly two such segments and
 * percent-encode them for the path — encoding also makes `%2e%2e` (which
 * decodes to `..` server-side) inert while leaving a plain `owner/name`
 * byte-identical. Returns null for anything else.
 */
function encodeRepoPath(repo: string): string | null {
  const segments = repo.split('/');
  if (segments.length !== 2) return null;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return null;
  }
  return segments.map(encodeURIComponent).join('/');
}

export interface ListOptions {
  state: 'open' | 'closed' | 'all';
  max: number;
}

export async function listPullRequests(repo: string, opts: ListOptions): Promise<GithubFetchResult> {
  const encoded = repo ? encodeRepoPath(repo) : null;
  if (!encoded) return { ok: false, error: 'Invalid repo. Expected owner/name.' };
  if (!(await isGhAvailable())) return { ok: false, error: 'gh CLI not installed' };
  try {
    const items = await ghApi<GithubItem[]>(`repos/${encoded}/pulls`, {
      query: { state: opts.state, per_page: Math.min(Math.max(opts.max, 1), GITHUB_MAX_PER_PAGE), sort: 'updated', direction: 'desc' },
    });
    return { ok: true, items: items.slice(0, opts.max) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listIssues(repo: string, opts: ListOptions): Promise<GithubFetchResult> {
  // The validated name feeds a `repo:` qualifier, not a path, so the plain
  // spelling goes into `q`; the check is what keeps it one qualifier.
  if (!repo || !encodeRepoPath(repo)) return { ok: false, error: 'Invalid repo. Expected owner/name.' };
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
