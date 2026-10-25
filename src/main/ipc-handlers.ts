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
import { listImportableLegacyProjects } from './legacy-import';
import { loadState, saveState, saveStateSync, getKnownProjectPaths, invalidateStateCache, PersistedState } from './store';
import { startWatching, cleanupSessionStatus, resyncAllSessions, registerSession } from './hook-status';
import { registerTranscriptSync, unregisterTranscriptSync, getSyncedTranscriptPath } from './session-transcript-sync';
import type { SessionExitReason } from './providers/pi-compatible-transcripts';
import { getGitStatus, getGitFiles, getGitDiff, getGitWorktrees, gitStageFile, gitUnstageFile, gitDiscardFile, getGitRemoteUrl, listGitBranches, checkoutGitBranch, createGitBranch } from './git-status';
import { startGitWatcher, notifyGitChanged, onGitChanged } from './git-watcher';
import { watchDir, unwatchDir, setFileWatcherWindow } from './file-watcher';
import { registerMcpHandlers } from './mcp-ipc-handlers';
import { checkForUpdates, quitAndInstall } from './auto-updater';
import { probeAgentmemory, ensureAgentmemoryRunning, readAgentmemoryLog } from './agentmemory-manager';
import { createAppMenu } from './menu';
import { getProvider, getAllProviderMetas, getAllProviders, getAvailableProviderIdsAsync } from './providers/registry';
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
import { canonicalPath, canonicalRoot, expandUserPath, resolveUserPath, isBinaryBuffer, isMacPackagePath, BINARY_SNIFF_BYTES, invalidateCanonicalPathIfRootsChanged } from './fs-utils';
import { isLinux, isMac, isWin } from './platform';
import { listProfiles as listChromeProfiles, runImport as runChromeImport, clearImportedCookies, getCookieCount } from './chrome-import/importer';
import { sweepImportTempDirs } from './chrome-import/copy';
import { dirSizeBytes } from './launch-session-dir';
import { getLegacyRetirementStatus } from './userdata-migration';
import type { ChromeImportOptions, ChromeImportProgress, ClipboardSource, ClipboardPastePayload } from '../shared/types';
import { shouldWarnStatusLine, getDirConsent, recordDirConsent } from './settings-guard';
import { buildFineVibeIgnoreMatcher } from './finevibeignore';
import { setCloseConfirmed } from './close-state';
import { provisionProfileDir } from './profiles';
import { getKeychainIsolationStatus } from './claude-keychain';
import { getLastDiskHealth } from './disk-health';
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
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
/** Map an exit + transcript crash reason to the renderer's exitReason
 *  (crash reason wins over the exit code; undefined = clean exit). */
function describePtyExit(
  reason: SessionExitReason | null,
  exitCode: number,
  signal: number | undefined,
): string | undefined {
  if (reason && reason.kind !== 'normal' && reason.reason !== 'dispose') return reason.reason;
  if (exitCode !== 0) return `exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`;
  if (signal) return `exited with signal ${signal}`;
  return undefined;
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
 * not app data and needs the explicit confirm below (fs:listDirs,
 * fs:isDirectory) before anything is answered about it.
 */
function isWithinHomeTree(resolvedPath: string): boolean {
  return isWithin(canonicalRoot(os.homedir()), canonicalPath(resolvedPath));
}

/** True when `resolvedPath` sits inside the preferences' default projects
 * folder. A blank/absent value NEVER matches: `path.resolve('')` is the cwd,
 * so an unset folder would silently admit every cwd subtree into the gate. */
function isWithinDefaultProjectsFolder(resolvedPath: string): boolean {
  const configured = loadState().preferences?.defaultProjectsFolder;
  if (typeof configured !== 'string' || !configured.trim()) return false;
  return isWithin(canonicalRoot(configured), canonicalPath(resolvedPath));
}

function isAllowedEnumeratePath(resolvedPath: string): boolean {
  // The preferences' default projects folder joins the enumerate tier: the
  // New Project flow composes `<defaultProjectsFolder>/<name>` and probes it
  // with fs:isDirectory BEFORE the project exists, so a non-home folder (the
  // Windows `E:\dev` norm) has to answer honestly — under the old gate the
  // probe opened a confirm whose Cancel was reported as "Directory does not
  // exist". It is deliberately NOT added to isAllowedReadPath: a folder the
  // user named for new projects authorizes stat/enumerate of what the modal
  // composes there, not reading arbitrary files inside it.
  return isAllowedReadPath(resolvedPath)
    || isWithinHomeTree(resolvedPath)
    || isWithinDefaultProjectsFolder(resolvedPath);
}

/** Confirm flow for home-outside enumeration, mirroring confirmRemoteHost in
 * mcp-ipc-handlers: Cancel is the default and the deny answer.
 * SEC-05: `canonicalDir` is the CANONICAL path, never the renderer's
 * spelling - the enumeration walks the canonical target, so the dialog must
 * name the real directory, not a friendly link that points somewhere else. */
async function confirmHomeOutsideListing(canonicalDir: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Browse outside home?',
    message: `List directories in ${canonicalDir}?`,
    detail: 'This location is outside your home directory and known projects. Only continue for directories you trust.',
    buttons: ['Cancel', 'Confirm'],
    defaultId: 0,
    cancelId: 0,
  };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

// S4-04: the sidebar's Add-Project path input fires fs:listDirs per
// keystroke; a home-outside root like C:\dev\repos\app popped one native
// dialog per typed prefix (C:\, C:\dev\, ...). The answer is cached per
// canonical directory for the session: enumeration asks at most once per
// dir, and a Cancel keeps denying every repeat on that dir.
// B1: FIFO bound mirroring settings-guard.ts' MAX_CONSENT_DIR_RECORDS
// (C3M-05): a long-lived session browsing many home-outside prefixes must
// not grow the answer cache without limit. Oldest answer evicted first; a
// re-prompt after eviction is the safe direction (consent, not access).
export const OUTSIDE_HOME_CONSENT_MAX = 200;
const outsideHomeConsent = new Map<string, boolean>();
// C2M-10 + CI-09: the answer cache only closes the SEQUENTIAL repeat. The
// keystroke burst fires concurrent fs:listDirs for one dir while the first
// dialog is still open (the debounce's trailing timer runs during typing),
// and every concurrent caller stacked its own native modal on top. Sharing
// the in-flight confirmation is one dialog per dir, answered by all waiters.
const outsideHomeConsentInFlight = new Map<string, Promise<boolean>>();

/** Records a consent answer for the canonical spelling of `dir`, applying
 * the B1 FIFO trim. `confirmHomeOutsideListingOnce` feeds this the dialog
 * answer (both ways); `fs:browseDirectory` feeds it a native-picker pick,
 * whose selection IS the consent — the follow-up label probes for the
 * picked dir then answer from the cache with zero dialogs. */
function rememberHomeOutsideConsent(dir: string, answer: boolean): void {
  outsideHomeConsent.set(canonicalPath(dir), answer);
  while (outsideHomeConsent.size > OUTSIDE_HOME_CONSENT_MAX) {
    const oldest = outsideHomeConsent.keys().next().value;
    if (oldest === undefined) break;
    outsideHomeConsent.delete(oldest);
  }
}

/** Parent-consent cascade for the fs:isDirectory existence gate ONLY.
 * A `true` answer for a dir authorized the enumeration (fs:listDirs) that
 * NAMED its children — the New Project autocomplete lists children of
 * exactly that consented dir, and the keystroke burst consents the parent
 * before any child probe fires. Answering "is this listed child a
 * directory" therefore asks nothing the parent consent did not already
 * publish, so the child skips its own dialog. A `false` (Cancel) never
 * cascades — an explicit denial must not auto-answer anything. This does
 * NOT apply to fs:listDirs: enumerating a child's CONTENTS was never
 * authorized by the parent's consent, so every dir keeps its own confirm.
 * Canonical-spelling mismatches (symlinked parent) miss the cascade and
 * fall through to the confirm — the safe direction. */
function hasHomeOutsideConsent(dir: string): boolean {
  return outsideHomeConsent.get(canonicalPath(dir)) === true;
}

async function confirmHomeOutsideListingOnce(dir: string): Promise<boolean> {
  const key = canonicalPath(dir);
  const cached = outsideHomeConsent.get(key);
  if (cached !== undefined) return cached;
  const pending = outsideHomeConsentInFlight.get(key);
  if (pending) return pending;
  // SEC-05: the dialog is shown for the canonical key - the path the
  // enumeration will actually walk.
  const run = confirmHomeOutsideListing(key).finally(() => { outsideHomeConsentInFlight.delete(key); });
  outsideHomeConsentInFlight.set(key, run);
  const answer = await run;
  rememberHomeOutsideConsent(key, answer);
  return answer;
}

/** @internal Test-only: drop cached home-outside consent answers. */
export function _resetHomeOutsideConsentForTesting(): void {
  outsideHomeConsent.clear();
  outsideHomeConsentInFlight.clear();
}

/** C2M-08: both enumeration branches cap identically. The git branch used to
 * return the WHOLE `git ls-files` output (a monorepo is routinely 100k+
 * entries - payload and every downstream filter paid for it) while the
 * non-git fallback walk stopped at 5000. */
const MAX_PROJECT_FILES = 5000;

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
      // core.quotePath=false is load-bearing, exactly as in readiness/utils.ts:
      // git octal-escapes any non-ASCII path by default ("caf\\303\\251.ts"),
      // and Quick Open then shows the C-quoted spelling and matches nothing on
      // the name the user types (nor on what the file tree offers).
      ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: resolvedCwd, encoding: 'utf-8', timeout: 5000 },
    );
    // C2M-08: same cap as the fallback walk; git's own order is kept.
    return stdout.split('\n').filter(Boolean).slice(0, MAX_PROJECT_FILES);
  } catch {
    return walkProjectFiles(resolvedCwd);
  }
}

/**
 * The enumeration contract is '/'-separated, project-relative paths — that is
 * what `git ls-files` prints on every OS, and every consumer matches on it:
 * `.finevibeignore` directory patterns (`build/`), Quick Open's path filters,
 * the readiness checkers. `path.relative` yields the NATIVE spelling, so the
 * fallback walk converts at the single point where a path leaves the walk: on
 * Windows `build\out.js` matched no directory pattern, so an excluded tree was
 * scanned anyway.
 */
function toPosixRel(rel: string): string {
  return path.sep === '/' ? rel : rel.split(path.sep).join('/');
}

/**
 * Non-git fallback (PA-07): async walk — the old readdirSync sweep blocked
 * main for ~100 ms per Quick Open query on large trees. Same shape as the
 * old sync walk: DFS in readdir order, depth/count caps, dotfiles and
 * build dirs ignored.
 */
async function walkProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
  const MAX_DEPTH = 5;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_PROJECT_FILES) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_PROJECT_FILES) return;
      if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = path.relative(root, path.join(dir, entry.name));
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth + 1);
      } else {
        files.push(toPosixRel(rel));
      }
    }
  }
  await walk(root, 0);
  return files;
}

// PA-07: the enumeration is query-independent, yet Quick Open re-ran the
// whole thing (a fresh `git ls-files` spawn) on every debounced keystroke.
// Cache per cwd; invalidate on the same git:changed signal the renderer
// gets, and cap staleness with a TTL for non-git trees the watcher never
// covers. In-flight enumerations are shared, so a keystroke burst pays for
// at most one.
const enumerateCache = new Map<string, { at: number; files: string[] }>();
const enumerateInFlight = new Map<string, Promise<string[]>>();
// B1: LRU bound on the per-cwd enumeration caches. Map insertion order
// doubles as recency: every read hit re-inserts its entry, so evicting the
// first key past the cap drops the least recently used cwd
// (canonical inline idiom, fs-utils.ts:63-79).
export const ENUMERATE_CACHE_MAX = 64;
const ENUMERATE_TTL_MS = 30_000;
// Clearing the cache does not reach an enumeration already walking the tree,
// so a plain `enumerateCache.clear()` on git:changed left two holes: new
// callers were still handed the superseded in-flight walk, and that walk's late
// result repopulated the cache — the invalidation was silently undone and the
// pre-change listing was served for a whole TTL (Quick Open blind to files git
// just added, for 30 s). One generation counter closes both: a run captures the
// generation it started in and a superseded run neither publishes to the cache
// nor owns the in-flight slot any more.
let enumerateGeneration = 0;

function invalidateEnumerations(): void {
  enumerateGeneration++;
  enumerateCache.clear();
  enumerateInFlight.clear();
  // C2M-03: the top-files result is derived from the listing, so a
  // working-tree change invalidates the token scan's cache with it.
  topFilesCache.clear();
}

/** B1: drop every TTL-expired entry from the two persistent enumeration
 * caches (the in-flight maps are transient — a settled walk always clears
 * its own slot). `invalidateEnumerations` is the force-clear on git:changed;
 * this is the idle sweep that keeps a session reading only a few cwds from
 * holding TTL-dead listings (and their file arrays) forever. */
export function sweepEnumerationCaches(): void {
  const now = Date.now();
  for (const [cwd, entry] of enumerateCache) {
    if (now - entry.at >= ENUMERATE_TTL_MS) enumerateCache.delete(cwd);
  }
  for (const [cwd, entry] of topFilesCache) {
    if (now - entry.at >= TOP_FILES_TTL_MS) topFilesCache.delete(cwd);
  }
}

async function getCachedProjectFiles(resolvedCwd: string): Promise<string[]> {
  const hit = enumerateCache.get(resolvedCwd);
  if (hit && Date.now() - hit.at < ENUMERATE_TTL_MS) {
    enumerateCache.delete(resolvedCwd);
    enumerateCache.set(resolvedCwd, hit);
    return hit.files;
  }
  const pending = enumerateInFlight.get(resolvedCwd);
  if (pending) return pending;
  const gen = enumerateGeneration;
  const run = async (): Promise<string[]> => {
    try {
      const files = await enumerateProjectFiles(resolvedCwd);
      if (gen === enumerateGeneration) {
        enumerateCache.set(resolvedCwd, { at: Date.now(), files });
        if (enumerateCache.size > ENUMERATE_CACHE_MAX) {
          const oldest = enumerateCache.keys().next().value;
          if (oldest !== undefined) enumerateCache.delete(oldest);
        }
      }
      return files;
    } finally {
      // Only the run that still owns the slot clears it; an invalidation may
      // have handed this cwd to a newer enumeration already.
      if (enumerateInFlight.get(resolvedCwd) === work) enumerateInFlight.delete(resolvedCwd);
    }
  };
  const work = run();
  enumerateInFlight.set(resolvedCwd, work);
  return work;
}

// UI3-11: top-files scans are whole-repo file reads. Every top-files widget
// mount/refresh (tab switches, dashboard opens) used to start its own scan,
// stacking concurrent full reads of the same repo. Concurrent scans of one
// cwd now share a single walk; the shared result is fully sorted, callers
// slice to their own limit.
const topFilesScans = new Map<string, Promise<{ files: TopFile[]; scanned: number; skipped: number }>>();

// C2M-03: the settled scan, cached per cwd with the enumeration TTL: the
// shared walk deduped only CONCURRENT mounts, so a polling widget re-walked
// the tree on every mount after the first. CI-08: a walk superseded by
// invalidateEnumerations() never publishes here (see scanTopFiles).
const topFilesCache = new Map<string, { at: number; files: TopFile[]; scanned: number; skipped: number }>();
// B1: same LRU bound as the enumeration cache it derives from.
export const TOP_FILES_CACHE_MAX = 64;
const TOP_FILES_TTL_MS = ENUMERATE_TTL_MS;

// C2M-05: the head sample a token estimate is computed from. Mirrors the
// per-file read budget docs/performance.md gives the other scan paths: the
// 10 MiB size gate never bounded the ALLOCATION, so a large repo's scan read
// (and allocated) every file in full, 16-way concurrent.
const TOKEN_SCAN_READ_BYTES = 1024 * 1024;

// The debounced working-tree/branch-change signal from git-watcher is
// subscribed in registerIpcHandlers (tests re-register and capture it).

/** @internal Test-only: drop every cached/in-flight enumeration. */
export function _resetEnumerateCacheForTesting(): void {
  invalidateEnumerations();
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
//  - Remove only unlinks files FineVibe wrote: installs stamp a marker
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
  return `# installed-by: finevibe ${slug}`;
}

/** Idempotently stamp the ownership marker into the file's frontmatter. */
function stampAgentMarker(slug: string, content: string): string {
  const marker = agentMarkerLine(slug);
  if (content.includes(marker)) return content;
  const fence = /^---[ \t]*\r?\n/.exec(content);
  if (fence) return `${fence[0]}${marker}\n${content.slice(fence[0].length)}`;
  return `---\n${marker}\n---\n${content}`;
}

/** True when the leading frontmatter block carries the FineVibe marker. */
function hasAgentMarker(content: string): boolean {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content);
  return fm !== null && /^#[ \t]*installed-by:[ \t]*finevibe\b/m.test(fm[1]);
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
 * carrying the FineVibe marker (P2-117). Unmarked same-slug files are
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
        // User-authored (or foreign-managed): FineVibe never wrote this
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

// ---- A5: in-app storage report (storage:scan / storage:clear) -----------

/** Bounded-walk caps for `storage:scan`. The scan reports userData subtrees
 *  for a human-facing MB report; a userData tree with more than these many
 *  entries is abnormal enough that a complete census is not worth blocking
 *  the call — the result carries `truncated: true` instead. */
const STORAGE_SCAN_MAX_ENTRIES = 50_000;
/** Children enumerated per directory before the scan marks itself truncated
 *  (the shared dirSizeBytes idiom then bounds the recursion depth at 4). */
const STORAGE_SCAN_MAX_CHILDREN = 1_000;

export interface StorageSubtreeUsage {
  name: string;
  bytes: number;
}

/** One shared visit budget + truncated flag threaded through a scan. */
interface ScanBudget {
  entries: number;
  truncated: boolean;
}

/**
 * Size one directory with the caps applied: the top level is enumerated
 * here (child count capped), every sub-directory is then sized with the
 * shared `dirSizeBytes` idiom from launch-session-dir.ts — depth-bounded,
 * symlink-ignoring, swallow-per-entry. Never throws; a missing dir is 0.
 * `skip` names (top level only) let the "misc" bucket exclude subtrees the
 * scan already counted under their own names.
 */
function subtreeBytesBounded(
  dir: string,
  budget: ScanBudget,
  skip?: Set<string>,
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  if (skip) names = names.filter((n) => !skip.has(n));
  if (names.length > STORAGE_SCAN_MAX_CHILDREN || budget.entries <= 0) {
    budget.truncated = true;
    names = names.slice(0, Math.max(0, STORAGE_SCAN_MAX_CHILDREN));
  }
  let bytes = 0;
  for (const name of names) {
    if (budget.entries <= 0) {
      budget.truncated = true;
      break;
    }
    budget.entries -= 1;
    const child = path.join(dir, name);
    try {
      const st = fs.lstatSync(child);
      if (st.isFile()) bytes += st.size;
      else if (st.isDirectory()) bytes += dirSizeBytes(child, 1);
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return bytes;
}

/** The named userData subtrees the report breaks out; everything else is
 *  bucketed as "misc" (userData's own top level minus these + the scan's
 *  per-directory caps apply everywhere). */
const STORAGE_SUBTREES = ['pi-sessions', 'omp-sessions', 'pi-bolt-sessions', 'Partitions', 'Cache'] as const;

/**
 * Size the userData subtrees the storage report shows, descending by bytes.
 * Synchronous and bounded: the caps above bound entries visited; depth is
 * bounded by dirSizeBytes; every fs error degrades that entry to 0.
 * Exported for storage-section.test.ts (fixture-driven scan tests).
 */
export function scanUserDataUsage(userDataDir: string): {
  entries: StorageSubtreeUsage[];
  truncated: boolean;
} {
  const budget: ScanBudget = { entries: STORAGE_SCAN_MAX_ENTRIES, truncated: false };
  const entries: StorageSubtreeUsage[] = STORAGE_SUBTREES.map((name) => ({
    name,
    bytes: subtreeBytesBounded(path.join(userDataDir, name), budget),
  }));
  entries.push({
    name: 'misc',
    bytes: subtreeBytesBounded(userDataDir, budget, new Set<string>(STORAGE_SUBTREES)),
  });
  entries.sort((a, b) => b.bytes - a.bytes);
  return { entries, truncated: budget.truncated };
}

/** Session-id format guard, identical to the session:release partition
 *  lookup below — an iso dir is only ever `finevibe-browser-iso-<that id>`. */
const ISO_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_PARTITION_PREFIX = 'finevibe-browser-iso-';

/**
 * Remove per-session isolated browser partition dirs under
 * `userData/Partitions` (pane.ts: `persist:finevibe-browser-iso-<id>`).
 * With `sessionId`, only that session's dir; without it, every dir whose
 * suffix re-validates against the same guard — the boot sweep in main.ts
 * (per-session ephemera left by a quit/crash between release hooks).
 * Names that cannot be produced by the renderer's partition spelling are
 * left alone. Never throws; a locked dir (Windows EBUSY) survives to the
 * next sweep. Returns the number of dirs removed.
 */
export function removeIsoPartitionDirs(userDataDir: string, sessionId?: string): number {
  const partitionsRoot = path.join(userDataDir, 'Partitions');
  let names: string[];
  try {
    names = fs.readdirSync(partitionsRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(ISO_PARTITION_PREFIX)) continue;
    const id = name.slice(ISO_PARTITION_PREFIX.length);
    if (!ISO_SESSION_ID_RE.test(id)) continue;
    if (sessionId !== undefined && id !== sessionId) continue;
    try {
      fs.rmSync(path.join(partitionsRoot, name), { recursive: true, force: true });
      removed++;
    } catch {
      // Locked by Chromium until the partition object dies — next sweep retries.
    }
  }
  return removed;
}

/**
 * Clear ONLY the safe caches. Path allowlist — the entire set of things
 * this function can delete:
 *   userData/Cache, userData/GPUCache, userData/Code Cache,
 *   userData/DawnGraphiteCache, userData/DawnWebGPUCache (Chromium's
 *   clearCache() file set — no fs call below touches userData), plus
 *   OS-temp finevibe-chrome-import-* dirs (sweepImportTempDirs' own
 *   prefix+age gate, tmpdir-scoped).
 * NEVER in scope: userData/omp-sessions, userData/pi-sessions, userData/pi-bolt-sessions,
 * userData/Partitions (isolated browser logins), the default session's
 * cookies/Local Storage (the imported Chrome jar — P2-100 in main.ts
 * deliberately keeps it non-clearable from the renderer). That is why the
 * clearStorageData() call below passes an explicit cache-only `storages`
 * list: unscoped, it wipes cookies/Local Storage/IndexedDB, which are NOT
 * caches. Pinned by storage-section.test.ts (allowlist assertions).
 */
export async function clearSafeCaches(
  target: {
    clearCache(): Promise<void>;
    clearStorageData(options?: { storages?: string[] }): Promise<void>;
  } = session.defaultSession,
): Promise<{ tempDirsSwept: number }> {
  await target.clearCache();
  await target.clearStorageData({ storages: ['appcache', 'shadercache', 'serviceworkers', 'cachestorage'] });
  // maxAgeMs: 0 mirrors the chromeImport:run finally-site sweep — a user
  // pressing "Clear caches" wants the temp snapshots gone now, and no
  // import is running while this dialog-driven clear is the front action.
  const tempDirsSwept = sweepImportTempDirs({ maxAgeMs: 0 });
  return { tempDirsSwept };
}

export function registerIpcHandlers(): void {
  // PA-07: invalidate the Quick Open enumeration cache on the same debounced
  // git:changed signal the renderer receives.
  onGitChanged(invalidateEnumerations);
  ipcMain.handle('pty:create', async (_event, sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs: string, providerId: ProviderId = 'claude', initialPrompt?: string, systemPrompt?: string, envVars: string = '', configDir?: string, sshHost?: string) => {
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
      win.webContents.send('pty:data', sessionId, `\r\n\x1b[31m${message}\x1b[0m\r\n`);
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
    if (cliSessionId) {
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
    } else {
      provider.onSessionStarted?.(sessionId, cwd, win, configDir);
    }

    const launchStartedAt = Date.now();
    // C2M-04: the sink is created here - its `flush` is bound to the outbox
    // THIS launch registered, so an old process's exit callback can't tear
    // down the outbox a re-spawn under the same sessionId just installed.
    const dataSink = ptyDataSink(() => win, sessionId);
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
        dataSink,
        (exitCode, signal, pid, spawnRejectedReason) => {
          dataSink.flush();
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
          // S2-03: the transcript path is consumed ONLY by
          // readSessionExitReason below (and the omp log line). Providers
          // without it paid the path resolution on every exit for a
          // discarded value — for codex that is a fully synchronous 4-level
          // readdir+sort walk of ~/.codex/sessions (every year/month/day
          // dir, no date pruning), growing with the user's whole codex
          // history; gemini reads .project_root of every ~/.gemini/tmp key
          // dir. Gate the whole resolution on the consumer.
          let reason: SessionExitReason | null = null;
          let transcriptPath: string | null = null;
          if (provider.readSessionExitReason) {
            transcriptPath = getSyncedTranscriptPath(sessionId);
            if (!transcriptPath && cliSessionId) {
              try {
                transcriptPath = provider.getTranscriptPath?.(cliSessionId, cwd, configDir, resolveLaunchSessionDir(providerId, sessionId)) ?? null;
              } catch {
                transcriptPath = null;
              }
            }
            if (transcriptPath) {
              try {
                reason = provider.readSessionExitReason(transcriptPath);
              } catch {
                reason = null;
              }
            }
          }
          if (reason?.timestamp) {
            const markerTime = Date.parse(reason.timestamp);
            if (!Number.isFinite(markerTime) || markerTime < launchStartedAt) reason = null;
          }
          const exitReason = describePtyExit(reason, exitCode, signal);
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
        configDir,
        sshHost
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
          // SA-P1-2: the banner belongs to THIS provider — the Fix Settings
          // CTA must repair its settings, not Claude's default.
          providerId: provider.meta.id,
          statusLine: statusLineIssue ? validation.statusLine : 'finevibe',
          hooks: validation.hooks,
          // P2-127: the banner was computed from THIS dir (the profiled
          // session's tree) — carry it so the Fix Settings CTA repairs it,
          // not the default ~/.claude the session never reads.
          configDir,
          // P2-55/P2-86: the validation was computed against THIS project
          // (Copilot hooks are per-project) — the Fix Settings CTA must
          // repair and re-validate this project, not the user scope.
          projectPath: cwd,
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
    const dataSink = ptyDataSink(() => BrowserWindow.getAllWindows()[0], sessionId);
    spawnShellPty(
      sessionId,
      cwd,
      dataSink,
      (exitCode, signal) => {
        dataSink.flush();
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

  /** The coalescing sink: callable as node-pty's data callback, with the
   *  exit-time flush bound to the outbox THIS sink registered (C2M-04). */
  type PtyDataSink = ((data: string) => void) & { flush(): void };

  function ptyDataSink(getWindow: () => BrowserWindow | undefined, sessionId: string): PtyDataSink {
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
    const sink = ((data: string) => {
      outbox.parts.push(data);
      outbox.bytes += data.length;
      if (outbox.bytes >= PTY_COALESCE_MAX_BYTES) {
        outbox.flush();
        return;
      }
      if (outbox.timer === null) outbox.timer = setTimeout(() => outbox.flush(), PTY_COALESCE_WINDOW_MS);
    }) as PtyDataSink;
    // C2M-04: the flush belongs to the SINK, not to the session id. A
    // re-spawn under the same sessionId installs a new outbox, and the OLD
    // process's exit callback used to delete it - the re-spawned pane lost
    // its coalescer and its exit flush. Only the outbox's owner flushes.
    sink.flush = () => {
      if (ptyOutboxes.get(sessionId) !== outbox) return;
      ptyOutboxes.delete(sessionId);
      outbox.flush();
    };
    return sink;
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

  ipcMain.handle('fs:isDirectory', async (_event, filePath: string) => {
    try {
      // resolveUserPath: the renderer spells this path with `/` joins on
      // Windows (`E:\AI/Brillance`), and a mixed spelling must never reach
      // statSync, the gate, or the persisted project path.
      const expanded = resolveUserPath(filePath);
      // P2-38: this is fs:exists' existence oracle with a second spelling
      // (the sidebar's pre-project add flow), so it takes the widened home
      // gate. Home + known roots are answered honestly and never prompt;
      // outside them the channel asks the same explicit per-directory
      // confirm fs:listDirs / fs:cloneRepo use (consent cached by
      // confirmHomeOutsideListingOnce) and Cancel keeps the old deny shape.
      // The old silent false ignored the Windows reality that projects on
      // non-home drives (E:\...) are the norm: adding an existing dir like
      // E:\Ai\Brilliance reported "Directory does not exist".
      // Cascade: the parent's consent (or the native picker's selection of
      // it) named this child via enumeration — answer from it, no dialog.
      if (!isAllowedEnumeratePath(expanded)
        && !hasHomeOutsideConsent(path.dirname(expanded))
        && !(await confirmHomeOutsideListingOnce(expanded))) return false;
      return fs.statSync(expanded).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:expandPath', (_event, filePath: string): string => {
    return resolveUserPath(filePath);
  });

  // The New Project modal's "Create" verb: the renderer composes
  // `<folder>/<name>` and main makes the directory it just promised, then
  // answers with ITS resolved spelling — the renderer must persist that, not
  // its own `/`-joined string. A pre-project WRITE, so it takes fs:cloneRepo's
  // gate shape (home tree / known roots / the default projects folder pass, a
  // home-outside target needs the same explicit confirm) plus fs:isDirectory's
  // parent-consent cascade: the autocomplete that named this dir already
  // consented its parent. A DENIED consent is reported as an error, never as
  // non-existence — the modal has to tell "you declined" apart from "the
  // folder is not there", which is exactly what the old fs:isDirectory false
  // conflated.
  ipcMain.handle('fs:ensureDirectory', async (_event, dirPath: string) => {
    try {
      if (typeof dirPath !== 'string' || !dirPath.trim()) {
        return { ok: false, error: 'No directory path was given' };
      }
      const target = resolveUserPath(dirPath);
      if (!isAllowedEnumeratePath(target)
        && !hasHomeOutsideConsent(path.dirname(target))
        && !(await confirmHomeOutsideListingOnce(target))) {
        console.warn(`fs:ensureDirectory blocked: ${target} is outside home and not confirmed`);
        return { ok: false, error: 'Location is outside your home directory and was not confirmed' };
      }
      try {
        const stat = await fs.promises.stat(target);
        if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${target}` };
        return { ok: true, path: canonicalPath(target) };
      } catch (err) {
        const statErr = err as NodeJS.ErrnoException;
        if (statErr.code !== 'ENOENT') {
          return { ok: false, error: `${statErr.code}: ${statErr.message}` };
        }
      }
      try {
        await fs.promises.mkdir(target, { recursive: true });
      } catch (err) {
        const mkErr = err as NodeJS.ErrnoException;
        if (mkErr.code !== 'EEXIST') {
          console.warn('fs:ensureDirectory failed:', mkErr);
          return { ok: false, error: `${mkErr.code}: ${mkErr.message}` };
        }
        // Race: the directory appeared between the stat and the mkdir (a
        // concurrent New Project, an editor's autosave). Re-stat and answer
        // as if it had been there from the start.
        try {
          const stat = await fs.promises.stat(target);
          if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${target}` };
          return { ok: true, path: canonicalPath(target) };
        } catch {
          return { ok: false, error: `${mkErr.code}: ${mkErr.message}` };
        }
      }
      // Answered AFTER the mkdir: the canonical form of a path that did not
      // exist a moment ago is now fully resolvable, so this is the spelling
      // the user's own file explorer shows.
      return { ok: true, path: canonicalPath(target) };
    } catch (err) {
      console.warn('fs:ensureDirectory failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('fs:listDirs', async (_event, dirPath: string, prefix?: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      // P1-19: fs:listDir's gate widened with the home tree — the
      // pre-project picker starts in home. Enumeration outside home +
      // known roots exists only for the directory picker, so it needs the
      // explicit confirm an MCP remote-host connect gets; Cancel = empty.
      // S4-04: the confirm answer is cached per directory — the sidebar
      // fires this channel per keystroke, and every home-outside prefix
      // used to pop its own native dialog.
      if (!isAllowedEnumeratePath(expanded) && !(await confirmHomeOutsideListingOnce(expanded))) return [];
      // S4-04: async body (mirrors fs:listDir's PA-24 fix) — readdirSync
      // plus a localeCompare sort over every joined path blocked main on
      // each keystroke. Names are filtered to the prefix, sorted, sliced
      // to 20, and only the slice is joined; the payload stays the same
      // sorted string[] of full paths the sidebar renders.
      const entries = await fs.promises.readdir(expanded, { withFileTypes: true });
      const lowerPrefix = prefix?.toLowerCase();
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && (!lowerPrefix || e.name.toLowerCase().startsWith(lowerPrefix)))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 20)
        .map(name => path.join(expanded, name));
    } catch {
      return [];
    }
  });

  ipcMain.handle('fs:listDir', async (_event, dirPath: string) => {
    try {
      const expanded = expandUserPath(dirPath);
      if (!isAllowedReadPath(expanded)) return [];
      // PA-24: async body — ipcMain.handle, so the renderer API is unchanged;
      // the old readdirSync blocked main on every file-tree expand.
      const entries = await fs.promises.readdir(expanded, { withFileTypes: true });
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
      const dest = resolveUserPath(destPath);
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


  // Disk-health preflight (src/main/disk-health.ts): the renderer fetches
  // the last emitted status on mount; main.ts pushes transitions on
  // 'disk-health:status'. Transition-only emissions keep a full disk at one
  // banner, not a per-write stream.
  ipcMain.handle('disk-health:get', () => getLastDiskHealth());

  // A5: in-app storage report. `storage:scan` sizes the userData subtrees
  // (bounded walk, truncated flag on caps); `storage:clear` is the ONLY
  // renderer-reachable deletion sink in userData-adjacent space and is
  // allowlist-bound to Chromium caches + import temp dirs (see
  // clearSafeCaches — sessions/Partitions are never deleted, pinned by
  // storage-section.test.ts); `storage:retirement` is a read-only
  // passthrough of the A3 audit log. Renderer passes no paths anywhere:
  // userDataDir is main-side app.getPath, so no path input to validate.
  ipcMain.handle('storage:scan', () => scanUserDataUsage(app.getPath('userData')));
  ipcMain.handle('storage:clear', () => clearSafeCaches());
  ipcMain.handle('storage:retirement', () => getLegacyRetirementStatus(app.getPath('userData')));
  ipcMain.handle('store:save', (_event, state: PersistedState) => {
    // B2: the store's gate-root canonical memo is fs-derived state keyed on
    // the same root set these canonical caches cover — a project add/remove
    // or configDir change must drop it in production, not only in tests.
    // The drop is cache hygiene, never a verifier: it runs best-effort so a
    // failing hook can never stop the payload from reaching the store's own
    // validation in saveState (the P1-12 wiring contract).
    try {
      if (invalidateCanonicalPathIfRootsChanged(state)) invalidateStateCache();
    } catch (err) {
      console.warn('store:save root-cache hook failed:', err);
    }
    saveState(state);
  });

  // S1-03: synchronous quit flush. The renderer's beforeunload needs the
  // write on disk before the window tears down; store:save's async write can
  // lose that race. Same verifier as store:save (a payload inventing a root
  // must not widen the gate), then the fully synchronous store write.
  // SEC-02: an `on` body - a payload the verifier/writer rejects (poisoned
  // state, full disk) must not escape as a fatal main-process exception
  // (P2-108). It is a sendSync, so the throw answers `false`: the renderer's
  // best-effort quit flush reports the miss instead of dying with it.
  ipcMain.on('store:save-sync', safeOn('store:save-sync', (event, state: PersistedState) => {
    // B2: same gate-root memo drop as store:save (see the note there) —
    // best-effort for the same reason; saveStateSync must always run.
    try {
      if (invalidateCanonicalPathIfRootsChanged(state)) invalidateStateCache();
    } catch (err) {
      console.warn('store:save-sync root-cache hook failed:', err);
    }
    saveStateSync(state);
    event.returnValue = true;
  }, () => false));

  // Synchronous startup channel: the renderer applies theme/zoom before its
  // first paint, before the async store:load resolves. Served from the
  // in-memory state cache, so no file read happens on this path.
  ipcMain.on('store:startup-prefs', safeOn('store:startup-prefs', (event) => {
    const prefs = loadState().preferences;
    event.returnValue = { theme: prefs.theme ?? null, zoomFactor: prefs.zoomFactor ?? null };
  }, () => ({ theme: null, zoomFactor: null })));

  // List projects from the legacy `~/.vibeyard/state.json` that can be
  // imported into the board. The one-time file migration is destination-
  // wins, so the legacy project list never merged into a live state.json
  // written under the new name. Read-only: the renderer adds the user's
  // picks through its own state -> persist path.
  ipcMain.handle('vibeyard:listImportableProjects', () => {
    return listImportableLegacyProjects({ homedir: os.homedir(), existingPaths: getKnownProjectPaths() });
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
  /**
   * The paste temp dir. POSIX suffixes the uid, mirroring hook-status's
   * `getStatusDir`: os.tmpdir() is /tmp — world-writable and shared by every
   * user, so a fixed name under mode 0700 is claimed by whoever creates it
   * first and every other user's mkdir then fails EACCES. One local
   * `mkdir /tmp/finevibe-paste` therefore switches off pasted images for every
   * user of the machine, with no diagnostic beyond a console line. Windows
   * keeps the bare name: per-user %TEMP% already isolates users.
   */
  function getPasteDir(): string {
    const uid = !isWin && typeof process.getuid === 'function' ? process.getuid() : undefined;
    return path.join(os.tmpdir(), uid === undefined ? 'finevibe-paste' : `finevibe-paste-${uid}`);
  }
  const PASTE_DIR = getPasteDir();
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
      // 0700: the dir is under a world-writable parent, and a pasted
      // screenshot is whatever the user just copied.
      await fs.promises.mkdir(PASTE_DIR, { recursive: true, mode: 0o700 });
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
        serviceName: 'finevibe-png-encode',
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
      // SEC-03: both paths are renderer-supplied and reach provider config
      // reads - the gates every other config-reading channel enforces: the
      // configDir must be a managed profile dir (P2-113) and the project
      // must be a known project. Legit callers pass the active project plus
      // a pinned profile dir.
      if (configDir && !isManagedMcpConfigDir(configDir)) throw new Error('Not a managed profile config dir');
      if (!isWithinKnownProject(path.resolve(projectPath))) throw new Error('Path is not within a known project');
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
    // getProvider stays first: an unknown provider id must keep throwing into
    // safeOn (P2-108), and the gate below only guards the path.
    const provider = getProvider(providerId);
    // C3A-02: the config watcher reads the provider config tree under a
    // renderer-supplied projectPath, so the channel takes the same PROJECT
    // tier as git:watchProject — an unknown path never starts a watcher.
    const resolved = path.resolve(projectPath);
    if (!isWithinKnownProject(resolved)) {
      console.warn(`config:watchProject blocked: ${resolved}`);
      return;
    }
    provider.startConfigWatcher?.(win, resolved);
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
    // C3A-03: same gate as provider:getConfig — a renderer-supplied
    // projectPath reaches provider.getTranscriptPath scan roots below.
    if (!isWithinKnownProject(path.resolve(projectPath))) throw new Error('Path is not within a known project');
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
    // C3A-03: an out-of-project path must never reach a provider scan root -
    // deny like the configDir gate above, not fail-open.
    if (!isWithinKnownProject(path.resolve(projectPath))) return false;
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
  ipcMain.handle('session:exportArchive', async (event, providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir: string | undefined, meta: ArchivedSession, format: 'zip' | 'file') => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no window');
    if (configDir && !isManagedMcpConfigDir(configDir)) throw new Error('Not a managed profile config dir');
    // C3A-03: same gate as provider:getConfig; exportArchive reads the
    // transcript tree under this projectPath.
    if (!isWithinKnownProject(path.resolve(projectPath))) throw new Error('Path is not within a known project');
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

  ipcMain.handle('provider:checkBinary', async (_event, providerId: ProviderId = 'claude') => {
    const provider = getProvider(providerId);
    // S4-03: async twin (Wave E) — the sync probe chain (`where` 3 s,
    // `npm prefix -g` 5 s per missing binary) blocked main; Preferences→
    // Setup fires this for all seven providers per section mount. The
    // probe caches (in-process + disk) keep repeats on the hot path.
    return await (provider.validatePrerequisitesAsync?.() ?? provider.validatePrerequisites());
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
    // S4-03: async twin availability filter — the sync predicate ran the
    // probe chain for every provider on main. Response shape unchanged:
    // one entry per available provider, install order preserved.
    const candidates = getAllProviders().filter((p) => p.installAgent);
    const availability = await Promise.all(candidates.map((p) => (
      p.validatePrerequisitesAsync
        ? p.validatePrerequisitesAsync()
        : Promise.resolve(p.validatePrerequisites())
    )));
    const targets = candidates.filter((_, i) => availability[i]);
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
    // The focused window, mirroring confirmHomeOutsideListing: with several
    // windows open, getAllWindows()[0] attaches the sheet to an arbitrary
    // (possibly hidden) one.
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    // Open where the user's projects live. Without defaultPath the native
    // picker starts wherever the OS last was — Documents on a fresh Windows
    // install, the portal/gtk default on Linux — so picking inside `E:\dev`
    // is a walk on every single pick. A stale preference must not break the
    // picker (and some platforms reject a missing defaultPath), so only an
    // existing directory is passed.
    let defaultPath: string | undefined;
    const configured = loadState().preferences?.defaultProjectsFolder;
    if (typeof configured === 'string' && configured.trim()) {
      const candidate = resolveUserPath(configured);
      try {
        if (fs.statSync(candidate).isDirectory()) defaultPath = candidate;
      } catch { /* removed/renamed folder: fall back to the platform default */ }
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0];
    // The native picker's selection IS the consent: record the pick so the
    // post-Browse fs:isDirectory / fs:listDirs label probes answer from the
    // cache with zero confirms. Home-tree picks never consult the gate, so
    // recording keeps the cache semantics uniform.
    rememberHomeOutsideConsent(picked, true);
    return picked;
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
  // so a tab whose title was generated/changed while FineVibe was closed stays
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
    // Isolated browser partitions (pane.ts: persist:finevibe-browser-iso-<id>)
    // live in userData/Partitions until quit: an isolated login's cookies and
    // localStorage must go when the session goes. Guarded by directory
    // existence so releasing a non-browser session never materialises a
    // partition via fromPartition().
    if (typeof sessionId === 'string' && ISO_SESSION_ID_RE.test(sessionId)) {
      const partDir = path.join(app.getPath('userData'), 'Partitions', `${ISO_PARTITION_PREFIX}${sessionId}`);
      if (fs.existsSync(partDir)) {
        session.fromPartition(`persist:finevibe-browser-iso-${sessionId}`)
          .clearStorageData()
          .catch((err) => console.warn('clearStorageData failed:', err))
          // A5 leak fix: clearStorageData empties the jar's contents, the
          // DIRECTORY itself used to survive until quit — every isolated
          // browser session ever released left its Partitions subtree
          // behind for the app's whole lifetime. Remove it once the jar is
          // cleared (locked dirs fall through to the boot sweep in main.ts).
          .finally(() => { removeIsoPartitionDirs(app.getPath('userData'), sessionId); });
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
    const dir = path.join(os.tmpdir(), 'finevibe-screenshots');
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
      let files = await getCachedProjectFiles(resolvedCwd);

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
      // C2M-03: TTL cache, same contract as the enumeration above - a
      // polling widget reads a sorted list instead of re-walking the tree.
      const hit = topFilesCache.get(resolvedCwd);
      if (hit && Date.now() - hit.at < TOP_FILES_TTL_MS) {
        topFilesCache.delete(resolvedCwd);
        topFilesCache.set(resolvedCwd, hit);
        return { ok: true, files: hit.files.slice(0, clampedLimit), scanned: hit.scanned, skipped: hit.skipped };
      }
      // UI3-11: one shared walk per cwd — concurrent widget mounts coalesce.
      let scan = topFilesScans.get(resolvedCwd);
      if (!scan) {
        scan = scanTopFiles(resolvedCwd).finally(() => topFilesScans.delete(resolvedCwd));
        topFilesScans.set(resolvedCwd, scan);
      }
      const { files, scanned, skipped } = await scan;
      return { ok: true, files: files.slice(0, clampedLimit), scanned, skipped };
    } catch (err) {
      console.warn('fs:topFilesByTokens failed:', err);
      return { ok: false };
    }
  });

  async function scanTopFiles(resolvedCwd: string): Promise<{ files: TopFile[]; scanned: number; skipped: number }> {
    // CI-08: same generation contract as getCachedProjectFiles - a scan that
    // started before a git:changed invalidation still answers its own caller,
    // but it is superseded and never repopulates the cleared cache.
    const gen = enumerateGeneration;
    const isIgnored = buildFineVibeIgnoreMatcher(resolvedCwd);
    const relFiles = (await getCachedProjectFiles(resolvedCwd)).filter((rel) => !isIgnored(rel));
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

          // C2M-05: bound the READ, not just the file. The token estimate is
          // a heuristic, so one 1 MiB head sample is enough; a larger file
          // scales the estimate by size/readBytes. Files ≤ 1 MiB read in
          // full - byte-identical to the old full slurp.
          const readLen = Math.min(stat.size, TOKEN_SCAN_READ_BYTES);
          const buf = Buffer.alloc(readLen);
          let readBytes = 0;
          if (readLen > 0) {
            ({ bytesRead: readBytes } = await handle.read(buf, 0, readLen, 0));
          }
          if (isBinaryBuffer(buf.subarray(0, Math.min(readBytes, BINARY_SNIFF_BYTES)))) {
            skipped++;
            return;
          }
          let tokens = estimateTokens(buf.subarray(0, readBytes).toString('utf-8'));
          if (readBytes > 0 && readBytes < stat.size) {
            tokens = Math.round(tokens * (stat.size / readBytes));
          }
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
    const result = { files: results, scanned, skipped };
    if (gen === enumerateGeneration) {
      topFilesCache.set(resolvedCwd, { at: Date.now(), ...result });
      if (topFilesCache.size > TOP_FILES_CACHE_MAX) {
        const oldest = topFilesCache.keys().next().value;
        if (oldest !== undefined) topFilesCache.delete(oldest);
      }
    }
    return result;
  }

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

  ipcMain.handle('fs:readFile', async (_event, filePath: string): Promise<ReadFileResult> => {
    try {
      // Security: resolve to absolute and check it's within a known project directory
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readFile blocked: ${resolved} is not within an allowed path`);
        return { ok: false, reason: 'error' };
      }
      // PA-24: async body — the channel is ipcMain.handle, so the renderer
      // API is unchanged; the old 8 MiB sync slurp blocked main per preview.
      // Sniff the head before slurping the whole file so a multi-MB binary
      // (e.g. build artifacts in build/) doesn't get allocated just to be discarded.
      // One fd for both: open once, sniff 8KB, read the remainder from the same fd.
      const handle = await fs.promises.open(resolved, 'r');
      try {
        const head = Buffer.alloc(BINARY_SNIFF_BYTES);
        const { bytesRead: headBytes } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0);
        if (isBinaryBuffer(head.subarray(0, headBytes))) {
          return { ok: false, reason: 'binary' };
        }
        const size = (await handle.stat()).size;
        if (size > MAX_READ_FILE_BYTES) return { ok: false, reason: 'error' };
        const rest = Buffer.alloc(Math.max(0, size - headBytes));
        let off = 0;
        while (off < rest.length) {
          const { bytesRead: n } = await handle.read(rest, off, rest.length - off, headBytes + off);
          if (n === 0) break; // EOF (file shrank between fstat and read)
          off += n;
        }
        return { ok: true, content: Buffer.concat([head.subarray(0, headBytes), rest.subarray(0, off)]).toString('utf-8') };
      } finally {
        await handle.close().catch(() => {});
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

  ipcMain.handle('fs:readImage', async (_event, filePath: string) => {
    try {
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) {
        console.warn(`fs:readImage blocked: ${resolved} is not within an allowed path`);
        return null;
      }
      const mime = IMAGE_MIME_BY_EXT[path.extname(resolved).toLowerCase()];
      if (!mime) return null;
      // PA-24: async stat + read; the sync whole-file slurp + base64 blocked
      // main for the full image (up to 25 MiB) per preview.
      const stat = await fs.promises.stat(resolved);
      if (stat.size > MAX_IMAGE_BYTES) {
        console.warn(`fs:readImage rejected: ${resolved} exceeds ${MAX_IMAGE_BYTES} bytes`);
        return null;
      }
      const buf = await fs.promises.readFile(resolved);
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

  // PA-24: the widget renders requested this every poll; the file was read
  // AND JSON.parsed in full each time. Memoize by (path, mtime, size) — the
  // hook-status poll rewrites the file when usage changes, and the resulting
  // mtime bump re-parses. Async body: the channel is ipcMain.handle.
  let statsCacheMemo: { file: string; mtimeMs: number; size: number; data: unknown } | null = null;
  ipcMain.handle('stats:getCache', async () => {
    try {
      const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
      const st = await fs.promises.stat(statsPath);
      const memo = statsCacheMemo;
      if (memo && memo.file === statsPath && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
        return memo.data;
      }
      const raw = await fs.promises.readFile(statsPath, 'utf-8');
      const data = JSON.parse(raw);
      statsCacheMemo = { file: statsPath, mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch {
      statsCacheMemo = null;
      return null;
    }
  });

  // Both run git in the renderer-named cwd (`git ls-files` for the readiness
  // scan, `git remote get-url` for the repo detect), so both take the same
  // root gate as the 13 git:* handlers: a known project or a watched worktree.
  ipcMain.handle('readiness:analyze', async (_event, projectPath: string, excludedProviders?: ProviderId[]) => {
    const root = requireGitRoot('readiness:analyze', projectPath);
    // S4-03: warm the registry availability cache with the async probe
    // twin. analyzeReadiness() reads availability through the sync
    // getAvailableProviderIds(); warming first makes that a cache hit, so
    // the first scan no longer runs the six sync probe chains on main.
    // Response shape is the same ReadinessResult promise.
    await getAvailableProviderIdsAsync();
    return analyzeReadiness(root, excludedProviders);
  });

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
  ipcMain.handle('agentmemory:log', () => readAgentmemoryLog());

  ipcMain.handle('settings:reinstall', (_event, providerId: ProviderId = 'claude', configDir?: string, projectPath?: string) => {
    // P2-127: configDir is the dir the warning banner was computed from —
    // "Fix Settings" must repair THAT dir, since a profiled CLI never reads
    // ~/.claude. Renderer-supplied, and this writes settings.json into it:
    // same managed-profile gate as pty:create (P1-15).
    // P2-55: projectPath is the session cwd the banner was validated
    // against — Copilot's hooks are project-scoped, so the repair must
    // target THAT project, not the user-scope / last-installed one.
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      return { success: false, error: `Refused: ${configDir} is not a managed profile directory.` };
    }
    try {
      const provider = getProvider(providerId);
      provider.reinstallSettings(configDir, projectPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
  // P2-86: scoped like the post-spawn validation (pty:create passes
  // (cwd, configDir) deliberately — Copilot's hooks are per-project): the
  // renderer passes the project its banner/CTA was computed from so a
  // broken project-scoped config is not reported `complete` from the
  // user-global file. No args = user-scope check (Preferences > Setup).
  ipcMain.handle('settings:validate', (_event, providerId: ProviderId = 'claude', projectPath?: string, configDir?: string): SettingsValidationResult => {
    return getProvider(providerId).validateSettings(projectPath, configDir);
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

  // C3A-01: filePath arrives via the renderer as an echo of the list results,
  // and removeMcpServer's self-built allowlist (claude-cli.ts) is derived from
  // the same projectPath+configDir args — so they both identify AND authorize
  // the write target. Gate the boundary like addMcpServer (claude-cli.ts) and
  // provider:getConfig: configDir must be a managed profile dir, and a project
  // scope must name a known project, or the allowlist is renderer-authored.
  ipcMain.handle('mcp:removeServer', (_event, name: string, filePath: string, scope: 'user' | 'project', projectPath?: string, configDir?: string) => {
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      return { success: false, error: `Refused: ${configDir} is not a managed profile directory.` };
    }
    if (scope === 'project' && (!projectPath || !isWithinKnownProject(path.resolve(projectPath)))) {
      return { success: false, error: 'Path is not within a known project' };
    }
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
