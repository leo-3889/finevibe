/**
 * Row 26 slice 5: the fs IPC domain — 17 registrations plus the gate, consent
 * and enumeration machinery that only they use.
 *
 * Seam contract (leaf-domains.ts / hosts-domains.ts): channels stay STRING
 * LITERALS so ipc-channel-parity.test.ts keeps pinning both ends, bodies are a
 * verbatim move, and nothing imports back into `ipc-handlers.ts`.
 *
 * Design note (audit row 26): nothing here was closure state. The fs handlers
 * closed over module-level declarations of ipc-handlers.ts, and every one of
 * them is fs-private — the read/enumerate gates, the home-outside consent
 * cache, the project-file enumeration caches and the top-files scan — so they
 * MOVE with the handlers instead of arriving as injected getters (a Map passed
 * in as a "getter" is the same coupling with an extra hop). The two gates the
 * git/pty side shares, `isWithinKnownProject` and `remoteProjectOwnerOf`, live
 * in project-gates.ts; `safeOn` lives in ./safe-on.ts. `invalidateEnumerations`
 * is exported for the git:changed subscription that stays in ipc-handlers.ts.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isRemotePathInKnownProject, listRemoteDir, readRemoteFile, statRemotePath, walkRemoteFiles } from '../hosts/remote-fs';
import { setRemoteWatchWindow, unwatchRemoteDir, watchRemoteDir } from '../hosts/remote-watch';
import { watchDir, unwatchDir, setFileWatcherWindow } from '../file-watcher';
import { loadState } from '../store';
import { canonicalPath, canonicalRoot, expandUserPath, resolveUserPath, isBinaryBuffer, isMacPackagePath, BINARY_SNIFF_BYTES, isWithin } from '../fs-utils';
import { isMac, isWin } from '../platform';
import { buildFineVibeIgnoreMatcher } from '../finevibeignore';
import { getMainWindow } from '../main-window';
import { isWithinKnownProject, remoteProjectOwnerOf } from '../project-gates';
import { safeOn } from './safe-on';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../../shared/token-estimate';
import { detectGitCheckoutUrl } from '../../shared/git-url';
import { LOCAL_HOST_ID } from '../../shared/types';
import type { ReadFileResult, FileStatResult, TopFilesResult, TopFile } from '../../shared/types';
import { boundedSet } from '../bounded-map';

const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;
// "Checkout and create": a full clone of a large allowlisted repo over a slow
// link is minutes, not seconds; the modal shows a progress state, so this
// generous bound only bounds hangs.
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

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
  boundedSet(outsideHomeConsent, canonicalPath(dir), answer, OUTSIDE_HOME_CONSENT_MAX);
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

export function invalidateEnumerations(): void {
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
  return getCachedFiles(resolvedCwd, () => enumerateProjectFiles(resolvedCwd));
}

// Query ranking shared by both fs:listFiles branches (local + R2 remote walk):
// exact basename > prefix > name-substring > path-substring, capped by the
// caller. Paths are posix-relative, so basename is a plain '/' split (the
// previous path.basename call behaved identically on both platforms).
function rankFilesByQuery(files: string[], _cwd: string, query: string): string[] {
  if (!query) return files;
  const lower = query.toLowerCase();
  const exact: string[] = [];
  const startsWith: string[] = [];
  const nameContains: string[] = [];
  const pathContains: string[] = [];
  for (const f of files) {
    const fileName = (f.split('/').pop() ?? f).toLowerCase();
    if (fileName === lower) exact.push(f);
    else if (fileName.startsWith(lower)) startsWith.push(f);
    else if (fileName.includes(lower)) nameContains.push(f);
    else if (f.toLowerCase().includes(lower)) pathContains.push(f);
  }
  return [...exact, ...startsWith, ...nameContains, ...pathContains];
}

// R2 Phase 4a: the same cache serves remote enumerations under the key
// `${hostId}|${cwd}` (a remote cwd must never share a key with the local
// mirror-path string). The generation counter is local-git-driven; a local
// git:changed bump merely costs a remote project one extra re-walk after its
// TTL — cheaper than a second cache family, and remote trees have no watcher
// anyway (docs/hosts.md).
async function getCachedFiles(key: string, loader: () => Promise<string[]>): Promise<string[]> {
  const hit = enumerateCache.get(key);
  if (hit && Date.now() - hit.at < ENUMERATE_TTL_MS) {
    enumerateCache.delete(key);
    enumerateCache.set(key, hit);
    return hit.files;
  }
  const pending = enumerateInFlight.get(key);
  if (pending) return pending;
  const gen = enumerateGeneration;
  const run = async (): Promise<string[]> => {
    try {
      const files = await loader();
      if (gen === enumerateGeneration) {
        boundedSet(enumerateCache, key, { at: Date.now(), files }, ENUMERATE_CACHE_MAX);
      }
      return files;
    } finally {
      // Only the run that still owns the slot clears it; an invalidation may
      // have handed this cwd to a newer enumeration already.
      if (enumerateInFlight.get(key) === work) enumerateInFlight.delete(key);
    }
  };
  const work = run();
  enumerateInFlight.set(key, work);
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

/** @internal Test-only: drop every cached/in-flight enumeration. */
export function _resetEnumerateCacheForTesting(): void {
  invalidateEnumerations();
}

export function registerFsDomains(): void {
  ipcMain.handle('fs:isDirectory', async (_event, filePath: string, hostId?: string) => {
    try {
      // Remote rail (parent plan §11, per-host providers): a trailing hostId
      // routes the probe over sftp. The gate is remote-fs' host-exists +
      // enrolled|partial + path safety + project containment — no
      // enumerate-confirm (council R-1), and no local consent gate: a remote
      // path has no LOCAL spelling, so every local gate would reject it as a
      // C:\home\... fallback (T5 lesson, replicated on every fs rail here).
      if (hostId && hostId !== LOCAL_HOST_ID) {
        // Audit R93: this is a TREE rail, so it takes the project containment
        // fs:listDir / fs:readFile already ran — the dir-browser lanes
        // (hosts:stat / hosts:listDirs) are the ones the HostRecord consents to.
        if (!isRemotePathInKnownProject(hostId, filePath)) {
          console.warn(`fs:isDirectory remote blocked [${hostId}] ${filePath}: not a known project path`);
          return false;
        }
        const st = await statRemotePath(hostId, filePath);
        if (st.error) console.warn(`fs:isDirectory remote failed [${hostId}] ${filePath}: ${st.error}`);
        return st.ok && st.isDirectory === true;
      }
      // resolveUserPath: the renderer spells this path with `/` joins on
      // Windows (`E:\AI/Acme`), and a mixed spelling must never reach
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
      // E:\AI\Acme reported "Directory does not exist".
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
    // The only string-taking fs channel with no try/catch: a non-string from a
    // renderer bug would throw a raw TypeError straight out of the channel.
    if (typeof filePath !== 'string') return '';
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

  ipcMain.handle('fs:listDir', async (_event, dirPath: string, hostId?: string) => {
    try {
      // Remote rail: the file tree's listing over sftp. Gated in remote-fs
      // (host enrolled + path safety + project containment); failures answer
      // [] exactly like the local catch, so the tree renders "empty" for a
      // dead host instead of rejecting mid-expand.
      if (hostId && hostId !== LOCAL_HOST_ID) {
        try {
          const res = await listRemoteDir(hostId, dirPath);
          if (!res.ok) {
            console.warn(`fs:listDir remote blocked [${hostId}] ${dirPath}: ${res.error}`);
            return [];
          }
          return res.entries;
        } catch (err) {
          console.warn(`fs:listDir remote failed [${hostId}] ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
          return [];
        }
      }
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

  ipcMain.handle('fs:browseDirectory', async () => {
    // The focused window, mirroring confirmHomeOutsideListing: with several
    // windows open, getAllWindows()[0] attaches the sheet to an arbitrary
    // (possibly hidden) one.
    const win = BrowserWindow.getFocusedWindow() ?? getMainWindow();
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

  ipcMain.handle('fs:listFiles', async (_event, cwd: string, query: string, hostId?: string) => {
    try {
      // R2 Phase 4a: a registry hostId routes to the sftp walk sibling; the
      // local branch and its Phase 3 belt below stay untouched for 'local'.
      if (hostId && hostId !== LOCAL_HOST_ID) {
        const remoteFiles = await getCachedFiles(`${hostId}|${cwd}`, () => walkRemoteFiles(hostId, cwd));
        return rankFilesByQuery(remoteFiles, cwd, query).slice(0, 50);
      }
      const resolvedCwd = path.resolve(cwd);
      const remoteOwner = remoteProjectOwnerOf(resolvedCwd);
      if (remoteOwner) {
        // Phase 3 belt: on mirror-path controllers the local gate below
        // passes for a remote root; refuse before listing the wrong machine.
        // A caller that names the host now reaches the sftp branch above.
        console.warn(`fs:listFiles blocked: ${resolvedCwd} is a project on remote host ${remoteOwner}`);
        return [];
      }
      if (!isWithinKnownProject(resolvedCwd)) {
        return [];
      }
      const files = await getCachedProjectFiles(resolvedCwd);
      return rankFilesByQuery(files, resolvedCwd, query).slice(0, 50);
    } catch (err) {
      console.warn('fs:listFiles failed:', err);
      return [];
    }
  });

  ipcMain.handle('fs:topFilesByTokens', async (_event, cwd: string, limit: number): Promise<TopFilesResult> => {
    try {
      const resolvedCwd = path.resolve(cwd);
      // R101: fs:listFiles' Phase 3 belt, missing here — on a mirror-path
      // controller the local gate below passes for a remote root and the widget
      // ranks the WRONG machine's files.
      const remoteOwner = remoteProjectOwnerOf(resolvedCwd);
      if (remoteOwner) {
        console.warn(`fs:topFilesByTokens blocked: ${resolvedCwd} is a project on remote host ${remoteOwner}`);
        return { ok: false };
      }
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
      boundedSet(topFilesCache, resolvedCwd, { at: Date.now(), ...result }, TOP_FILES_CACHE_MAX);
    }
    return result;
  }

  ipcMain.handle('fs:exists', async (_event, filePath: string, hostId?: string): Promise<boolean> => {
    try {
      if (hostId && hostId !== LOCAL_HOST_ID) {
        // Audit R93: TREE rail — project containment, like fs:listDir (the
        // remote existence oracle must not probe arbitrary host paths).
        if (!isRemotePathInKnownProject(hostId, filePath)) {
          console.warn(`fs:exists remote blocked [${hostId}] ${filePath}: not a known project path`);
          return false;
        }
        const st = await statRemotePath(hostId, filePath);
        if (st.error) console.warn(`fs:exists remote failed [${hostId}] ${filePath}: ${st.error}`);
        return st.ok;
      }
      const resolved = path.resolve(filePath);
      if (!isAllowedReadPath(resolved)) return false;
      return fs.existsSync(resolved);
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:stat', async (_event, filePath: string, hostId?: string): Promise<FileStatResult> => {
    try {
      if (hostId && hostId !== LOCAL_HOST_ID) {
        // Audit R93: TREE rail — project containment, like fs:readFile.
        if (!isRemotePathInKnownProject(hostId, filePath)) {
          console.warn(`fs:stat remote blocked [${hostId}] ${filePath}: not a known project path`);
          return { ok: false };
        }
        const st = await statRemotePath(hostId, filePath);
        if (st.error) console.warn(`fs:stat remote failed [${hostId}] ${filePath}: ${st.error}`);
        return st.ok && st.size !== undefined && st.mtimeMs !== undefined
          ? { ok: true, size: st.size, mtimeMs: st.mtimeMs }
          : { ok: false };
      }
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

  ipcMain.handle('fs:readFile', async (_event, filePath: string, hostId?: string): Promise<ReadFileResult> => {
    try {
      // Remote rail: the file preview over sftp (size-capped, head-sniffed
      // for binary — the same ReadFileResult shape as the local lane).
      if (hostId && hostId !== LOCAL_HOST_ID) {
        const res = await readRemoteFile(hostId, filePath);
        if (!res.ok) console.warn(`fs:readFile remote blocked [${hostId}] ${filePath}: ${res.reason}${res.reason === 'binary' ? ' (size/sniff)' : ''}`);
        return res;
      }
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

  ipcMain.on('fs:watchDir', safeOn('fs:watchDir', (event, dirPath: string, hostId?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Remote rail (Phase 4 watcher): path.resolve would mangle a POSIX path
    // on this Windows controller, so the host branch skips the local gate —
    // remote-watch validates via normalizeRemotePath and the poll fails safe.
    if (hostId && hostId !== LOCAL_HOST_ID) {
      if (win) setRemoteWatchWindow(win);
      watchRemoteDir(hostId, dirPath);
      return;
    }
    const resolved = path.resolve(dirPath);
    if (!isAllowedReadPath(resolved)) return;
    if (win) setFileWatcherWindow(win);
    watchDir(resolved);
  }));

  ipcMain.on('fs:unwatchDir', safeOn('fs:unwatchDir', (_event, dirPath: string, hostId?: string) => {
    if (hostId && hostId !== LOCAL_HOST_ID) {
      unwatchRemoteDir(hostId, dirPath);
      return;
    }
    const resolved = path.resolve(dirPath);
    // P2-30: mirror fs:watchDir's gate. Unwatch is destructive — the watcher
    // refcounts by path alone, so any frame naming a watched dir silently
    // drops the other frames' refs. A path the watch side refuses must not
    // be unwatchable.
    if (!isAllowedReadPath(resolved)) return;
    unwatchDir(resolved);
  }));
}
