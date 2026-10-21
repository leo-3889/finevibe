import { ipcMain, BrowserWindow, app, dialog, shell, clipboard, session, utilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnPty, spawnShellPty, writePty, resizePty, killPty, getPtyCwd } from './pty-manager';
import { addMcpServer, removeMcpServer, isManagedMcpConfigDir } from './claude-cli';
import type { McpServerConfig } from './claude-cli';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, getKnownProjectPaths, PersistedState } from './store';
import { startWatching, cleanupSessionStatus, resyncAllSessions, registerSession } from './hook-status';
import { registerTranscriptSync, unregisterTranscriptSync, getSyncedTranscriptPath } from './session-transcript-sync';
import type { SessionExitReason } from './providers/pi-compatible-transcripts';
import { getGitStatus, getGitFiles, getGitDiff, getGitWorktrees, gitStageFile, gitUnstageFile, gitDiscardFile, getGitRemoteUrl, listGitBranches, checkoutGitBranch, createGitBranch } from './git-status';
import { startGitWatcher, notifyGitChanged } from './git-watcher';
import { watchDir, unwatchDir, setFileWatcherWindow } from './file-watcher';
import { registerMcpHandlers } from './mcp-ipc-handlers';
import { checkForUpdates, quitAndInstall } from './auto-updater';
import { probeAgentmemory, ensureAgentmemoryRunning } from './agentmemory-manager';
import { createAppMenu } from './menu';
import { getProvider, getAllProviderMetas, getAllProviders } from './providers/registry';
import { exportSessionArchive, resolveLaunchSessionDir } from './session-export';
import type { CliProvider } from './providers/provider';
import { buildHandoffPrompt } from './providers/resume-handoff';
import { searchSessions } from './session-deep-search';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../shared/token-estimate';
import { SPAWN_REJECTED_EXIT_REASON } from '../shared/constants';
import { analyzeReadiness } from './readiness/analyzer';
import { isGhAvailable, listPullRequests, listIssues, detectRepo } from './github-cli';
import { detectGitCheckoutUrl } from '../shared/git-url';
import type { ProviderId, Profile, GitFileEntry, SettingsValidationResult, ReadFileResult, FileStatResult, TopFilesResult, TopFile, ArchivedSession } from '../shared/types';
import { canonicalPath, canonicalRoot, expandUserPath, isBinaryBuffer, isMacPackagePath, BINARY_SNIFF_BYTES, invalidateCanonicalPathIfRootsChanged } from './fs-utils';
import { isLinux, isMac, isWin } from './platform';
import { listProfiles as listChromeProfiles, runImport as runChromeImport, clearImportedCookies, getCookieCount } from './chrome-import/importer';
import { sweepImportTempDirs } from './chrome-import/copy';
import type { ChromeImportOptions, ChromeImportProgress, ClipboardSource, ClipboardPastePayload } from '../shared/types';
import { shouldWarnStatusLine, getDirConsent, recordDirConsent } from './settings-guard';
import { buildVibeyardignoreMatcher } from './vibeyardignore';
import { setCloseConfirmed } from './close-state';
import { provisionProfileDir } from './profiles';
import { getKeychainIsolationStatus } from './claude-keychain';
const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
// "Checkout and create": a full clone of a large allowlisted repo over a slow
// link is minutes, not seconds; the modal shows a progress state, so this
// generous bound only bounds hangs.
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * Check if a resolved path is within one of the known project directories.
 */
function isWithinKnownProject(resolvedPath: string): boolean {
  const target = canonicalPath(resolvedPath);
  const paths = getKnownProjectPaths();
  return paths.some(p => isWithin(canonicalRoot(p), target));
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

function requireGitRoot(channel: string, projectPath: string): string {
  if (typeof projectPath !== 'string') throw new Error('Invalid project path');
  const resolved = path.resolve(projectPath);
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

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/**
 * Envelope for fs handlers that act on a path: resolve it, refuse anything
 * outside a known project (stricter than isAllowedReadPath — never config dirs
 * like ~/.claude or ~/.codex), and turn a throw into `{ ok: false, error }`.
 * `act` may return a non-empty error string to report a failure of its own.
 */
async function withProjectPath(
  channel: string,
  targetPath: string,
  act: (resolved: string) => Promise<string | void>
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resolved = path.resolve(targetPath);
    if (!isWithinKnownProject(resolved)) {
      console.warn(`${channel} blocked: ${resolved} is not within a known project`);
      return { ok: false, error: 'Path is not within a known project' };
    }
    const error = await act(resolved);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    console.warn(`${channel} failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Check if a resolved path is allowed for reading:
 * within a known project directory OR a known config location.
 */
function isAllowedReadPath(resolvedPath: string): boolean {
  // Allow files within known project directories
  if (isWithinKnownProject(resolvedPath)) {
    return true;
  }

  // Allow known config files/directories used by supported CLIs
  const home = os.homedir();
  const allowedPaths = [
    path.join(home, '.claude.json'),
    path.join(home, '.mcp.json'),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
    path.join(home, '.copilot'),
  ];

  if (isMac) {
    allowedPaths.push('/Library/Application Support/ClaudeCode');
  } else if (isWin) {
    allowedPaths.push('C:\\Program Files\\ClaudeCode');
  } else {
    allowedPaths.push('/etc/claude-code');
  }

  const target = canonicalPath(resolvedPath);
  return allowedPaths.some(allowed => isWithin(canonicalRoot(allowed), target));
}

/**
 * fs channels that stat/enumerate renderer-named directories: fs:exists'
 * read gate widened with the home tree. The pre-project add / new-project
 * picker flows run in home before any project exists, so home is a
 * legitimate enumeration root; everything outside home + known roots is
 * not app data and needs the explicit confirm below (fs:listDirs) or is
 * answered with the channel's empty shape (fs:isDirectory).
 */
function isWithinHomeTree(resolvedPath: string): boolean {
  return isWithin(canonicalRoot(os.homedir()), canonicalPath(resolvedPath));
}

function isAllowedEnumeratePath(resolvedPath: string): boolean {
  return isAllowedReadPath(resolvedPath) || isWithinHomeTree(resolvedPath);
}

/** Confirm flow for home-outside enumeration, mirroring confirmRemoteHost in
 * mcp-ipc-handlers: Cancel is the default and the deny answer. */
async function confirmHomeOutsideListing(dir: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Browse outside home?',
    message: `List directories in ${dir}?`,
    detail: 'This location is outside your home directory and known projects. Only continue for directories you trust.',
    buttons: ['Cancel', 'Confirm'],
    defaultId: 0,
    cancelId: 0,
  };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * Enumerate files in a project root. Prefers `git ls-files` (respects .gitignore);
 * falls back to a depth- and count-limited recursive walk when not a git repo.
 * Returns repo-relative paths.
 */
const execFileAsync = promisify(execFile);

async function enumerateProjectFiles(resolvedCwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: resolvedCwd, encoding: 'utf-8', timeout: 5000 },
    );
    return stdout.split('\n').filter(Boolean);
  } catch {
    const files: string[] = [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
    const MAX_DEPTH = 5;
    const MAX_FILES = 5000;
    function walk(dir: string, depth: number): void {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) return;
        if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
        const rel = path.relative(resolvedCwd, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), depth + 1);
        } else {
          files.push(rel);
        }
      }
    }
    walk(resolvedCwd, 0);
    return files;
  }
}

let hookWatcherStarted = false;

export function resetHookWatcher(): void {
  hookWatcherStarted = false;
}

/** A session restored from a previous run, sent to `session:syncRestored`. */
interface RestoredSession {
  sessionId: string;
  providerId: ProviderId;
  cliSessionId: string | null;
  cwd: string;
  configDir?: string;
  createdAt: string;
}

/**
 * An `ipcMain.on` body runs on Electron's main-process dispatch path, and
 * src/main installs no uncaughtException handler — a throw escaping an `on`
 * body is a fatal main-process exception that kills every live PTY and
 * window (P2-108; the P2-84 sendSync class). `ipcMain.handle` bodies are
 * safe (invoke rejects the promise), so only `on` bodies need this wrap:
 * log in the channels' console.warn convention and swallow. A sendSync
 * channel must always answer, and passes `syncFallback` — the benign shape
 * it replies with when the body throws.
 */
type IpcOnHandler = (event: Electron.IpcMainEvent, ...args: any[]) => void;

function safeOn(channel: string, fn: IpcOnHandler, syncFallback?: () => unknown): IpcOnHandler {
  return (event, ...args) => {
    try {
      fn(event, ...args);
    } catch (err) {
      console.warn(`${channel} failed:`, err);
      if (syncFallback) event.returnValue = syncFallback();
    }
  };
}

// ---- Team agents (P2-116 / P2-117) ---------------------------------------
//
// A team member is installed as an agent file into every team-capable
// provider. Two scopes this region owns:
//  - Install targets the tree the spawned CLI reads: a profile-pinned
//    Claude runs with CLAUDE_CONFIG_DIR=<profileDir> and reads agents from
//    `<profileDir>/agents`, so the (renderer-chosen, allowlist-gated)
//    config dir is threaded to the claude provider — mirroring the MCP
//    threading in claude-cli.ts.
//  - Remove only unlinks files Vibeyard wrote: installs stamp a marker
//    comment into the YAML frontmatter, an unmarked same-slug file is
//    user-authored and reported skipped, and per-file results surface
//    provider failures instead of swallowing them.

/** Slugs become file names; reject path syntax before any fs touch. */
const AGENT_SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Agent file naming across providers: `<slug>.md`, `<slug>.agent.md` (Copilot). */
const AGENT_FILE_EXTS = ['.md', '.agent.md'];

function assertAgentSlug(slug: string): void {
  if (typeof slug !== 'string' || !AGENT_SLUG_RE.test(slug)) {
    throw new Error(`Unsafe agent slug: ${JSON.stringify(slug)}`);
  }
}

function agentMarkerLine(slug: string): string {
  return `# installed-by: vibeyard ${slug}`;
}

/** Idempotently stamp the ownership marker into the file's frontmatter. */
function stampAgentMarker(slug: string, content: string): string {
  const marker = agentMarkerLine(slug);
  if (content.includes(marker)) return content;
  const fence = /^---[ \t]*\r?\n/.exec(content);
  if (fence) return `${fence[0]}${marker}\n${content.slice(fence[0].length)}`;
  return `---\n${marker}\n---\n${content}`;
}

/** True when the leading frontmatter block carries the Vibeyard marker. */
function hasAgentMarker(content: string): boolean {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  return fm !== null && /^#[ \t]*installed-by:[ \t]*vibeyard\b/m.test(fm[1]);
}

/**
 * Dirs removal scans for `slug`: the provider's default agents dir plus, for
 * claude, every managed profile's `<configDir>/agents` (the trees a
 * profile-pinned CLI reads, P2-116). `configDir` is handed back so the
 * provider's own removeAgent unlinks from that tree.
 */
function agentRemovalDirs(p: CliProvider): Array<{ dir: string; configDir?: string }> {
  const dirs: Array<{ dir: string; configDir?: string }> = [{ dir: p.agentsDir!() }];
  if (p.meta.id === 'claude') {
    let profiles: Profile[] = [];
    try {
      profiles = loadState().profiles ?? [];
    } catch {
      profiles = []; // store unreadable: scan the default tree only
    }
    for (const pr of profiles) {
      if (pr.providerId === 'claude' && pr.configDir) {
        dirs.push({ dir: path.join(pr.configDir, 'agents'), configDir: pr.configDir });
      }
    }
  }
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const canonical = canonicalPath(d.dir);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/** Per-file outcome of a team-agent removal, surfaced to the renderer. */
type AgentRemoveResult = {
  providerId: string;
  filePath: string;
  status: 'removed' | 'skipped' | 'failed';
  error?: string;
};

/**
 * Scan one provider's agent trees for `slug` and unlink exactly the files
 * carrying the Vibeyard marker (P2-117). Unmarked same-slug files are
 * user-authored and reported skipped; provider unlink failures are reported
 * per file instead of swallowed.
 */
async function removeAgentFromProvider(p: CliProvider, slug: string): Promise<AgentRemoveResult[]> {
  const results: AgentRemoveResult[] = [];
  for (const { dir, configDir } of agentRemovalDirs(p)) {
    for (const ext of AGENT_FILE_EXTS) {
      const filePath = path.join(dir, `${slug}${ext}`);
      let content: string;
      try {
        content = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          results.push({ providerId: p.meta.id, filePath, status: 'failed', error: String((err as Error)?.message ?? err) });
        }
        continue;
      }
      if (!hasAgentMarker(content)) {
        // User-authored (or foreign-managed): Vibeyard never wrote this
        // file, so a slug collision never unlinks it.
        results.push({ providerId: p.meta.id, filePath, status: 'skipped' });
        continue;
      }
      try {
        await p.removeAgent!(slug, configDir);
        results.push({ providerId: p.meta.id, filePath, status: 'removed' });
      } catch (err) {
        results.push({ providerId: p.meta.id, filePath, status: 'failed', error: String((err as Error)?.message ?? err) });
      }
    }
  }
  return results;
}

export function registerIpcHandlers(): void {
  ipcMain.handle('pty:create', async (_event, sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs: string, providerId: ProviderId = 'claude', initialPrompt?: string, systemPrompt?: string, envVars: string = '', configDir?: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    // Start hook status watcher on first PTY creation (window is guaranteed to exist)
    if (!hookWatcherStarted) {
      startWatching(win);
      hookWatcherStarted = true;
    }

    const provider = getProvider(providerId);

    // P1-15: pty:create is the one process-launch channel — the provider CLI
    // runs with renderer-supplied flags in a renderer-supplied cwd, under a
    // renderer-supplied configDir. An unbound (cwd, configDir) makes the
    // agent a read/write/delete reach-everywhere machine. Bind cwd to the
    // project tier (canonical containment under a known project — worktree
    // launch cwds are project dirs too) and configDir to the managed-profile
    // allowlist, the same canonical gate mcp:addServer enforces on its write
    // target. The per-launch sessionDir (pi/omp) is main-derived:
    // resolveLaunchSessionDir accepts only the UI session-id shape.
    // Rejection follows the spawn-rejected contract (pane message +
    // sentinel exit, like pty-manager's pre-spawn rejections): the renderer
    // fires pty:create un-awaited, and a throw would swallow the reason into
    // a blank pane.
    const rejectLaunch = (message: string): void => {
      console.warn(`pty:create blocked: ${message}`);
      win.webContents.send('pty:data', sessionId, '\r\n\x1b[31m' + message + '\x1b[0m\r\n');
      win.webContents.send('pty:exit', sessionId, 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
    };
    if (!isWithinKnownProject(path.resolve(cwd))) {
      rejectLaunch(`Refused to launch: the working directory ${cwd} is not a known project.`);
      return;
    }
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      rejectLaunch(`Refused to launch: the config directory ${configDir} is not a managed profile directory.`);
      return;
    }

    // Providers without a hook system that reports the CLI session id
    // discover it from on-disk artifacts after spawn (codex: history.jsonl,
    if (!cliSessionId) {
      provider.onSessionStarted?.(sessionId, cwd, win, configDir);
    } else {
      // The session already knows its cli id, so discovery never runs —
      // start mirroring the CLI's own title / derived status from the
      // known conversation. The sync derives what to poll from the
      // provider's capabilities (a provider can be both, e.g. OMP).
      // sessionDir (Pi/OMP) is the launch's exclusive transcript dir:
      // path resolution checks it first, so a post-`/clear` transcript is
      // found where the CLI wrote it, not only in the legacy trees.
      const sessionDir = resolveLaunchSessionDir(providerId, sessionId);
      registerTranscriptSync(sessionId, providerId, cliSessionId, cwd, configDir, { sessionDir });
      // ...and let the provider re-attach to its own on-disk state,
      // seeding the sessions watcher as an ADOPTED entry (known id +
      // existing transcript path) so a later `/clear` — a brand-new
      // transcript under a new id in the launch's own dir — is
      // re-adopted instead of the tab freezing on the pre-clear file.
      provider.onSessionResumed?.(sessionId, cwd, win, configDir, cliSessionId);
    }

    const launchStartedAt = Date.now();
    try {
      await spawnPty(
        sessionId,
        cwd,
        cliSessionId,
        isResume,
        extraArgs,
        providerId,
        initialPrompt,
        systemPrompt,
        envVars,
        ptyDataSink(() => win, sessionId),
        (exitCode, signal, pid, spawnRejectedReason) => {
          flushPtyData(sessionId);
          if (spawnRejectedReason) {
            // The launch was rejected before a PTY existed, so this is not a
            // process exit: the pane already carries the actionable reason
            // (written via pty:data), and no transcript can exist yet, so the
            // exit-reason read below is skipped. The reason travels verbatim
            // as the spawn-rejected sentinel and the renderer keeps the pane
            // open instead of archiving/notifying a crash.
            unregisterTranscriptSync(sessionId);
            cleanupSessionStatus(sessionId);
            provider.onSessionExited?.(sessionId);
            const rejectedWin = BrowserWindow.getAllWindows()[0];
            if (rejectedWin && !rejectedWin.isDestroyed()) {
              rejectedWin.webContents.send('pty:exit', sessionId, exitCode, signal, spawnRejectedReason, pid);
            }
            return;
          }
          // pty-manager suppresses the replaced process's callback before it
          // reaches this handler, regardless of which PTY exits first.
          // The session is about to be destroyed — read the CLI's own crash
          // reason from the transcript before the sync entry is torn down.
          let reason: SessionExitReason | null = null;
          let transcriptPath = getSyncedTranscriptPath(sessionId);
          if (!transcriptPath && cliSessionId) {
            try {
              transcriptPath = provider.getTranscriptPath?.(cliSessionId, cwd, configDir, resolveLaunchSessionDir(providerId, sessionId)) ?? null;
            } catch {
              transcriptPath = null;
            }
          }
          if (transcriptPath && provider.readSessionExitReason) {
            try {
              reason = provider.readSessionExitReason(transcriptPath);
            } catch {
              reason = null;
            }
          }
          if (reason?.timestamp) {
            const markerTime = Date.parse(reason.timestamp);
            if (!Number.isFinite(markerTime) || markerTime < launchStartedAt) reason = null;
          }
          const exitReason = reason && reason.kind !== 'normal' && reason.reason !== 'dispose'
            ? reason.reason
            : exitCode !== 0
              ? `exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`
              : signal ? `exited with signal ${signal}` : undefined;
          if (providerId === 'omp') {
            console.info('[omp-session-exit]', JSON.stringify({ at: new Date().toISOString(), sessionId, pid, exitCode, signal, exitReason, transcriptFound: !!transcriptPath }));
          }
          unregisterTranscriptSync(sessionId);
          cleanupSessionStatus(sessionId);
          provider.onSessionExited?.(sessionId);
          const w = BrowserWindow.getAllWindows()[0];
          if (w && !w.isDestroyed()) {
            w.webContents.send('pty:exit', sessionId, exitCode, signal, exitReason, pid);
          }
        },
        configDir
      );
    } catch (err) {
      // spawnPty threw before installing the exit callback — cancel pending
      // id discovery so it can't match an unrelated run later, and drop
      // the transcript sync and status state registered above. Nothing will
      // ever fire the exit callback for a PTY that never spawned, so its 2s
      // poller, fs.watch and name/status IPC would run forever for a session
      // the renderer has already discarded.
      provider.onSessionExited?.(sessionId);
      unregisterTranscriptSync(sessionId);
      cleanupSessionStatus(sessionId);
      throw err;
    }

    // Validate after spawnPty — Copilot installs per-project hooks there, so
    // validating earlier would see an empty config on a project's first spawn.
    if (provider.meta.capabilities.hookStatus) {
      const validation = provider.validateSettings(cwd, configDir);
      const prefs = loadState().preferences;
      // P1-14: consent is per config dir — a Keep/Replace decided for
      // ~/.claude must not mute (or amplify) a profile dir's banner.
      const consent = getDirConsent(prefs, configDir);
      const statusLineIssue = shouldWarnStatusLine(
        validation.statusLine,
        consent.consent,
        consent.command,
        validation.foreignStatusLineCommand,
      );
      const hooksIssue = validation.hooks !== 'complete';
      if (statusLineIssue || hooksIssue) {
        win.webContents.send('settings:warning', {
          sessionId,
          statusLine: statusLineIssue ? validation.statusLine : 'vibeyard',
          hooks: validation.hooks,
          // P2-127: the banner was computed from THIS dir (the profiled
          // session's tree) — carry it so the Fix Settings CTA repairs it,
          // not the default ~/.claude the session never reads.
          configDir,
          foreignStatusLineCommand: validation.foreignStatusLineCommand,
        });
      }
    }
  });

  ipcMain.handle('pty:createShell', (_event, sessionId: string, cwd: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    // P1-15: same launch gate as pty:create — the shell runs in a
    // renderer-named cwd. Production callers (project terminals) pass the
    // project's own path, which is a known project by construction.
    if (!isWithinKnownProject(path.resolve(cwd))) {
      console.warn(`pty:createShell blocked: ${cwd} is not a known project`);
      win.webContents.send('pty:data', sessionId, '\r\n\x1b[31mRefused: the shell working directory is not a known project.\x1b[0m\r\n');
      win.webContents.send('pty:exit', sessionId, 1, undefined, SPAWN_REJECTED_EXIT_REASON, undefined);
      return;
    }
    spawnShellPty(
      sessionId,
      cwd,
      ptyDataSink(() => BrowserWindow.getAllWindows()[0], sessionId),
      (exitCode, signal) => {
        flushPtyData(sessionId);
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:exit', sessionId, exitCode, signal);
        }
      }
    );
  });

  // ---- P5 (R4): pty:data coalescing ---------------------------------------
  //
  // One `webContents.send` per node-pty chunk turned a paste echo into an
  // IPC storm: the P0 probe measured a 1 MB ConPTY paste returning as
  // 1,383 chunks (median 396 B; docs/performance.md), and every send pays
  // a structured clone in main plus a write/cost-scan/share-forward in
  // the renderer. Per session, chunks now share one message inside a
  // 4 ms window capped at 64 KiB; a chunk that alone fills the budget
  // ships immediately — the window degrades to a no-op for bulk output,
  // it never adds latency. `pty:exit` flushes the session buffer first
  // (below), so the renderer never tears a pane down before its last data.
  const PTY_COALESCE_WINDOW_MS = 4;
  const PTY_COALESCE_MAX_BYTES = 64 * 1024;
  const ptyOutboxes = new Map<string, {
    parts: string[];
    bytes: number;
    timer: ReturnType<typeof setTimeout> | null;
    flush(): void;
  }>();

  function ptyDataSink(getWindow: () => BrowserWindow | undefined, sessionId: string): (data: string) => void {
    const outbox = {
      parts: [] as string[],
      bytes: 0,
      timer: null as ReturnType<typeof setTimeout> | null,
      flush() {
        if (outbox.timer !== null) { clearTimeout(outbox.timer); outbox.timer = null; }
        if (outbox.parts.length === 0) return;
        const data = outbox.parts.join('');
        outbox.parts.length = 0;
        outbox.bytes = 0;
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send('pty:data', sessionId, data);
      },
    };
    ptyOutboxes.set(sessionId, outbox);
    return (data: string) => {
      outbox.parts.push(data);
      outbox.bytes += data.length;
      if (outbox.bytes >= PTY_COALESCE_MAX_BYTES) {
        outbox.flush();
        return;
      }
      if (outbox.timer === null) outbox.timer = setTimeout(() => outbox.flush(), PTY_COALESCE_WINDOW_MS);
    };
  }

  function flushPtyData(sessionId: string): void {
    const outbox = ptyOutboxes.get(sessionId);
    if (!outbox) return;
    ptyOutboxes.delete(sessionId);
    outbox.flush();
  }

  ipcMain.on('pty:write', safeOn('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data);
  }));

  ipcMain.on('pty:resize', safeOn('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows);
  }));

  ipcMain.handle('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId);
  });

  ipcMain.handle('fs:isDirectory', (_event, filePath: string) => {
    try {
      const expanded = expandUserPath(filePath);
      // P2-38: this is fs:exists' existence oracle with a second spelling
      // (the sidebar's pre-project add flow), so it takes the widened home
      // gate. Outside home + known roots: answer nothing.
      if (!isAllowedEnumeratePath(expanded)) return false;
      return fs.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:expandPath', (_event, filePath: string): string => {
    return expandUserPath(filePath);
  });

  ipcMain.handle('fs:listDirs', async (_event, dirPath: string, prefix?: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      // P1-19: fs:listDir's gate widened with the home tree — the
      // pre-project picker starts in home. Enumeration outside home +
      // known roots exists only for the directory picker, so it needs the
      // explicit confirm an MCP remote-host connect gets; Cancel = empty.
      if (!isAllowedEnumeratePath(expanded) && !(await confirmHomeOutsideListing(expanded))) return [];
      const entries = fs.readdirSync(expanded, { withFileTypes: true });
      const lowerPrefix = prefix?.toLowerCase();
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && (!lowerPrefix || e.name.toLowerCase().startsWith(lowerPrefix)))
        .map(e => path.join(expanded, e.name))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 20);
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:listDir', (_event, dirPath: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      if (!isAllowedReadPath(expanded)) return [];
      const entries = fs.readdirSync(expanded, { withFileTypes: true });
      // Renderer sorts via sortEntries(); keep main process cheap.
      return entries.map(e => ({
        name: e.name,
        path: path.join(expanded, e.name),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  });

  // "Checkout and create" (Add-project modal): clone a repo the renderer
  // named into a directory the user picked. The destination is a pre-project
  // WRITE, so it takes the pre-project picker's gate shape (fs:listDirs):
  // home tree / known roots pass, a home-outside destination needs the same
  // explicit confirm. The URL is re-validated against the checkout host
  // allowlist, and `--` keeps any URL out of option parsing (`--upload-pack`,
  // ext::) — execFile argv never sees a shell.
  ipcMain.handle('fs:cloneRepo', async (_event, url: string, destPath: string) => {
    try {
      if (typeof url !== 'string' || typeof destPath !== 'string' || !destPath.trim()) {
        return { ok: false, error: 'Invalid clone request' };
      }
      const target = detectGitCheckoutUrl(url);
      if (!target) return { ok: false, error: 'Unsupported repository URL' };
      const dest = path.resolve(expandUserPath(destPath));
      if (!isAllowedEnumeratePath(dest) && !(await confirmHomeOutsideListing(dest))) {
        console.warn(`fs:cloneRepo blocked: ${dest} is outside home and not confirmed`);
        return { ok: false, error: 'Clone location is outside your home directory and was not confirmed' };
      }
      try {
        const st = fs.statSync(dest);
        if (!st.isDirectory()) return { ok: false, error: `Destination exists and is not a directory: ${dest}` };
        if (fs.readdirSync(dest).length > 0) return { ok: false, error: `Destination is not empty: ${dest}` };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, error: `Cannot inspect the destination: ${(err as Error).message}` };
        }
      }
      try {
        await execFileAsync('git', ['clone', '--', target.url, dest], { timeout: GIT_CLONE_TIMEOUT_MS });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
        if (e.code === 'ENOENT') return { ok: false, error: 'git is not installed or not on PATH' };
        if (e.killed) return { ok: false, error: `git clone timed out after ${GIT_CLONE_TIMEOUT_MS / 1000}s` };
        const detail = (e.stderr ?? e.message).trim().split('\n').filter(Boolean).pop();
        return { ok: false, error: `git clone failed: ${detail || 'unknown git error'}` };
      }
      return { ok: true };
    } catch (err) {
      console.warn('fs:cloneRepo failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('store:load', () => {
    return loadState();
  });

  ipcMain.handle('store:save', (_event, state: PersistedState) => {
    invalidateCanonicalPathIfRootsChanged(state); saveState(state);
  });

  // Synchronous startup channel: the renderer applies theme/zoom before its
  // first paint, before the async store:load resolves. Served from the
  // in-memory state cache, so no file read happens on this path.
  ipcMain.on('store:startup-prefs', safeOn('store:startup-prefs', (event) => {
    const prefs = loadState().preferences;
    event.returnValue = { theme: prefs.theme ?? null, zoomFactor: prefs.zoomFactor ?? null };
  }, () => ({ theme: null, zoomFactor: null })));

  // Provision (create) a profile's config dir. Returns the resolved absolute
  // path and whether it is the auto-managed location.
  ipcMain.handle('profiles:provision', (_event, profileId: string, customPath?: string, providerId?: ProviderId) => {
    const configDir = provisionProfileDir(profileId, customPath, providerId, loadState().profiles ?? []);
    return { configDir, managed: !customPath?.trim() };
  });

  // Report whether the installed Claude Code build can isolate per-profile
  // logins on this platform (macOS keychain namespacing). Drives the profile
  // guardrail in the UI.
  ipcMain.handle('profiles:keychainStatus', () => {
    return getKeychainIsolationStatus();
  });

  ipcMain.handle('menu:rebuild', (_event, debugMode: boolean) => {
    createAppMenu(debugMode);
  });

  // Opt-in clipboard latency probes for the P0 paste bench. Off is the
  // default: every probe below sits behind this one gate, so the handlers
  // behave identically when the flag is unset.
  const CLIPBOARD_TIMING = process.env.FINEVIBE_CLIPBOARD_TIMING === '1';
  const fmtMs = (value: number) => value.toFixed(1);
  // Sub-op timings recorded by clipboardFilePaths/writePastedFile for the
  // enclosing readForPaste line. Those helpers keep their signatures, so the
  // accumulator object is handed over synchronously around their calls.
  let pasteSubTimings: Record<string, number> | null = null;

  // P3: `ipcMain.on`, not `ipcMain.handle` — a copy pays no promise round
  // trip and the selection string is cloned once, one-way. The safeOn
  // wrapper is the P2-108 on-body contract: a clipboard throw (owner
  // contention) must not kill main. The Linux PRIMARY split is unchanged:
  // a selection-driven copy populates PRIMARY for middle-click paste, an
  // explicit copy never clobbers it.
  ipcMain.on('clipboard:write', safeOn('clipboard:write', (_event, text: string, source?: ClipboardSource) => {
    const t0 = CLIPBOARD_TIMING ? performance.now() : 0;
    clipboard.writeText(text);
    const tMain = CLIPBOARD_TIMING ? performance.now() : 0;
    // On Linux a selection-driven copy also populates the X11 PRIMARY selection
    // so middle-click paste works. An explicit copy must not — it would clobber
    // whatever the user has selected in another window.
    if (source === 'selection' && isLinux) clipboard.writeText(text, 'selection');
    if (CLIPBOARD_TIMING) {
      const t1 = performance.now();
      console.log(`[copy-timing] clipboard:write total=${fmtMs(t1 - t0)}ms`
        + (source === 'selection' && isLinux ? ` selectionWrite=${fmtMs(t1 - tMain)}ms` : ''));
    }
  }));
  // Every provider takes attachments as a path — a file dropped on a terminal is
  // injected as its path text. A clipboard payload with no path the CLI can read
  // (a screenshot, a copied picture, a browser image) has no path, so main
  // materialises one in the paste temp dir and the renderer injects that. Two
  // entry points: main reads the clipboard itself for the keystrokes the renderer
  // intercepts (Windows Ctrl+V, the context menu), and the renderer hands bytes
  // over for a native paste event, whose file objects main cannot see.
  const PASTE_DIR = path.join(os.tmpdir(), 'vibeyard-paste');
  const PASTE_MAX_BYTES = 25 * 1024 * 1024;
  // P4: the pasted TEXT bound (plan: ~8 MiB), counted in UTF-16 characters —
  // the unit the structured clone and the `pty:write` round trip cost on.
  // Before the cap, a 10 MB log copy crossed IPC twice unbounded.
  const PASTE_TEXT_MAX_CHARS = 8 * 1024 * 1024;
  const PASTE_IMAGE_EXT_BY_MIME: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
  };
  let pasteFilesPruned = false;

  async function writePastedFile(buffer: Buffer, ext: string): Promise<string | null> {
    if (buffer.length === 0 || buffer.length > PASTE_MAX_BYTES) return null;
    try {
      await fs.promises.mkdir(PASTE_DIR, { recursive: true });
      if (!pasteFilesPruned) {
        pasteFilesPruned = true;
        void pruneStaleImages(PASTE_DIR);
      }
      // The name is generated here; the renderer never supplies a path, so a paste
      // cannot write outside the paste directory.
      const filePath = path.join(
        PASTE_DIR,
        `paste-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`,
      );
      const tWrite = CLIPBOARD_TIMING ? performance.now() : 0;
      await fs.promises.writeFile(filePath, buffer);
      if (pasteSubTimings) pasteSubTimings.writeFile = performance.now() - tWrite;
      return filePath;
    } catch (err) {
      console.warn('Failed to store pasted clipboard file', err);
      return null;
    }
  }

  // P4: the PNG encode moves to a utilityProcess (P0: `toPNG` = 192/307 ms
  // p50 at 1080p/1440p — the dominant main-thread freeze of a screenshot
  // paste, on the thread that pumps every PTY chunk; docs/performance.md).
  // The entry is the compiled sibling `png-encode-worker.js` — Node
  // built-ins only, nothing to bundle. Every failure (fork, encode, exit,
  // timeout) rejects and the caller degrades to the synchronous main-thread
  // `toPNG()`: slow, never fatal (plan P4 acceptance: degrade, never crash).
  interface PngEncodeReply { id: number; ok: boolean; png?: ArrayBuffer; error?: string }
  interface PngWorkerChild {
    postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
    on(event: 'message', cb: (event: { data: PngEncodeReply }) => void): void;
    on(event: 'exit', cb: (code: number) => void): void;
    kill(): void;
  }
  const PNG_ENCODE_TIMEOUT_MS = 15_000;
  let pngWorker: PngWorkerChild | null = null;
  let pngWorkerSeq = 0;
  const pngWorkerPending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  function getPngWorker(): PngWorkerChild | null {
    if (pngWorker) return pngWorker;
    try {
      // SAFETY: the child protocol is this file's own; the structural cast
      // keeps the electron UtilityProcess type out of the test-mock surface
      // (the suite's electron stub answers `fork` with a plain object).
      const proc = utilityProcess.fork(path.join(__dirname, 'png-encode-worker.js'), [], {
        serviceName: 'vibeyard-png-encode',
      }) as unknown as PngWorkerChild | null;
      if (!proc) return null;
      proc.on('message', (event) => {
        const reply = event?.data;
        if (!reply || typeof reply.id !== 'number') return;
        const pending = pngWorkerPending.get(reply.id);
        if (!pending) return;
        pngWorkerPending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok && reply.png) pending.resolve(Buffer.from(reply.png));
        else pending.reject(new Error(reply.error ?? 'PNG encode failed'));
      });
      proc.on('exit', () => {
        if (pngWorker === proc) pngWorker = null;
        for (const pending of pngWorkerPending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('PNG encode worker exited'));
        }
        pngWorkerPending.clear();
      });
      pngWorker = proc;
      return proc;
    } catch {
      return null;
    }
  }

  function encodePngViaWorker(rgba: Buffer, width: number, height: number): Promise<Buffer> {
    const proc = getPngWorker();
    if (!proc) return Promise.reject(new Error('no PNG encode worker'));
    const id = ++pngWorkerSeq;
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pngWorkerPending.delete(id)) return;
        try { proc.kill(); } catch { /* already gone */ }
        if (pngWorker === proc) pngWorker = null;
        reject(new Error('PNG encode timed out'));
      }, PNG_ENCODE_TIMEOUT_MS);
      pngWorkerPending.set(id, { resolve, reject, timer });
      // Node pool-allocates Buffers: copy into a dedicated ArrayBuffer so
      // the transfer leaves nothing aliased behind on the main thread.
      const ab = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer;
      try {
        proc.postMessage({ id, rgba: ab, width, height }, [ab]);
      } catch (err) {
        pngWorkerPending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  // P2 (todos/clipboard-paste-latency-plan.md): probe a file-list format
  // only on the platform that defines it AND when `availableFormats()`
  // (already fetched by the caller for free) lists it on this clipboard.
  // A plain-text paste then costs two acquisitions — formats + text — down
  // from six, with zero thrown probes and zero warns; the throw-and-warn
  // probes this replaces read formats that are simply not on a text
  // clipboard. Which format is live per OS is P0-measured
  // (docs/performance.md): Windows FileNameW (Electron's
  // readBuffer('CF_HDROP') answers 0 bytes — Chromium maps the drop list
  // onto text/uri-list — so the CF_HDROP branch stays as the gated
  // pre-wide-senders fallback), macOS NSFilenamesPboardType, Linux
  // text/uri-list (X11 file managers; portal permission can empty the
  // readable set on Wayland — an empty list keeps `hasContent` false and
  // the renderer answers with the CLI's own Ctrl+V paste).
  function decodeXmlText(value: string): string {
    return value
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  const hasFormat = (formats: string[], name: string) =>
    formats.some((format) => format.toLowerCase() === name);

  function clipboardFilePaths(formats: string[]): string[] {
    const paths: string[] = [];
    const sub = pasteSubTimings;
    if (isWin && hasFormat(formats, 'filenamew')) {
      try {
        const tRead = CLIPBOARD_TIMING ? performance.now() : 0;
        // FileNameW: UTF-16LE names, NUL-separated, double-NUL terminated.
        for (const name of clipboard.readBuffer('FileNameW').toString('utf16le').split('\0')) {
          if (name) paths.push(name);
        }
        if (sub) sub.fileNameW = performance.now() - tRead;
      } catch (err) {
        console.warn('Failed to read clipboard file list', err);
      }
    }
    if (isWin && paths.length === 0 && hasFormat(formats, 'cf_hdrop')) {
      try {
        // CF_HDROP is a DROPFILES header followed by the name list. The header
        // is pFiles (name-list offset) @0, pt @4-11, fWide @12 — Explorer sets
        // fWide, so the names are UTF-16LE. Older senders use the OEM codepage,
        // where a single-byte decode keeps ASCII paths intact.
        const tRead = CLIPBOARD_TIMING ? performance.now() : 0;
        const hdrop = clipboard.readBuffer('CF_HDROP');
        if (hdrop.length >= 16) {
          const offset = hdrop.readUInt32LE(0);
          const wide = hdrop.readUInt32LE(12) !== 0;
          const body = hdrop.subarray(Math.min(offset, hdrop.length));
          const names = wide ? body.toString('utf16le') : body.toString('latin1');
          for (const name of names.split('\0')) {
            if (name) paths.push(name);
          }
        }
        if (sub) sub.hdrop = performance.now() - tRead;
      } catch (err) {
        console.warn('Failed to read clipboard file drop list', err);
      }
    }
    if (isMac && paths.length === 0 && hasFormat(formats, 'nsfilenamespboardtype')) {
      try {
        // An old-style XML property list: <array><string>/path</string>…
        const tRead = CLIPBOARD_TIMING ? performance.now() : 0;
        const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
        for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
          paths.push(decodeXmlText(match[1]));
        }
        if (sub) sub.nsPlist = performance.now() - tRead;
      } catch (err) {
        console.warn('Failed to read clipboard file URIs', err);
      }
    }
    if (isLinux && paths.length === 0 && hasFormat(formats, 'text/uri-list')) {
      const tRead = CLIPBOARD_TIMING ? performance.now() : 0;
      for (const line of clipboard.read('text/uri-list').split(/\r?\n/)) {
        const uri = line.trim();
        if (!uri.startsWith('file://')) continue;
        try {
          paths.push(fileURLToPath(uri));
        } catch {
          // A malformed URI is not a file the CLI can read.
        }
      }
      if (sub) sub.uriList = performance.now() - tRead;
    }
    return paths.filter((filePath) => path.isAbsolute(filePath));
  }

  ipcMain.handle('clipboard:readForPaste', async (): Promise<ClipboardPastePayload> => {
    const t0 = CLIPBOARD_TIMING ? performance.now() : 0;
    const formats = clipboard.availableFormats();
    const tFormats = CLIPBOARD_TIMING ? performance.now() : 0;
    // P4: bound the pasted text; the cut is flagged so the renderer shows
    // the user a truncation notice — never a silent content loss.
    const rawText = clipboard.readText();
    const textTruncated = rawText.length > PASTE_TEXT_MAX_CHARS;
    const text = textTruncated ? rawText.slice(0, PASTE_TEXT_MAX_CHARS) : rawText;
    const tText = CLIPBOARD_TIMING ? performance.now() : 0;
    const sub: Record<string, number> | null = CLIPBOARD_TIMING ? {} : null;
    pasteSubTimings = sub;
    const files = clipboardFilePaths(formats);
    pasteSubTimings = null;
    let imagePath: string | null = null;
    let readImageMs = -1;
    let encodeMs = -1;
    let encodeVia: 'png-flavor' | 'worker' | 'main' | null = null;
    // P4 per-OS image flavor table (plan P4; P0 recorded what arrives per
    // OS in docs/performance.md): Windows carries the registered `PNG`
    // flavor (Snipping Tool / Win+Shift+S) next to CF_DIB, macOS NSPasteboard
    // lists `png` beside TIFF, X11 publishes the `image/png` mime, and
    // Wayland portals often expose no image flavor at all. When the
    // clipboard already carries encoded PNG, reading it is a memcpy — no
    // decode, no encode, main idle below the 50 ms target. Only a
    // raw-image-only clipboard (CF_DIB, TIFF, bitmap) pays Electron's
    // main-only `readImage()` decode, and even then the PNG encode runs in
    // the utility worker. A clipboard with no image flavor skips every
    // image read — the documented Wayland degrade: files, text, markup and
    // the Ctrl+V passthrough carry the paste, and the paste event's own
    // `File` objects (screenshot blobs) cover the image case there.
    const pngFlavor = formats.find((format) => format.toLowerCase() === 'png')
      ?? formats.find((format) => format.toLowerCase() === 'image/png');
    if (files.length === 0 && pngFlavor) {
      try {
        const tFlavor = CLIPBOARD_TIMING ? performance.now() : 0;
        const png = clipboard.readBuffer(pngFlavor);
        if (CLIPBOARD_TIMING) encodeMs = performance.now() - tFlavor;
        if (png.length > 0) {
          encodeVia = 'png-flavor';
          pasteSubTimings = sub;
          imagePath = await writePastedFile(png, '.png');
          pasteSubTimings = null;
        }
      } catch (err) {
        console.warn('Failed to read clipboard PNG flavor', err);
      }
    }
    if (imagePath === null && encodeVia === null && files.length === 0 && formats.some((format) => format.toLowerCase().startsWith('image/'))) {
      try {
        // Electron normalises every image flavor (BMP, TIFF, DIB) to PNG, which
        // every provider accepts as an attachment path.
        const tImage = CLIPBOARD_TIMING ? performance.now() : 0;
        const image = clipboard.readImage();
        if (CLIPBOARD_TIMING) readImageMs = performance.now() - tImage;
        if (!image.isEmpty()) {
          const size = image.getSize();
          let png: Buffer;
          const tEncode = CLIPBOARD_TIMING ? performance.now() : 0;
          try {
            png = await encodePngViaWorker(image.toBitmap(), size.width, size.height);
            encodeVia = 'worker';
          } catch {
            // Degrade, never crash: the pre-P4 main-thread encode when the
            // worker cannot start, dies, times out, or fails to encode.
            png = image.toPNG();
            encodeVia = 'main';
          }
          if (CLIPBOARD_TIMING) encodeMs = performance.now() - tEncode;
          pasteSubTimings = sub;
          imagePath = await writePastedFile(png, '.png');
          pasteSubTimings = null;
        }
      } catch (err) {
        console.warn('Failed to read clipboard image', err);
      }
    }
    // Rich-text copies (Word, OneNote, a browser selection) carry HTML next to
    // plain text; with no text at all, the markup source is the only readable
    // content, and a CLI reads markup happily.
    const tHtml = CLIPBOARD_TIMING ? performance.now() : 0;
    const html = text.trim() === '' ? clipboard.readHTML().trim() : '';
    if (CLIPBOARD_TIMING) {
      // One line per paste read, mirroring the branches above: a sub-op that
      // never ran (file-list short-circuit, no image flavor) is omitted.
      const parts = [
        `[paste-timing] readForPaste total=${fmtMs(performance.now() - t0)}ms`,
        `formats=${fmtMs(tFormats - t0)}ms`,
        `text=${fmtMs(tText - tFormats)}ms`,
      ];
      if (sub) {
        for (const key of ['fileNameW', 'hdrop', 'nsPlist', 'uriList'] as const) {
          if (key in sub) parts.push(`${key}=${fmtMs(sub[key])}ms`);
        }
      }
      if (readImageMs >= 0) parts.push(`readImage=${fmtMs(readImageMs)}ms`);
      if (encodeMs >= 0) parts.push(`encode(${encodeVia})=${fmtMs(encodeMs)}ms`);
      if (sub && 'writeFile' in sub) parts.push(`writeFile=${fmtMs(sub.writeFile)}ms`);
      if (text.trim() === '') parts.push(`html=${fmtMs(performance.now() - tHtml)}ms`);
      console.log(parts.join(' '));
    }
    return { text, html, files, imagePath, hasContent: formats.length > 0 || files.length > 0, ...(textTruncated ? { textTruncated: true } : {}) };
  });

  ipcMain.handle('clipboard:saveImage', async (_event, dataUrl: string): Promise<string | null> => {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(typeof dataUrl === 'string' ? dataUrl : '');
    if (!match) return null;
    const ext = PASTE_IMAGE_EXT_BY_MIME[match[1].toLowerCase()];
    if (!ext) return null;
    // The base64 length bounds the decoded size before the decode itself.
    if (match[2].length > Math.ceil((PASTE_MAX_BYTES * 4) / 3)) return null;
    const t0 = CLIPBOARD_TIMING ? performance.now() : 0;
    const saved = await writePastedFile(Buffer.from(match[2], 'base64'), ext);
    if (CLIPBOARD_TIMING) console.log(`[paste-timing] saveImage total=${fmtMs(performance.now() - t0)}ms`);
    return saved;
  });

  ipcMain.handle(
    'provider:getConfig',
    async (_event, providerId: ProviderId, projectPath: string, configDir?: string) => {
      const provider = getProvider(providerId);
      // configDir is the project's pinned profile dir. Providers whose config
      // lives in a relocated agent tree (Pi's mcp.json) must read from it —
      // otherwise a project running as one login shows another login's servers.
      return provider.getConfig(projectPath, configDir);
    }
  );

  ipcMain.on('config:watchProject', safeOn('config:watchProject', (_event, providerId: ProviderId, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const provider = getProvider(providerId);
    provider.startConfigWatcher?.(win, projectPath);
  }));

  ipcMain.handle('provider:listProviders', () => {
    return getAllProviderMetas();
  });

  ipcMain.handle('session:buildResumeWithPrompt', async (
    _event,
    sourceProviderId: ProviderId,
    sourceCliSessionId: string | null,
    projectPath: string,
    sessionName: string,
    configDir?: string,
    liveSessionId?: string,
  ) => {
    // P2-113 boundary gate: a renderer-supplied configDir reaches provider
    // scan roots here - allowlist it before any read, mirroring pty:create.
    if (configDir && !isManagedMcpConfigDir(configDir)) throw new Error('Not a managed profile config dir');
    const sourceProvider = getProvider(sourceProviderId);
    const fromProviderLabel = sourceProvider.meta.displayName;
    let transcriptPath: string | null = null;
    if (sourceCliSessionId && sourceProvider.getTranscriptPath) {
      try {
        // Pi/OMP transcripts live only in the exclusive per-launch dir —
        // resolve it like transcriptExists does, or the handoff finds no
        // transcript for a session whose tab is (or was) live.
        const sessionDir = resolveLaunchSessionDir(sourceProviderId, liveSessionId);
        transcriptPath = sourceProvider.getTranscriptPath(sourceCliSessionId, projectPath, configDir, sessionDir);
      } catch (err) {
        console.warn('getTranscriptPath failed:', err);
      }
    }
    return buildHandoffPrompt({ fromProviderLabel, sessionName, transcriptPath });
  });

  // Whether a resumable transcript actually exists on disk for a given CLI session.
  // Fail-open (return true) when we cannot determine it, so resume/archive is never
  // wrongly blocked for providers we can't introspect.
  const transcriptExists = (
    providerId: ProviderId,
    cliSessionId: string | null,
    projectPath: string,
    configDir?: string,
    liveSessionId?: string,
  ): boolean => {
    if (!cliSessionId) return true;
    // P2-113 boundary gate: an unallowlisted configDir must never reach a
    // provider scan root - report "no transcript" (deny, not fail-open).
    if (configDir && !isManagedMcpConfigDir(configDir)) return false;
    try {
      const provider = getProvider(providerId);
      if (!provider.getTranscriptPath) return true;
      // getTranscriptPath returns null when the transcript is absent (every provider
      // verifies existence on disk), so a non-null path means the transcript exists.
      // Pi/OMP transcripts live only in the exclusive per-launch dir — invisible
      // to the tree scan, so resolve that dir for live/finalizing tabs.
      const sessionDir = resolveLaunchSessionDir(providerId, liveSessionId);
      return provider.getTranscriptPath(cliSessionId, projectPath, configDir, sessionDir) !== null;
    } catch (err) {
      console.warn('transcriptExists check failed:', err);
      return true;
    }
  };
  ipcMain.handle('session:transcriptExists', (_event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string, liveSessionId?: string) =>
    transcriptExists(providerId, cliSessionId, projectPath, configDir, liveSessionId));
  // Synchronous variant: the renderer gates session archiving on this at close time,
  // where the surrounding remove/persist/emit logic must stay synchronous.
  ipcMain.on('session:transcriptExistsSync', safeOn('session:transcriptExistsSync', (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string, liveSessionId?: string) => {
    event.returnValue = transcriptExists(providerId, cliSessionId, projectPath, configDir, liveSessionId);
  }, () => true));
  ipcMain.handle('session:exportArchive', async (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir: string | undefined, meta: ArchivedSession, format: 'zip' | 'file') => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    if (configDir && !isManagedMcpConfigDir(configDir)) throw new Error('Not a managed profile config dir');
    return exportSessionArchive(win, { providerId, cliSessionId, projectPath, configDir, meta, format });
  });

  const searches = new WeakMap<Electron.WebContents, AbortController>();
  ipcMain.on('session:cancelDeepSearch', safeOn('session:cancelDeepSearch', (event) => {
    searches.get(event.sender)?.abort();
  }));
  ipcMain.handle('session:deepSearch', async (event, query: string) => {
    searches.get(event.sender)?.abort();
    const controller = new AbortController();
    searches.set(event.sender, controller);
    const cancel = () => controller.abort();
    event.sender.once('destroyed', cancel);
    try { return await searchSessions(query, controller.signal); }
    finally {
      event.sender.removeListener('destroyed', cancel);
      if (searches.get(event.sender) === controller) searches.delete(event.sender);
    }
  });

  ipcMain.handle('provider:checkBinary', (_event, providerId: ProviderId = 'claude') => {
    const provider = getProvider(providerId);
    return provider.validatePrerequisites();
  });

  ipcMain.handle('provider:installAgent', async (_event, slug: string, content: string, configDir?: string) => {
    assertAgentSlug(slug);
    // configDir is renderer-chosen: the same canonical allowlist as the MCP
    // channel — only store-managed profile (or project) config dirs.
    const pinnedDir = typeof configDir === 'string' && configDir !== '' ? configDir : undefined;
    if (pinnedDir && !isManagedMcpConfigDir(pinnedDir)) {
      throw new Error(`Not a managed profile config dir: ${JSON.stringify(pinnedDir)}`);
    }
    const stamped = stampAgentMarker(slug, content);
    const targets = getAllProviders().filter((p) => p.installAgent && p.validatePrerequisites());
    return Promise.all(targets.map(async (p) => {
      try {
        // A profile config dir is a Claude CLAUDE_CONFIG_DIR tree; other
        // providers have no profiled agents tree and keep their default.
        const r = await p.installAgent!(slug, stamped, p.meta.id === 'claude' ? pinnedDir : undefined);
        return { providerId: p.meta.id, ok: true, filePath: r.filePath };
      } catch (err) {
        return { providerId: p.meta.id, ok: false, error: String((err as Error)?.message ?? err) };
      }
    }));
  });

  ipcMain.handle('provider:removeAgent', async (_event, slug: string) => {
    assertAgentSlug(slug);
    const targets = getAllProviders().filter((p) => p.removeAgent && p.agentsDir);
    const perProvider = await Promise.all(targets.map((p) => removeAgentFromProvider(p, slug)));
    return perProvider.flat();
  });

  ipcMain.handle('fs:browseDirectory', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Replay every status file. The hook scripts write only on change, so a
  // title already on disk produces no further fs event — without this, turning
  // "Auto-name sessions" back on would leave existing tabs unnamed until their
  // title happened to change.
  ipcMain.on('session:resyncStatus', safeOn('session:resyncStatus', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) resyncAllSessions(w);
  }));

  // Re-derive titles for sessions restored from a previous run. A Pi/OMP tab
  // only ever learns the CLI's own title while a live PTY drives
  // `registerTranscriptSync`; after a restart nothing re-reads the transcript,
  // so a tab whose title was generated/changed while Vibeyard was closed stays
  // frozen on its default name. The renderer sends every restored self-titling
  // session; main mirrors each KNOWN-id session's title from its exact
  // transcript. A session whose `cliSessionId` was never persisted stays
  // UNRESOLVED: ownership is not inferred from cwd + creation time (that path
  // can assign an unrelated conversation and persist it), so the tab keeps its
  // default name until it is resumed.
  ipcMain.handle('session:syncRestored', (_event, sessions: RestoredSession[]) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed() || !Array.isArray(sessions)) return;
    // transcript-sync writes `.name` into STATUS_DIR for the watcher to forward,
    // but the watcher only starts on the first `pty:create` — start it now.
    if (!hookWatcherStarted) {
      startWatching(win);
      hookWatcherStarted = true;
    }
    for (const s of sessions) {
      // Validate the record at the IPC boundary. A malformed record is dropped,
      // never allowed to abort the rest of the batch.
      if (!s || typeof s.sessionId !== 'string' || !s.sessionId) continue;
      if (typeof s.providerId !== 'string') continue;
      if (typeof s.cwd !== 'string') continue;
      if (typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt))) continue;
      // Only a KNOWN conversation id gets a title mirror. An unknown id stays
      // unresolved — we do not guess ownership from cwd + time.
      if (typeof s.cliSessionId !== 'string' || !s.cliSessionId) continue;
      try {
        // Pi/OMP: the restored tab's launch dir is derivable from its UI
        // session id, so a post-`/clear` transcript written to it before
        // the restart is resolvable without any persisted mapping.
        const sessionDir = resolveLaunchSessionDir(s.providerId, s.sessionId);
        if (registerTranscriptSync(s.sessionId, s.providerId, s.cliSessionId, s.cwd, s.configDir, { titleOnly: true, sessionDir })) {
          registerSession(s.sessionId);
        }
      } catch {
        // Unknown provider id (registerTranscriptSync → getProvider throws):
        // drop this record and keep going.
      }
    }
  });

  // Drop the restored-session sync registered above when a tab is closed without
  // ever being resumed (a live PTY tears its own down on exit).
  ipcMain.on('session:release', safeOn('session:release', (_event, sessionId: string) => {
    unregisterTranscriptSync(sessionId);
    cleanupSessionStatus(sessionId);
    // Isolated browser partitions (pane.ts: persist:vibeyard-browser-iso-<id>)
    // live in userData/Partitions until quit: an isolated login's cookies and
    // localStorage must go when the session goes. Guarded by directory
    // existence so releasing a non-browser session never materialises a
    // partition via fromPartition().
    if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      const partDir = path.join(app.getPath('userData'), 'Partitions', `vibeyard-browser-iso-${sessionId}`);
      if (fs.existsSync(partDir)) {
        session.fromPartition(`persist:vibeyard-browser-iso-${sessionId}`)
          .clearStorageData()
          .catch((err) => console.warn('clearStorageData failed:', err));
      }
    }
  }));

  ipcMain.on('app:focus', safeOn('app:focus', () => {
    app.focus({ steal: true });
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  }));

  ipcMain.on('app:closeConfirmed', safeOn('app:closeConfirmed', () => {
    setCloseConfirmed(true);
    app.quit();
  }));

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getBrowserPreloadPath', () =>
    path.join(__dirname, '..', '..', 'preload', 'preload', 'browser-tab-preload.js')
  );

  const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
  const MAX_SCREENSHOT_B64_LEN = Math.ceil((MAX_SCREENSHOT_BYTES * 4) / 3);
  const SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  let screenshotsPruned = false;

  // Shared by both temp-image directories: browser screenshots and pasted
  // clipboard images are throwaway attachments, older than a day is dead.
  async function pruneStaleImages(dir: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dir);
      const now = Date.now();
      // Sequential: this is background cleanup, and iterating avoids both the
      // array-callback-return trap and unbounded concurrent deletes.
      for (const name of entries) {
        const full = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(full);
          if (now - stat.mtimeMs > SCREENSHOT_MAX_AGE_MS) {
            await fs.promises.unlink(full);
          }
        } catch (err) {
          console.warn('Failed to prune temp image', full, err);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to read temp image dir for pruning', err);
      }
    }
  }

  ipcMain.handle('browser:saveScreenshot', async (_event, sessionId: string, dataUrl: string) => {
    const PREFIX = 'data:image/png;base64,';
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) {
      throw new Error('Invalid screenshot data URL');
    }
    const b64 = dataUrl.slice(PREFIX.length);
    if (b64.length > MAX_SCREENSHOT_B64_LEN) {
      throw new Error('Screenshot data exceeds size limit');
    }
    const buffer = Buffer.from(b64, 'base64');
    const dir = path.join(os.tmpdir(), 'vibeyard-screenshots');
    await fs.promises.mkdir(dir, { recursive: true });
    if (!screenshotsPruned) {
      screenshotsPruned = true;
      void pruneStaleImages(dir);
    }
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `draw-${safeId}-${Date.now()}.png`);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  });
  ipcMain.handle('chromeImport:listProfiles', () => listChromeProfiles());

  ipcMain.handle('chromeImport:run', async (event, options: ChromeImportOptions) => {
    const send = (p: ChromeImportProgress) => {
      try {
        event.sender.send('chromeImport:progress', p);
      } catch {
        // sender may have gone away
      }
    };
    // P2-47 pin (after-import call site; the boot sweep lives in main.ts).
    // runImport's own cleanup is best-effort — a Windows file lock can
    // leave the cookie snapshot behind. Once this handler settles, success
    // OR throw, the snapshot of THIS import is dead at any age, so sweep
    // with no age bound.
    let result: Awaited<ReturnType<typeof runChromeImport>>;
    try {
      result = await runChromeImport(options, send);
    } finally {
      sweepImportTempDirs({ maxAgeMs: 0 });
    }
    if (result.ok || result.cookieCount > 0) {
      try {
        const state = loadState();
        state.preferences.chromeImport = {
          lastImportedAt: Date.now(),
          profileId: options.profileId,
          cookieCount: result.cookieCount,
          skippedV11: result.skippedV11,
        };
        saveState(state);
      } catch (err) {
        console.warn('Failed to persist chromeImport summary', err);
      }
    }
    return result;
  });

  ipcMain.handle('chromeImport:summary', async () => {
    const cookieCount = await getCookieCount();
    const state = loadState();
    return {
      cookieCount,
      lastImportedAt: state.preferences.chromeImport?.lastImportedAt ?? 0,
    };
  });

  ipcMain.handle('chromeImport:clearCookies', async () => {
    await clearImportedCookies();
    try {
      const state = loadState();
      if (state.preferences.chromeImport) {
        delete state.preferences.chromeImport;
        saveState(state);
      }
    } catch (err) {
      console.warn('Failed to clear chromeImport summary', err);
    }
  });

  ipcMain.handle('app:openExternal', (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Same outcome as before — the invoke rejects — but explicit rather than
      // an escaping TypeError.
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only HTTP(S) URLs are allowed');
    }
    return shell.openExternal(url);
  });

  ipcMain.handle('git:getStatus', (_event, projectPath: string) => getGitStatus(requireGitRoot('git:getStatus', projectPath)));

  ipcMain.handle('git:getRemoteUrl', (_event, projectPath: string) => getGitRemoteUrl(requireGitRoot('git:getRemoteUrl', projectPath)));

  ipcMain.handle('git:getFiles', (_event, projectPath: string) => getGitFiles(requireGitRoot('git:getFiles', projectPath)));

  ipcMain.handle('git:getDiff', (_event, projectPath: string, filePath: string, area: string) => {
    const root = requireGitRoot('git:getDiff', projectPath);
    return getGitDiff(root, requireGitFilePath('git:getDiff', root, filePath), area);
  });

  ipcMain.handle('git:getWorktrees', (_event, projectPath: string) => getGitWorktrees(requireGitRoot('git:getWorktrees', projectPath)));

  ipcMain.handle('git:stageFile', async (_event, projectPath: string, filePath: string) => {
    const root = requireGitRoot('git:stageFile', projectPath);
    await gitStageFile(root, requireGitFilePath('git:stageFile', root, filePath));
    notifyGitChanged();
  });

  ipcMain.handle('git:unstageFile', async (_event, projectPath: string, filePath: string) => {
    const root = requireGitRoot('git:unstageFile', projectPath);
    await gitUnstageFile(root, requireGitFilePath('git:unstageFile', root, filePath));
    notifyGitChanged();
  });

  ipcMain.handle('git:discardFile', async (_event, projectPath: string, filePath: string, area: string) => {
    const root = requireGitRoot('git:discardFile', projectPath);
    await gitDiscardFile(root, requireGitFilePath('git:discardFile', root, filePath), area as GitFileEntry['area']);
    notifyGitChanged();
  });

  ipcMain.on('git:watchProject', safeOn('git:watchProject', (_event, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
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

  ipcMain.handle('git:listBranches', (_event, projectPath: string) => listGitBranches(requireGitRoot('git:listBranches', projectPath)));

  ipcMain.handle('git:checkoutBranch', async (_event, projectPath: string, branch: string) => {
    await checkoutGitBranch(requireGitRoot('git:checkoutBranch', projectPath), branch);
    notifyGitChanged();
  });

  ipcMain.handle('git:createBranch', async (_event, projectPath: string, branch: string) => {
    await createGitBranch(requireGitRoot('git:createBranch', projectPath), branch);
    notifyGitChanged();
  });

  ipcMain.handle('git:openInEditor', (_event, projectPath: string, filePath: string) => {
    const root = requireGitRoot('git:openInEditor', projectPath);
    const fullPath = path.join(root, requireGitFilePath('git:openInEditor', root, filePath));
    return shell.openPath(fullPath);
  });

  ipcMain.handle('pty:getCwd', (_event, sessionId: string) => getPtyCwd(sessionId));

  ipcMain.handle('fs:listFiles', async (_event, cwd: string, query: string) => {
    try {
      const resolvedCwd = path.resolve(cwd);
      if (!isWithinKnownProject(resolvedCwd)) {
        return [];
      }
      let files = await enumerateProjectFiles(resolvedCwd);

      if (query) {
        const lower = query.toLowerCase();
        const exact: string[] = [];
        const startsWith: string[] = [];
        const nameContains: string[] = [];
        const pathContains: string[] = [];
        for (const f of files) {
          const fileName = path.basename(f).toLowerCase();
          if (fileName === lower) exact.push(f);
          else if (fileName.startsWith(lower)) startsWith.push(f);
          else if (fileName.includes(lower)) nameContains.push(f);
          else if (f.toLowerCase().includes(lower)) pathContains.push(f);
        }
        files = [...exact, ...startsWith, ...nameContains, ...pathContains];
      }
      return files.slice(0, 50);
    } catch (err) {
      console.warn('fs:listFiles failed:', err);
      return [];
    }
  });

  ipcMain.handle('fs:topFilesByTokens', async (_event, cwd: string, limit: number): Promise<TopFilesResult> => {
    try {
      const resolvedCwd = path.resolve(cwd);
      if (!isWithinKnownProject(resolvedCwd)) {
        return { ok: false };
      }
      const clampedLimit = Math.max(1, Math.min(100, Math.floor(limit) || 10));
      const isIgnored = buildVibeyardignoreMatcher(resolvedCwd);
      const relFiles = (await enumerateProjectFiles(resolvedCwd)).filter((rel) => !isIgnored(rel));

      const results: TopFile[] = [];
      let scanned = 0;
      let skipped = 0;

      // Pooled async scan: one fd per file, fstat → sniff → read remainder using the same fd.
      // Keeps the main loop responsive for PTY traffic during multi-second scans on large repos.
      const CONCURRENCY = 16;
      let cursor = 0;

      async function processOne(rel: string): Promise<void> {
        const abs = path.join(resolvedCwd, rel);
        let handle: fs.promises.FileHandle;
        try { handle = await fs.promises.open(abs, 'r'); } catch { skipped++; return; }
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > TOKEN_COUNT_MAX_CHARS) { skipped++; return; }

          const buf = Buffer.alloc(stat.size);
          if (stat.size > 0) {
            await handle.read(buf, 0, stat.size, 0);
          }
          if (isBinaryBuffer(buf.subarray(0, Math.min(stat.size, BINARY_SNIFF_BYTES)))) {
            skipped++;
            return;
          }
          const tokens = estimateTokens(buf.toString('utf-8'));
          results.push({ path: rel, tokens, size: stat.size });
          scanned++;
        } finally {
          await handle.close().catch(() => {});
        }
      }

      const workers: Promise<void>[] = [];
      for (let i = Math.min(CONCURRENCY, relFiles.length); i > 0; i--) {
        workers.push((async () => {
          while (cursor < relFiles.length) {
            const rel = relFiles[cursor++];
            try { await processOne(rel); } catch { skipped++; }
          }
        })());
      }
      await Promise.all(workers);

      results.sort((a, b) => b.tokens - a.tokens);
      return { ok: true, files: results.slice(0, clampedLimit), scanned, skipped };
    } catch (err) {
      console.warn('fs:topFilesByTokens failed:', err);
      return { ok: false };
    }
  });

  ipcMain.handle('fs:exists', (_event, filePath: string): boolean => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) return false;
      return fs.existsSync(resolved);
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:stat', (_event, filePath: string): FileStatResult => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        return { ok: false };
      }
      const s = fs.statSync(resolved);
      return { ok: true, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('fs:readFile', (_event, filePath: string): ReadFileResult => {
    try {
      // Security: resolve to absolute and check it's within a known project directory
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readFile blocked: ${resolved} is not within an allowed path`);
        return { ok: false, reason: 'error' };
      }
      // Sniff the head before slurping the whole file so a multi-MB binary
      // (e.g. build artifacts in build/) doesn't get allocated just to be discarded.
      // One fd for both: open once, sniff 8KB, read the remainder from the same fd.
      const fd = fs.openSync(resolved, 'r');
      try {
        const head = Buffer.alloc(BINARY_SNIFF_BYTES);
        const headBytes = fs.readSync(fd, head, 0, BINARY_SNIFF_BYTES, 0);
        if (isBinaryBuffer(head.subarray(0, headBytes))) {
          return { ok: false, reason: 'binary' };
        }
        const size = fs.fstatSync(fd).size;
        if (size > MAX_READ_FILE_BYTES) return { ok: false, reason: 'error' };
        const rest = Buffer.alloc(Math.max(0, size - headBytes));
        let off = 0;
        while (off < rest.length) {
          const n = fs.readSync(fd, rest, off, rest.length - off, headBytes + off);
          if (n === 0) break; // EOF (file shrank between fstat and read)
          off += n;
        }
        return { ok: true, content: Buffer.concat([head.subarray(0, headBytes), rest.subarray(0, off)]).toString('utf-8') };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      console.warn('fs:readFile failed:', err);
      return { ok: false, reason: 'error' };
    }
  });

  const IMAGE_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

  ipcMain.handle('fs:readImage', (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readImage blocked: ${resolved} is not within an allowed path`);
        return null;
      }
      const mime = IMAGE_MIME_BY_EXT[path.extname(resolved).toLowerCase()];
      if (!mime) return null;
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_IMAGE_BYTES) {
        console.warn(`fs:readImage rejected: ${resolved} exceeds ${MAX_IMAGE_BYTES} bytes`);
        return null;
      }
      const buf = fs.readFileSync(resolved);
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
    } catch (err) {
      console.warn('fs:readImage failed:', err);
      return null;
    }
  });

  ipcMain.handle('fs:trashItem', (_event, filePath: string) =>
    withProjectPath('fs:trashItem', filePath, (resolved) => shell.trashItem(resolved)));

  ipcMain.handle('fs:showInFolder', (_event, targetPath: string) =>
    withProjectPath('fs:showInFolder', targetPath, async (resolved) => {
      // lstat, not stat: a symlink must never be followed here. isWithinKnownProject
      // is a string-prefix check on the link's own path, so opening its target would
      // walk straight out of the project (workspace node_modules links, a link into
      // ~/.claude). Revealing the link itself in its parent is always in-bounds.
      const stats = await fs.promises.lstat(resolved);
      if (stats.isDirectory() && !(isMac && isMacPackagePath(resolved))) {
        // Open the folder itself so the file manager shows its contents.
        // openPath resolves to '' on success, or a message on failure.
        return shell.openPath(resolved);
      }
      // Files, symlinks and macOS packages: reveal in the parent, selected.
      shell.showItemInFolder(resolved);
    }));

  ipcMain.on('fs:watchDir', safeOn('fs:watchDir', (event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    if (!isAllowedReadPath(resolved)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) setFileWatcherWindow(win);
    watchDir(resolved);
  }));

  ipcMain.on('fs:unwatchDir', safeOn('fs:unwatchDir', (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    // P2-30: mirror fs:watchDir's gate. Unwatch is destructive — the watcher
    // refcounts by path alone, so any frame naming a watched dir silently
    // drops the other frames' refs. A path the watch side refuses must not
    // be unwatchable.
    if (!isAllowedReadPath(resolved)) return;
    unwatchDir(resolved);
  }));

  ipcMain.handle('stats:getCache', () => {
    try {
      const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
      const raw = fs.readFileSync(statsPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  // Both run git in the renderer-named cwd (`git ls-files` for the readiness
  // scan, `git remote get-url` for the repo detect), so both take the same
  // root gate as the 13 git:* handlers: a known project or a watched worktree.
  ipcMain.handle('readiness:analyze', (_event, projectPath: string, excludedProviders?: ProviderId[]) =>
    analyzeReadiness(requireGitRoot('readiness:analyze', projectPath), excludedProviders)
  );

  ipcMain.handle('github:isAvailable', () => isGhAvailable());
  ipcMain.handle('github:detectRepo', (_event, projectPath: string) =>
    detectRepo(requireGitRoot('github:detectRepo', projectPath))
  );
  ipcMain.handle('github:listPRs', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listPullRequests(repo, { state, max })
  );
  ipcMain.handle('github:listIssues', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listIssues(repo, { state, max })
  );

  ipcMain.handle('update:checkNow', () => checkForUpdates());
  ipcMain.handle('update:install', () => quitAndInstall());

  ipcMain.handle('agentmemory:status', () => probeAgentmemory());
  ipcMain.handle('agentmemory:start', () => ensureAgentmemoryRunning());

  ipcMain.handle('settings:reinstall', (_event, providerId: ProviderId = 'claude', configDir?: string) => {
    // P2-127: configDir is the dir the warning banner was computed from —
    // "Fix Settings" must repair THAT dir, since a profiled CLI never reads
    // ~/.claude. Renderer-supplied, and this writes settings.json into it:
    // same managed-profile gate as pty:create (P1-15).
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      return { success: false, error: `Refused: ${configDir} is not a managed profile directory.` };
    }
    try {
      const provider = getProvider(providerId);
      provider.reinstallSettings(configDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
  ipcMain.handle('settings:validate', (_event, providerId: ProviderId = 'claude'): SettingsValidationResult => {
    return getProvider(providerId).validateSettings();
  });

  // P1-14: for a profile session the warning banner is the single consent
  // surface (spawn is a hot path and never shows the modal). Dismissing the
  // foreign-statusLine banner is the Keep: record declined consent for that
  // dir so the per-spawn gate honors it and the banner stops re-firing.
  // Managed-dir gate mirrors pty:create / settings:reinstall; the record is
  // inert data with no filesystem effect.
  ipcMain.on('settings:declineStatusLine', safeOn('settings:declineStatusLine', (_event, configDir: string | undefined, foreignCommand: string | null) => {
    if (configDir && !isManagedMcpConfigDir(configDir)) return;
    recordDirConsent(configDir, 'declined', foreignCommand ?? null);
  }));

  ipcMain.handle('mcp:addServer', (_event, name: string, config: McpServerConfig, scope: 'user' | 'project', projectPath?: string, configDir?: string) => {
    try {
      addMcpServer(name, config, scope, projectPath, configDir);
      return { success: true };
    } catch (err) {
      console.error('mcp:addServer failed:', err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('mcp:removeServer', (_event, name: string, filePath: string, scope: 'user' | 'project', projectPath?: string, configDir?: string) => {
    try {
      removeMcpServer(name, filePath, scope, projectPath, configDir);
      return { success: true };
    } catch (err) {
      console.error('mcp:removeServer failed:', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerMcpHandlers();
}
