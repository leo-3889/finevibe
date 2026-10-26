/**
 * R2 gitOn lane (docs/hosts.md): one signature per git read, the local sink
 * and the remote sibling selected by the project's owner — never a fallback.
 *
 * Routing: a project path that matches a remote project root (raw posix
 * compare, R3) runs git over the ssh exec lane (`execOn`); every other path
 * goes through the local gate (known-project / watched-root allowlist) and
 * the local sink in git-status.ts. The Phase 3 refuse-belt is retired for
 * reads: `git:getStatus` on a remote project now answers from the host
 * instead of throwing.
 *
 * Scope is READ-ONLY (Phase 3.5 contract): stage/unstage/discard/checkout/
 * create stay local-only and refuse remote paths — a remote mutation needs
 * the write-side design (mtime races, lock files), tracked as Phase 4.
 */
import { exec, sftpRead } from './hosts/ssh-client';
import type { HostRecord } from '../shared/types';
import {
  getGitStatus,
  getGitFiles,
  getGitDiff,
  getGitWorktrees,
  getGitRemoteUrl,
  listGitBranches,
  parseStatusOutput,
  parseFilesOutput,
  parseWorktreeOutput,
  parseBranchOutput,
  normalizeRemoteUrl,
  formatUntrackedDiff,
  NOT_A_REPO,
  type GitStatus,
  type GitBranch,
} from './git-status';
import type { GitFileEntry, GitWorktree } from '../shared/types';

type RemoteTarget = Extract<GitTarget, { kind: "remote" }>;
export type GitTarget =
  | { kind: 'local'; cwd: string }
  | { kind: 'remote'; record: HostRecord; cwd: string };

/** POSIX single-quote escape for the exec lane (no shell on our side, but the remote sshd runs the command through a shell). */
function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** exec with the same 5 s bound every local git spawn carries (P2-24 parity). */
function gitExec(target: RemoteTarget, args: string[]): Promise<string> {
  return exec(target.record, `git -C ${shq(target.cwd)} ${args.join(' ')}`, { timeoutMs: 5000 });
}

async function remoteStatus(target: RemoteTarget): Promise<GitStatus> {
  try {
    const out = await gitExec(target, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    return parseStatusOutput(out);
  } catch {
    return NOT_A_REPO;
  }
}

async function remoteFiles(target: RemoteTarget): Promise<GitFileEntry[]> {
  try {
    const out = await gitExec(target, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
    return parseFilesOutput(out);
  } catch {
    return [];
  }
}

async function remoteDiff(
  target: RemoteTarget,
  filePath: string,
  area: string,
): Promise<string> {
  if (area === 'untracked') {
    const content = await sftpRead(target.record, posixJoin(target.cwd, filePath));
    if (content === null) return '(unable to read file)';
    // The local sink bounds the preview at 256 KiB before formatting; the
    // sftp read already returned the whole file, so apply the same cap here.
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) return '(file too large to preview; limit 256 KiB)';
    return formatUntrackedDiff(content, filePath);
  }
  const args = area === 'staged' ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
  try {
    return await gitExec(target, args);
  } catch {
    return '(no diff available)';
  }
}

function posixJoin(dir: string, rel: string): string {
  return `${dir.replace(/\/+$/, '')}/${rel.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

async function remoteWorktrees(target: RemoteTarget): Promise<GitWorktree[]> {
  try {
    const out = await gitExec(target, ['worktree', 'list', '--porcelain']);
    return parseWorktreeOutput(out);
  } catch {
    return [];
  }
}

async function remoteRemoteUrl(target: RemoteTarget): Promise<string | null> {
  try {
    return normalizeRemoteUrl(await gitExec(target, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

async function remoteBranches(target: RemoteTarget): Promise<GitBranch[]> {
  try {
    return parseBranchOutput(await gitExec(target, ['branch', '--list']));
  } catch {
    return [];
  }
}

/** A remote project has no local tree to mutate; every git write channel calls this first. */
export function refuseRemoteMutation(channel: string, target: GitTarget): void {
  if (target.kind === 'remote') {
    console.warn(`${channel} blocked: git is read-only for remote projects (Phase 3.5)`);
    throw new Error('Project lives on a remote host');
  }
}

// ---- The lane: one entry point per git read, dispatched on the target ----

export function gitOnStatus(target: GitTarget): Promise<GitStatus> {
  return target.kind === 'local' ? getGitStatus(target.cwd) : remoteStatus(target);
}

export function gitOnFiles(target: GitTarget): Promise<GitFileEntry[]> {
  return target.kind === 'local' ? getGitFiles(target.cwd) : remoteFiles(target);
}

export function gitOnDiff(target: GitTarget, filePath: string, area: string): Promise<string> {
  return target.kind === 'local' ? getGitDiff(target.cwd, filePath, area) : remoteDiff(target, filePath, area);
}

export function gitOnWorktrees(target: GitTarget): Promise<GitWorktree[]> {
  return target.kind === 'local' ? getGitWorktrees(target.cwd) : remoteWorktrees(target);
}

export function gitOnRemoteUrl(target: GitTarget): Promise<string | null> {
  return target.kind === 'local' ? getGitRemoteUrl(target.cwd) : remoteRemoteUrl(target);
}

export function gitOnBranches(target: GitTarget): Promise<GitBranch[]> {
  return target.kind === 'local' ? listGitBranches(target.cwd) : remoteBranches(target);
}
