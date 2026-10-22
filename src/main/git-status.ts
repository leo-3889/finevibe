import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { GitWorktree, GitFileEntry } from '../shared/types';
import { canonicalPath } from './fs-utils';
import { isMac } from './platform';

export type { GitWorktree, GitFileEntry } from '../shared/types';


// C5G-05: mirror C3M-02 — the 1 MiB child_process default ENOBUFS'd on huge
// repos (`git status` porcelain over tens of thousands of paths). Generous
// bound so a big working tree reads fully instead of collapsing to NOT_A_REPO.
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;
export interface GitStatus {
  isGitRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  /** C5G-05: listing exceeded maxBuffer (ENOBUFS) - tree is huge, counts unusable. */
  errored?: boolean;
}

const NOT_A_REPO: GitStatus = {
  isGitRepo: false,
  branch: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
};

export function getGitStatus(cwd: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
      { cwd, timeout: 5000, maxBuffer: GIT_STATUS_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          // C5G-05: a porcelain listing past maxBuffer dies with ENOBUFS, not a
          // "not a repo" error. Reporting NOT_A_REPO made a huge repo read as a
          // clean tree — the bar vanished and the panel showed "No changes".
          // Flag it distinctly so the renderer surfaces a message; `isGitRepo`
          // stays true so the bar doesn't disappear on an oversized repo.
          if ((err as NodeJS.ErrnoException).code === 'ENOBUFS') {
            resolve({ ...NOT_A_REPO, isGitRepo: true, errored: true });
            return;
          }
          resolve(NOT_A_REPO);
          return;
        }

        let branch: string | null = null;
        let ahead = 0;
        let behind = 0;
        let staged = 0;
        let modified = 0;
        let untracked = 0;
        let conflicted = 0;

        for (const line of stdout.split('\n')) {
          if (line.startsWith('# branch.head ')) {
            branch = line.slice('# branch.head '.length);
          } else if (line.startsWith('# branch.ab ')) {
            const match = line.match(/\+(\d+) -(\d+)/);
            if (match) {
              ahead = parseInt(match[1], 10);
              behind = parseInt(match[2], 10);
            }
          } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
            // Ordinary/rename entries: XY field is at index 2 (after the type char and space)
            const xy = line.split(' ')[1];
            if (xy && xy.length >= 2) {
              const x = xy[0]; // staged
              const y = xy[1]; // working tree
              if (x !== '.') staged++;
              if (y !== '.') modified++;
            }
          } else if (line.startsWith('u ')) {
            conflicted++;
          } else if (line.startsWith('? ')) {
            untracked++;
          }
        }

        resolve({
          isGitRepo: true,
          branch,
          ahead,
          behind,
          staged,
          modified,
          untracked,
          conflicted,
        });
      }
    );
  });
}

export function getGitDiff(cwd: string, filePath: string, area: string): Promise<string> {
  if (area === 'untracked') return readUntrackedDiff(path.join(cwd, filePath), filePath);
  return new Promise((resolve) => {

    const args = area === 'staged'
      ? ['diff', '--cached', '--', filePath]
      : ['diff', '--', filePath];

    execFile(
      'git',
      args,
      { cwd, timeout: 10000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve('(no diff available)');
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function xyToStatus(ch: string): 'added' | 'modified' | 'deleted' | 'renamed' {
  switch (ch) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    default: return 'modified';
  }
}

/** Porcelain-v2 metadata has a fixed field count; filenames may contain spaces. */
function pathAfterFields(line: string, fieldCount: number): string | null {
  let cursor = 0;
  for (let i = 0; i < fieldCount; i++) {
    cursor = line.indexOf(' ', cursor);
    if (cursor < 0) return null;
    cursor++;
  }
  return line.slice(cursor) || null;
}

export function getGitFiles(cwd: string): Promise<GitFileEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      { cwd, timeout: 5000, maxBuffer: GIT_STATUS_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }

        const entries: GitFileEntry[] = [];
        // -z output is NUL-terminated; paths are raw bytes, never C-quoted.
        // A rename record is followed by a separate NUL chunk holding the
        // original path, which is informational and not part of GitFileEntry.
        const records = stdout.split('\0');

        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          if (record.startsWith('1 ') || record.startsWith('2 ')) {
            const xy = record.slice(2, 4);
            // Type 2 (rename) has 9 fields before the current path; type 1 has 8.
            const path = pathAfterFields(record, record.startsWith('2 ') ? 9 : 8);
            if (record.startsWith('2 ')) {
              i++; // skip the original-path chunk
            }
            if (path && xy.length >= 2) {
              const x = xy[0]; // staged
              const y = xy[1]; // working tree
              if (x !== '.') {
                entries.push({ path, status: xyToStatus(x), area: 'staged' });
              }
              if (y !== '.') {
                entries.push({ path, status: xyToStatus(y), area: 'working' });
              }
            }
          } else if (record.startsWith('u ')) {
            // Unmerged entry
            const path = pathAfterFields(record, 10);
            if (path) entries.push({ path, status: 'conflicted', area: 'conflicted' });
          } else if (record.startsWith('? ')) {
            const path = record.slice(2);
            if (path) entries.push({ path, status: 'untracked', area: 'untracked' });
          }
        }

        resolve(entries);
      }
    );
  });
}

function execGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function execGitWithOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export async function listGitBranches(cwd: string): Promise<GitBranch[]> {
  const stdout = await execGitWithOutput(cwd, ['branch', '--list']);
  const branches: GitBranch[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const current = trimmed.startsWith('* ');
    const name = trimmed.slice(2);
    // Skip detached HEAD entries like "(HEAD detached at ...)"
    if (name.startsWith('(')) continue;
    branches.push({ name, current });
  }
  return branches;
}

/**
 * `branch` arrives from the renderer (`git:checkoutBranch`, `git:createBranch`)
 * and becomes a `git checkout` argv entry. A leading `-` is parsed as a
 * checkout flag, not a rev — `-f` force-discards the working tree — so reject
 * it before exec, then let git validate the ref itself. `--branch` is the
 * variant that accepts a single-segment name like `main`; it rejects the rest
 * of the shapes that break checkout (`..`, `~`, `^`, `:`, `@{`, control
 * chars, trailing `.`/`/`, `.lock`). execFile argv, no shell.
 */
async function requireValidBranch(cwd: string, branch: string): Promise<void> {
  if (typeof branch !== 'string' || branch === '' || branch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
  try {
    await execGit(cwd, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export async function checkoutGitBranch(cwd: string, branch: string): Promise<void> {
  await requireValidBranch(cwd, branch);
  await execGit(cwd, ['checkout', branch]);
}

export async function createGitBranch(cwd: string, branch: string): Promise<void> {
  await requireValidBranch(cwd, branch);
  await execGit(cwd, ['checkout', '-b', branch]);
}

export function gitStageFile(cwd: string, filePath: string): Promise<void> {
  return execGit(cwd, ['add', '--', filePath]);
}

export function gitUnstageFile(cwd: string, filePath: string): Promise<void> {
  return execGit(cwd, ['reset', 'HEAD', '--', filePath]);
}

/** P1-17: the untracked branch is a real recursive delete, so every
 * discard proves its bounds before anything is removed: the cwd is inside
 * a git WORKING TREE (`rev-parse --show-toplevel` — a watched CLI config
 * dir is not one), the target is a non-empty path strictly inside the tree
 * (discarding the whole tree is never a single-file operation), and for
 * untracked discards git itself reports untracked content at the path and
 * no tracked content — every file the delete would take with it is
 * verified individually by git's own listing. */
export async function gitDiscardFile(cwd: string, filePath: string, area: GitFileEntry['area']): Promise<void> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Refusing to discard an empty path');
  }
  const toplevel = (await execGitWithOutput(cwd, ['rev-parse', '--show-toplevel'])).trim();
  if (toplevel === '') throw new Error('Not inside a git working tree');
  const target = path.join(cwd, filePath);
  const treeRoot = path.resolve(toplevel);
  const rel = path.relative(treeRoot, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to discard ${JSON.stringify(filePath)}: at or outside the repository root`);
  }
  if (area !== 'untracked') return execGit(cwd, ['checkout', '--', filePath]);
  // Git-slash pathspec: entry.path arrives in git's own spelling, and a
  // native backslash would read as a pathspec escape.
  const pathspec = filePath.split(path.sep).join('/');
  const untracked = (await execGitWithOutput(cwd, ['ls-files', '--others', '--exclude-standard', '--', pathspec])).trim();
  if (untracked === '') {
    throw new Error(`Refusing to discard ${JSON.stringify(filePath)}: git reports no untracked file there`);
  }
  const tracked = (await execGitWithOutput(cwd, ['ls-files', '--', pathspec])).trim();
  if (tracked !== '') {
    throw new Error(`Refusing to discard ${JSON.stringify(filePath)}: it carries tracked files`);
  }
  return fs.promises.rm(target, { recursive: true, force: true });
}

export function getGitWorktrees(cwd: string): Promise<GitWorktree[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }

        const worktrees: GitWorktree[] = [];
        const blocks = stdout.split('\n\n');

        for (const block of blocks) {
          const lines = block.trim().split('\n');
          if (lines.length === 0 || !lines[0]) continue;

          let path = '';
          let head = '';
          let branch: string | null = null;
          let isBare = false;

          for (const line of lines) {
            if (line.startsWith('worktree ')) {
              path = line.slice('worktree '.length);
            } else if (line.startsWith('HEAD ')) {
              head = line.slice('HEAD '.length);
            } else if (line.startsWith('branch ')) {
              const ref = line.slice('branch '.length);
              branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
            } else if (line === 'bare') {
              isBare = true;
            } else if (line === 'detached') {
              branch = null;
            }
          }

          if (path) {
            // C5G-10: macOS lsof returns symlink-resolved cwd (/private/tmp...);
            // canonicalize both sides so the renderer's prefix match hits /tmp worktrees.
            if (isMac) path = canonicalPath(path);
            worktrees.push({ path, head, branch, isBare });
          }
        }

        resolve(worktrees);
      }
    );
  });
}

export function getGitRemoteUrl(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    // P2-24: every sibling execFile in this module bounds the spawn with
    // timeout: 5000; a hung `git remote get-url` (credential prompt, dead
    // network mount) used to pin the renderer's repo-detection promise
    // forever. The failure shape is unchanged: err (incl. ETIMEDOUT) → null.
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const raw = stdout.trim();
      // Normalize SSH (git@github.com:owner/repo.git) to HTTPS
      const ssh = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      if (ssh) { resolve(`https://${ssh[1]}/${ssh[2]}`); return; }
      // Strip trailing .git from HTTPS URLs
      resolve(raw.replace(/\.git$/, '') || null);
    });
  });
}

// Bound both disk input and expanded diff output, even if a file grows during the read.
async function readUntrackedDiff(fullPath: string, filePath: string): Promise<string> {
  const limit = 256 * 1024;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(fullPath, 'r');
    if ((await handle.stat()).size > limit) return '(file too large to preview; limit 256 KiB)';
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) return '(file too large to preview; limit 256 KiB)';
    if (buffer.subarray(0, length).includes(0)) return '(binary file; no text preview)';
    const lines = buffer.toString('utf8', 0, length).split('\n');
    if (lines.length > 5000) return '(too many lines to preview; limit 5,000 lines)';
    return '--- /dev/null\n+++ b/' + filePath + '\n@@ -0,0 +1,' + lines.length + ' @@\n' + lines.map(line => '+' + line).join('\n');
  } catch { return '(unable to read file)'; }
  finally { await handle?.close().catch(() => {}); }
}
