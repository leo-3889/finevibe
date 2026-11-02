/**
 * Row 26 slice 6: the git IPC domain — 13 registrations plus the root/file
 * gates only they use.
 *
 * Seam contract (leaf-domains.ts / fs-domains.ts): channels stay STRING
 * LITERALS so ipc-channel-parity.test.ts keeps pinning both ends, bodies are a
 * verbatim move, and nothing imports back into `ipc-handlers.ts`.
 *
 * Design note (audit row 26): like slice 5, none of this was state a caller
 * owns. The git handlers closed over four gates declared beside them
 * (`requireGitRoot` / `requireGitTarget` / `requireRemoteRelPath` /
 * `requireGitFilePath`) and the watched-roots set `requireGitRoot` admits from
 * — all git-private except `requireGitRoot` itself, which is exported because
 * `github:detectRepo` (app-domains) and `readiness:analyze` (support-domains)
 * use the same root rule; ipc-handlers.ts imports it from here and forwards it
 * as those two domains' dep. The shared project gates stay in project-gates.ts.
 *
 * The ONE injected dep is `notifyGitChanged`: the emitter lives in
 * git-watcher.ts and the `onGitChanged(invalidateEnumerations)` subscription
 * (PA-07) stays wired in ipc-handlers.ts, where the fs cache import lives.
 * Injecting the notifier keeps that wiring in one place and lets a mutation
 * test assert the signal fires without loading the watcher.
 */
import { ipcMain, shell } from 'electron';
import * as path from 'path';
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
} from '../git-on';
import { startGitWatcher } from '../git-watcher';
import { getHost } from '../hosts/host-registry';
import { getMainWindow } from '../main-window';
import { canonicalPath, canonicalRoot, isWithin } from '../fs-utils';
import { isWithinKnownProject, remoteProjectOwnerOf } from '../project-gates';
import { safeOn } from './safe-on';

export interface GitDomainsDeps {
  /** Debounced git:changed emitter (git-watcher.ts); see the header note. */
  notifyGitChanged: () => void;
}

/**
 * git:* handlers run real git (and `rm -r` on untracked discard) in an
 * IPC-supplied cwd. Bound every git root to a known project directory or a
 * root the git panel actively watches — worktrees live outside the project
 * dir by design — so a compromised renderer cannot aim git (or the
 * recursive-delete sink) at arbitrary cwds. P1-17: watched roots enter the
 * set only through git:watchProject's PROJECT-tier gate — the read
 * allowlist's CLI config dirs never join it — and the destructive sink
 * verifies its own bounds: gitDiscardFile refuses any cwd that is not a
 * real working tree (`rev-parse --show-toplevel`), the tree root as a
 * target, and any untracked path git does not vouch for.
 */
const gitWatchedRoots = new Set<string>();
const MAX_GIT_WATCHED_ROOTS = 200;

export function requireGitRoot(channel: string, projectPath: string): string {
  if (typeof projectPath !== 'string') throw new Error('Invalid project path');
  const resolved = path.resolve(projectPath);
  const remoteOwner = remoteProjectOwnerOf(resolved);
  if (remoteOwner) {
    console.warn(`${channel} blocked: ${resolved} is a project on remote host ${remoteOwner} - git runs on this machine only`);
    throw new Error('Project lives on a remote host');
  }
  // Register and compare in canonical form. The renderer spells the same
  // directory differently (drive-letter case, separators, `..`, junctions) and
  // isWithinKnownProject canonicalizes on its side, so a raw-string set let one
  // spelling bypass a gate the other spelling passed - and counted as a second
  // root, evicting a real watched worktree.
  const canonical = canonicalRoot(resolved);
  if (!isWithinKnownProject(canonical) && !gitWatchedRoots.has(canonical)) {
    console.warn(`${channel} blocked: ${resolved} is not a known project or watched worktree`);
    throw new Error('Path is not within a known project');
  }
  return resolved;
}

/**
 * Phase 3.5 R2 routing: a remote-owned path resolves to its host record and
 * the exec lane; everything else goes through the local requireGitRoot gate
 * (a remote root whose host record was deleted keeps the belt refusal).
 */
function requireGitTarget(channel: string, projectPath: string): GitTarget {
  if (typeof projectPath !== 'string') throw new Error('Invalid project path');
  // R3: the remote compare runs on the RAW string. path.resolve on the
  // controller turns posix `/srv/app` into `C:\srv\app` on Windows and the
  // match is lost there - the old belt only fired cross-platform because it
  // compared the resolved form (and was inert on Windows, per its own test).
  const owner = remoteProjectOwnerOf(projectPath);
  const record = owner ? getHost(owner) : null;
  if (owner && record) {
    const posix = projectPath.replace(/\\/g, '/');
    return { kind: 'remote', record, cwd: posix.replace(/\/+$/, '') || '/' };
  }
  return { kind: 'local', cwd: requireGitRoot(channel, projectPath) };
}

/**
 * filePath for a REMOTE project: git's own relative spelling (from the
 * porcelain list). No path.resolve on the controller - a posix string
 * canonicalized on Windows is the R3 shared-fiction bug - so validate
 * structurally: relative, no `..` segments, no NUL.
 */
function requireRemoteRelPath(channel: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') throw new Error('Invalid file path');
  const posix = filePath.replace(/\\/g, '/');
  if (posix.includes('\0') || path.posix.isAbsolute(posix) || posix.split('/').includes('..')) {
    console.warn(`${channel} blocked: ${filePath} is not a path inside the project`);
    throw new Error('Invalid file path');
  }
  return posix;
}

/** filePath arrives from the renderer; keep the joined target inside the root. */
function requireGitFilePath(channel: string, root: string, filePath: string): string {
  if (typeof filePath !== 'string') throw new Error('Invalid file path');
  const joined = path.resolve(root, filePath);
  // P1-17: `''`, `.` and `x/..` all resolve to the ROOT itself. Every git
  // file channel acts on a file — an untracked "discard" of the root is a
  // whole-tree `rm -r`, never a single-file operation — so a path that
  // lands on the root is refused here, before any handler sees it.
  if (path.relative(path.resolve(root), joined) === '') {
    console.warn(`${channel} blocked: ${JSON.stringify(filePath)} resolves to the root ${root}`);
    throw new Error('File path must be inside the project, not the project root');
  }
  if (!isWithin(canonicalRoot(root), canonicalPath(joined))) {
    console.warn(`${channel} blocked: ${filePath} escapes ${root}`);
    throw new Error('File path escapes the project');
  }
  return filePath;
}


export function registerGitDomains(deps: GitDomainsDeps): void {
  ipcMain.handle('git:getStatus', (_event, projectPath: string) => gitOnStatus(requireGitTarget('git:getStatus', projectPath)));

  ipcMain.handle('git:getRemoteUrl', (_event, projectPath: string) => gitOnRemoteUrl(requireGitTarget('git:getRemoteUrl', projectPath)));

  ipcMain.handle('git:getFiles', (_event, projectPath: string) => gitOnFiles(requireGitTarget('git:getFiles', projectPath)));

  ipcMain.handle('git:getDiff', (_event, projectPath: string, filePath: string, area: string) => {
    const target = requireGitTarget('git:getDiff', projectPath);
    const rel = target.kind === 'remote'
      ? requireRemoteRelPath('git:getDiff', filePath)
      : requireGitFilePath('git:getDiff', target.cwd, filePath);
    return gitOnDiff(target, rel, area);
  });

  ipcMain.handle('git:getWorktrees', (_event, projectPath: string) => gitOnWorktrees(requireGitTarget('git:getWorktrees', projectPath)));

  ipcMain.handle('git:stageFile', async (_event, projectPath: string, filePath: string) => {
    const target = requireGitTarget('git:stageFile', projectPath);
    // Phase 4b: the write routes through the gitOn lane; the local sibling
    // keeps the requireGitFilePath gate, the remote one validates internally
    // (path.resolve on a controller would mangle a remote posix path).
    await gitOnStageFile(
      target,
      target.kind === 'local' ? requireGitFilePath('git:stageFile', target.cwd, filePath) : filePath,
    );
    deps.notifyGitChanged();
  });

  ipcMain.handle('git:unstageFile', async (_event, projectPath: string, filePath: string) => {
    const target = requireGitTarget('git:unstageFile', projectPath);
    await gitOnUnstageFile(
      target,
      target.kind === 'local' ? requireGitFilePath('git:unstageFile', target.cwd, filePath) : filePath,
    );
    deps.notifyGitChanged();
  });

  ipcMain.handle('git:discardFile', async (_event, projectPath: string, filePath: string, area: string) => {
    const target = requireGitTarget('git:discardFile', projectPath);
    await gitOnDiscardFile(
      target,
      target.kind === 'local' ? requireGitFilePath('git:discardFile', target.cwd, filePath) : filePath,
      area,
    );
    deps.notifyGitChanged();
  });

  ipcMain.on('git:watchProject', safeOn('git:watchProject', (_event, projectPath: string) => {
    const win = getMainWindow();
    if (!win) return;
    const resolved = path.resolve(projectPath);
    // P1-17: watched roots become git-capable roots (requireGitRoot admits
    // them) and the git panel's untracked discard ends in a recursive rm —
    // so watch takes the PROJECT tier, not the read allowlist. The CLI
    // config trees (~/.claude, ~/.codex, ~/.gemini, ~/.copilot, the
    // ClaudeCode dirs) stay read-allowed for the config panels and never
    // join the set of roots a renderer can aim git: channels at. Legit
    // watch callers pass the active project's path (git-status.ts), and
    // out-of-tree worktrees are project dirs by the same gate.
    if (!isWithinKnownProject(resolved)) {
      console.warn(`git:watchProject blocked: ${resolved}`);
      return;
    }
    // Canonical form is the set key, and re-registering a watched root must
    // not evict the oldest entry.
    const canonical = canonicalRoot(resolved);
    if (!gitWatchedRoots.has(canonical)) {
      if (gitWatchedRoots.size >= MAX_GIT_WATCHED_ROOTS) {
        const oldest = gitWatchedRoots.values().next().value;
        if (oldest !== undefined) gitWatchedRoots.delete(oldest);
      }
      gitWatchedRoots.add(canonical);
    }
    startGitWatcher(win, resolved);
  }));

  ipcMain.handle('git:listBranches', (_event, projectPath: string) => gitOnBranches(requireGitTarget('git:listBranches', projectPath)));

  ipcMain.handle('git:checkoutBranch', async (_event, projectPath: string, branch: string) => {
    const target = requireGitTarget('git:checkoutBranch', projectPath);
    await gitOnCheckoutBranch(target, branch);
    deps.notifyGitChanged();
  });

  ipcMain.handle('git:createBranch', async (_event, projectPath: string, branch: string) => {
    const target = requireGitTarget('git:createBranch', projectPath);
    await gitOnCreateBranch(target, branch);
    deps.notifyGitChanged();
  });

  ipcMain.handle('git:openInEditor', (_event, projectPath: string, filePath: string) => {
    const root = requireGitRoot('git:openInEditor', projectPath);
    const fullPath = path.join(root, requireGitFilePath('git:openInEditor', root, filePath));
    return shell.openPath(fullPath);
  });
}
