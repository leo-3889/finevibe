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
 * Scope: Phase 3.5 delivered the reads; Phase 4b adds the write side
 * (stage/unstage/discard/checkout/create) over the same exec lane, with the
 * same argument safety (single-quote every renderer-supplied argument before
 * it reaches the remote shell). The old `refuseRemoteMutation` belt is retired.
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
  gitStageFile,
  gitUnstageFile,
  gitDiscardFile,
  checkoutGitBranch,
  createGitBranch,
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

// ---- Phase 4b: the write side ----
//
// One entry point per git mutation, dispatched on the target like the reads.
// The remote siblings single-quote every renderer-supplied argument (shq) —
// the exec lane runs the command through the remote shell, so an unquoted
// `;`, space or backtick in a path/branch is remote command injection, not
// just a broken argv. Path safety mirrors the local requireGitFilePath rules
// (relative posix path, no `..`, non-empty); the remote sibling joins onto
// the target cwd, so a `..` could otherwise reach outside the project.

/** Local requireGitFilePath rules, applied to the raw posix spelling (no
 * local path.resolve — a remote path must never be resolved on the
 * controller's OS). */
function requireRemoteRelPath(channel: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error(`${channel}: invalid file path`);
  }
  if (filePath.includes('\0') || filePath.startsWith('/') || filePath.split('/').includes('..')) {
    throw new Error(`${channel}: ${JSON.stringify(filePath)} is not a path inside the project`);
  }
  return filePath;
}

async function remoteStage(target: RemoteTarget, filePath: string): Promise<void> {
  await gitExec(target, ['add', '--', shq(requireRemoteRelPath('git:stageFile', filePath))]);
}

async function remoteUnstage(target: RemoteTarget, filePath: string): Promise<void> {
  await gitExec(target, ['reset', 'HEAD', '--', shq(requireRemoteRelPath('git:unstageFile', filePath))]);
}

/**
 * Untracked discard uses `git clean -fd -- <path>`: git's own guarantee that
 * only untracked content is removed (the local sink reaches the same promise
 * through explicit ls-files verification before its rm -r). Tracked discard
 * is `git checkout -- <path>`, identical to the local command.
 */
async function remoteDiscard(target: RemoteTarget, filePath: string, area: string): Promise<void> {
  const rel = shq(requireRemoteRelPath('git:discardFile', filePath));
  if (area === 'untracked') {
    await gitExec(target, ['clean', '-fd', '--', rel]);
    return;
  }
  await gitExec(target, ['checkout', '--', rel]);
}

/** Branch names are validated by git itself (check-ref-format), exactly like
 * the local checkoutGitBranch/createGitBranch do before their spawn. */
async function remoteCheckout(target: RemoteTarget, branch: string, create: boolean): Promise<void> {
  if (typeof branch !== 'string' || branch === '' || branch.startsWith('-')) {
    throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
  await gitExec(target, ['check-ref-format', '--branch', shq(branch)]);
  await gitExec(target, create ? ['checkout', '-b', shq(branch)] : ['checkout', shq(branch)]);
}

export function gitOnStageFile(target: GitTarget, filePath: string): Promise<void> {
  return target.kind === 'local' ? gitStageFile(target.cwd, filePath) : remoteStage(target, filePath);
}

export function gitOnUnstageFile(target: GitTarget, filePath: string): Promise<void> {
  return target.kind === 'local' ? gitUnstageFile(target.cwd, filePath) : remoteUnstage(target, filePath);
}

export function gitOnDiscardFile(target: GitTarget, filePath: string, area: string): Promise<void> {
  return target.kind === 'local'
    ? gitDiscardFile(target.cwd, filePath, area as GitFileEntry['area'])
    : remoteDiscard(target, filePath, area);
}

export function gitOnCheckoutBranch(target: GitTarget, branch: string): Promise<void> {
  return target.kind === 'local' ? checkoutGitBranch(target.cwd, branch) : remoteCheckout(target, branch, false);
}

export function gitOnCreateBranch(target: GitTarget, branch: string): Promise<void> {
  return target.kind === 'local' ? createGitBranch(target.cwd, branch) : remoteCheckout(target, branch, true);
}
