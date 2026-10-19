import { ipcMain, BrowserWindow, app, dialog, shell, clipboard, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawnPty, spawnShellPty, writePty, resizePty, killPty, getPtyCwd } from './pty-manager';
import { addMcpServer, removeMcpServer } from './claude-cli';
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
import { createAppMenu } from './menu';
import { getProvider, getProviderMeta, getAllProviderMetas, getAllProviders } from './providers/registry';
import { exportSessionArchive, resolveLaunchSessionDir } from './session-export';
import { buildHandoffPrompt } from './providers/resume-handoff';
import { searchSessions } from './session-deep-search';
import type { ProviderId, GitFileEntry, SettingsValidationResult, ReadFileResult, FileStatResult, TopFilesResult, TopFile, ArchivedSession } from '../shared/types';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../shared/token-estimate';
import { analyzeReadiness } from './readiness/analyzer';
import { isGhAvailable, listPullRequests, listIssues, detectRepo } from './github-cli';
import { canonicalPath, expandUserPath, isBinaryBuffer, isMacPackagePath, BINARY_SNIFF_BYTES } from './fs-utils';
import { isLinux, isMac, isWin } from './platform';
import { listProfiles as listChromeProfiles, runImport as runChromeImport, clearImportedCookies, getCookieCount } from './chrome-import/importer';
import type { ChromeImportOptions, ChromeImportProgress, ClipboardSource, ClipboardPastePayload } from '../shared/types';
import { shouldWarnStatusLine } from './settings-guard';
import { buildVibeyardignoreMatcher } from './vibeyardignore';
import { setCloseConfirmed } from './close-state';
import { provisionProfileDir } from './profiles';
import { getKeychainIsolationStatus } from './claude-keychain';

const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Check if a resolved path is within one of the known project directories.
 */
function isWithinKnownProject(resolvedPath: string): boolean {
  const target = canonicalPath(resolvedPath);
  const paths = getKnownProjectPaths();
  return paths.some(p => isWithin(canonicalPath(p), target));
}

/**
 * git:* handlers run real git (and `rm -r` on untracked discard) in an
 * IPC-supplied cwd. Bound every git root to a known project directory or a
 * root the git panel actively watches — worktrees live outside the project
 * dir by design — so a compromised renderer cannot aim git (or the
 * recursive-delete sink) at arbitrary cwds.
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
  const canonical = canonicalPath(resolved);
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
  if (!isWithin(canonicalPath(root), canonicalPath(joined))) {
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
  return allowedPaths.some(allowed => isWithin(canonicalPath(allowed), target));
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
        (data) => {
          if (!win.isDestroyed()) {
            win.webContents.send('pty:data', sessionId, data);
          }
        },
        (exitCode, signal, pid, spawnRejectedReason) => {
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
      const statusLineIssue = shouldWarnStatusLine(
        validation.statusLine,
        prefs.statusLineConsent,
        prefs.statusLineConsentCommand,
        validation.foreignStatusLineCommand,
      );
      const hooksIssue = validation.hooks !== 'complete';
      if (statusLineIssue || hooksIssue) {
        win.webContents.send('settings:warning', {
          sessionId,
          statusLine: statusLineIssue ? validation.statusLine : 'vibeyard',
          hooks: validation.hooks,
        });
      }
    }
  });

  ipcMain.handle('pty:createShell', (_event, sessionId: string, cwd: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    spawnShellPty(
      sessionId,
      cwd,
      (data) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:data', sessionId, data);
        }
      },
      (exitCode, signal) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w && !w.isDestroyed()) {
          w.webContents.send('pty:exit', sessionId, exitCode, signal);
        }
      }
    );
  });

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    writePty(sessionId, data);
  });

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows);
  });

  ipcMain.handle('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId);
  });

  ipcMain.handle('fs:isDirectory', (_event, filePath: string) => {
    try {
      return fs.statSync(expandUserPath(filePath)).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:expandPath', (_event, filePath: string): string => {
    return expandUserPath(filePath);
  });

  ipcMain.handle('fs:listDirs', (_event, dirPath: string, prefix?: string) => {
    try {
      const expanded = expandUserPath(dirPath);
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

  ipcMain.handle('store:load', () => {
    return loadState();
  });

  ipcMain.handle('store:save', (_event, state: PersistedState) => {
    saveState(state);
  });

  // Synchronous startup channel: the renderer applies theme/zoom before its
  // first paint, before the async store:load resolves. Served from the
  // in-memory state cache, so no file read happens on this path.
  ipcMain.on('store:startup-prefs', (event) => {
    const prefs = loadState().preferences;
    event.returnValue = { theme: prefs.theme ?? null, zoomFactor: prefs.zoomFactor ?? null };
  });

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

  ipcMain.handle('clipboard:write', (_event, text: string, source?: ClipboardSource) => {
    clipboard.writeText(text);
    // On Linux a selection-driven copy also populates the X11 PRIMARY selection
    // so middle-click paste works. An explicit copy must not — it would clobber
    // whatever the user has selected in another window.
    if (source === 'selection' && isLinux) clipboard.writeText(text, 'selection');
  });

  // Every provider takes attachments as a path — a file dropped on a terminal is
  // injected as its path text. A clipboard payload with no path the CLI can read
  // (a screenshot, a copied picture, a browser image) has no path, so main
  // materialises one in the paste temp dir and the renderer injects that. Two
  // entry points: main reads the clipboard itself for the keystrokes the renderer
  // intercepts (Windows Ctrl+V, the context menu), and the renderer hands bytes
  // over for a native paste event, whose file objects main cannot see.
  const PASTE_DIR = path.join(os.tmpdir(), 'vibeyard-paste');
  const PASTE_MAX_BYTES = 25 * 1024 * 1024;
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
      await fs.promises.writeFile(filePath, buffer);
      return filePath;
    } catch (err) {
      console.warn('Failed to store pasted clipboard file', err);
      return null;
    }
  }

  // A file list on the clipboard: a browser copy (FileNameW), a macOS Finder copy
  // (NSFilenamesPboardType) or a Linux file-manager copy (text/uri-list). A file
  // copied in Explorer or Finder reaches a native paste event as a File object
  // whose real path the renderer resolves, and that route covers Windows/macOS;
  // these formats cover the reads main performs on its own — the context menu, and
  // Linux file managers, whose copies expose a URI list Chromium does not hand to
  // a paste event as files.
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

  function clipboardFilePaths(): string[] {
    const paths: string[] = [];
    try {
      // FileNameW: UTF-16LE names, NUL-separated, double-NUL terminated.
      for (const name of clipboard.readBuffer('FileNameW').toString('utf16le').split('\0')) {
        if (name) paths.push(name);
      }
    } catch (err) {
      console.warn('Failed to read clipboard file list', err);
    }
    if (paths.length === 0) {
      try {
        // CF_HDROP is a DROPFILES header followed by the name list. The header
        // is pFiles (name-list offset) @0, pt @4-11, fWide @12 — Explorer sets
        // fWide, so the names are UTF-16LE. Older senders use the OEM codepage,
        // where a single-byte decode keeps ASCII paths intact.
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
      } catch (err) {
        console.warn('Failed to read clipboard file drop list', err);
      }
    }
    if (paths.length === 0) {
      try {
        // An old-style XML property list: <array><string>/path</string>…
        const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8');
        for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
          paths.push(decodeXmlText(match[1]));
        }
      } catch (err) {
        console.warn('Failed to read clipboard file URIs', err);
      }
    }
    if (paths.length === 0) {
      for (const line of clipboard.read('text/uri-list').split(/\r?\n/)) {
        const uri = line.trim();
        if (!uri.startsWith('file://')) continue;
        try {
          paths.push(fileURLToPath(uri));
        } catch {
          // A malformed URI is not a file the CLI can read.
        }
      }
    }
    return paths.filter((filePath) => path.isAbsolute(filePath));
  }

  ipcMain.handle('clipboard:readForPaste', async (): Promise<ClipboardPastePayload> => {
    const formats = clipboard.availableFormats();
    const text = clipboard.readText();
    const files = clipboardFilePaths();
    let imagePath: string | null = null;
    if (files.length === 0 && formats.some((format) => format.toLowerCase().startsWith('image/'))) {
      try {
        // Electron normalises every image flavor (BMP, TIFF, DIB) to PNG, which
        // every provider accepts as an attachment path.
        const image = clipboard.readImage();
        if (!image.isEmpty()) imagePath = await writePastedFile(image.toPNG(), '.png');
      } catch (err) {
        console.warn('Failed to read clipboard image', err);
      }
    }
    // Rich-text copies (Word, OneNote, a browser selection) carry HTML next to
    // plain text; with no text at all, the markup source is the only readable
    // content, and a CLI reads markup happily.
    const html = text.trim() === '' ? clipboard.readHTML().trim() : '';
    return { text, html, files, imagePath, hasContent: formats.length > 0 || files.length > 0 };
  });

  ipcMain.handle('clipboard:saveImage', async (_event, dataUrl: string): Promise<string | null> => {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(typeof dataUrl === 'string' ? dataUrl : '');
    if (!match) return null;
    const ext = PASTE_IMAGE_EXT_BY_MIME[match[1].toLowerCase()];
    if (!ext) return null;
    // The base64 length bounds the decoded size before the decode itself.
    if (match[2].length > Math.ceil((PASTE_MAX_BYTES * 4) / 3)) return null;
    return writePastedFile(Buffer.from(match[2], 'base64'), ext);
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

  ipcMain.on('config:watchProject', (_event, providerId: ProviderId, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const provider = getProvider(providerId);
    provider.startConfigWatcher?.(win, projectPath);
  });

  ipcMain.handle('provider:getMeta', (_event, providerId: ProviderId) => {
    return getProviderMeta(providerId);
  });

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
  ipcMain.on('session:transcriptExistsSync', (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string, liveSessionId?: string) => {
    event.returnValue = transcriptExists(providerId, cliSessionId, projectPath, configDir, liveSessionId);
  });
  ipcMain.handle('session:exportArchive', async (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir: string | undefined, meta: ArchivedSession, format: 'zip' | 'file') => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    return exportSessionArchive(win, { providerId, cliSessionId, projectPath, configDir, meta, format });
  });

  const searches = new WeakMap<Electron.WebContents, AbortController>();
  ipcMain.on('session:cancelDeepSearch', (event) => searches.get(event.sender)?.abort());
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

  ipcMain.handle('provider:installAgent', async (_event, slug: string, content: string) => {
    const targets = getAllProviders().filter((p) => p.installAgent && p.validatePrerequisites());
    return Promise.all(targets.map(async (p) => {
      try {
        const r = await p.installAgent!(slug, content);
        return { providerId: p.meta.id, ok: true, filePath: r.filePath };
      } catch (err) {
        return { providerId: p.meta.id, ok: false, error: String((err as Error)?.message ?? err) };
      }
    }));
  });

  ipcMain.handle('provider:removeAgent', async (_event, slug: string) => {
    const targets = getAllProviders().filter((p) => p.removeAgent);
    await Promise.all(targets.map((p) => p.removeAgent!(slug).catch(() => undefined)));
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
  ipcMain.on('session:resyncStatus', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) resyncAllSessions(w);
  });

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
  ipcMain.on('session:release', (_event, sessionId: string) => {
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
  });

  ipcMain.on('app:focus', () => {
    app.focus({ steal: true });
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  ipcMain.on('app:closeConfirmed', () => {
    setCloseConfirmed(true);
    app.quit();
  });

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
    const result = await runChromeImport(options, send);
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

  ipcMain.on('git:watchProject', (_event, projectPath: string) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const resolved = path.resolve(projectPath);
    // Watch is read-only, and watched roots become git-capable roots, so
    // bound them to the fs gate (projects + CLI config dirs, nothing else).
    if (!isAllowedReadPath(resolved)) {
      console.warn(`git:watchProject blocked: ${resolved}`);
      return;
    }
    // Canonical form is the set key, and re-registering a watched root must
    // not evict the oldest entry.
    const canonical = canonicalPath(resolved);
    if (!gitWatchedRoots.has(canonical)) {
      if (gitWatchedRoots.size >= MAX_GIT_WATCHED_ROOTS) {
        const oldest = gitWatchedRoots.values().next().value;
        if (oldest !== undefined) gitWatchedRoots.delete(oldest);
      }
      gitWatchedRoots.add(canonical);
    }
    startGitWatcher(win, resolved);
  });

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

  ipcMain.on('fs:watchDir', (event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    if (!isAllowedReadPath(resolved)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) setFileWatcherWindow(win);
    watchDir(resolved);
  });

  ipcMain.on('fs:unwatchDir', (_event, dirPath: string) => {
    const resolved = path.resolve(dirPath);
    unwatchDir(resolved);
  });

  ipcMain.handle('stats:getCache', () => {
    try {
      const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
      const raw = fs.readFileSync(statsPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle('readiness:analyze', (_event, projectPath: string, excludedProviders?: ProviderId[]) => analyzeReadiness(projectPath, excludedProviders));

  ipcMain.handle('github:isAvailable', () => isGhAvailable());
  ipcMain.handle('github:detectRepo', (_event, projectPath: string) => detectRepo(projectPath));
  ipcMain.handle('github:listPRs', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listPullRequests(repo, { state, max })
  );
  ipcMain.handle('github:listIssues', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listIssues(repo, { state, max })
  );

  ipcMain.handle('update:checkNow', () => checkForUpdates());
  ipcMain.handle('update:install', () => quitAndInstall());

  ipcMain.handle('settings:reinstall', (_event, providerId: ProviderId = 'claude') => {
    try {
      const provider = getProvider(providerId);
      provider.reinstallSettings();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
  ipcMain.handle('settings:validate', (_event, providerId: ProviderId = 'claude'): SettingsValidationResult => {
    return getProvider(providerId).validateSettings();
  });

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
