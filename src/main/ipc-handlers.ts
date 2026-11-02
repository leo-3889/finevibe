import { ipcMain, BrowserWindow, app, clipboard, session, utilityProcess } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'node:crypto';
import { spawnPty, spawnShellPty, writePty, resizePty, killPty, getPtyCwd } from './pty-manager';
import { isManagedMcpConfigDir } from './claude-cli';
import { fileURLToPath } from 'node:url';
import { loadState, saveState, saveStateSync, getKnownProjectPaths, invalidateStateCache, PersistedState } from './store';
import { getHost } from './hosts/host-registry';
import { refreshHostTools } from './hosts/enrollment';
import { isRemotePathInKnownProject } from './hosts/remote-fs';
import { startWatching, cleanupSessionStatus, resyncAllSessions, registerSession } from './hook-status';
import { registerTranscriptSync, unregisterTranscriptSync, getSyncedTranscriptPath } from './session-transcript-sync';
import type { SessionExitReason } from './providers/pi-compatible-transcripts';
import { notifyGitChanged, onGitChanged } from './git-watcher';
import { registerMcpHandlers } from './mcp-ipc-handlers';
import { getProvider, getAllProviderMetas, getAllProviders } from './providers/registry';
import { exportSessionArchive, resolveLaunchSessionDir } from './session-export';
import { remoteLaunchSessionDir } from './launch-session-dir';
import type { CliProvider } from './providers/provider';
import { buildHandoffPrompt } from './providers/resume-handoff';
import { searchSessions } from './session-deep-search';
import { SPAWN_REJECTED_EXIT_REASON } from '../shared/constants';
import type { ProviderId, Profile, Preferences, SettingsValidationResult, ArchivedSession } from '../shared/types';
import { LOCAL_HOST_ID } from '../shared/types';
import { canonicalPath, invalidateCanonicalPathIfRootsChanged } from './fs-utils';
import { isLinux, isMac, isWin } from './platform';
import { listProfiles as listChromeProfiles, runImport as runChromeImport, clearImportedCookies, getCookieCount } from './chrome-import/importer';
import { sweepImportTempDirs } from './chrome-import/copy';
import { dirSizeBytes } from './launch-session-dir';
import { getLegacyRetirementStatus } from './userdata-migration';
import type { ChromeImportOptions, ChromeImportProgress, ClipboardSource, ClipboardPastePayload } from '../shared/types';
import { shouldWarnStatusLine, getDirConsent, recordDirConsent } from './settings-guard';
import { getMainWindow, showAndFocusWindow } from './main-window';
import { registerLeafDomains } from './ipc/leaf-domains';
import { registerAppDomains } from './ipc/app-domains';
import { registerSupportDomains } from './ipc/support-domains';
import { registerHostsDomains } from './ipc/hosts-domains';
import { registerFsDomains, invalidateEnumerations } from './ipc/fs-domains';
import { registerGitDomains, requireGitRoot } from './ipc/git-domains';
import { safeOn } from './ipc/safe-on';
import { isWithinKnownProject, remoteProjectOwnerOf } from './project-gates';

// SA-P2-4: `store:save` / `store:save-sync` take the renderer's PersistedState
// verbatim. saveState validates the gate roots (P1-12) and grafts the
// main-owned consent keys (S1-02), but `preferences` itself was never checked:
// an injected unknown key persisted to disk and re-hydrated into every
// consumer. Known-keys filter at the IPC boundary (no schema library). The
// main-owned keys stay in the list on purpose — the store's graft runs AFTER
// this (saveState → graftMainOwnedState) and overwrites them with the
// authoritative cache values, so filtering them out here would only erase the
// payload the graft replaces. The `satisfies` is the drift guard: a Preferences
// key missing from this object is a compile error, not a silent drop.
const PREFERENCE_KEYS = {
  soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: true,
  sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true,
  confirmCloseWorkingSession: true, zoomFactor: true, defaultProvider: true,
  locale: true, defaultProfiles: true, planModeDefaults: true,
  statusLineConsent: true, statusLineConsentCommand: true, statusLineConsentByDir: true,
  copyOnSelect: true, askAiFocus: true, defaultProjectsFolder: true,
  keybindings: true, theme: true, readinessExcludedProviders: true,
  sidebarViews: true, boardCardMetrics: true,
  activeHostId: true,
  chromeImport: true,
} satisfies Record<keyof Preferences, true>;

function sanitizePersistedState(state: PersistedState): PersistedState {
  const prefs = state?.preferences;
  if (!prefs || typeof prefs !== 'object') return state;
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(prefs)) {
    if (Object.hasOwn(PREFERENCE_KEYS, key)) clean[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    console.warn(`store:save dropped ${dropped.length} unknown preferences key(s): ${dropped.join(', ')}`);
  }
  // SAFETY: every key of `clean` passed the PREFERENCE_KEYS allowlist, so the
  // object is a Preferences-shaped subset by construction; TS cannot follow
  // Object.entries' Record<string, unknown> widening back to the interface.
  return { ...state, preferences: clean as unknown as Preferences };
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

// The debounced working-tree/branch-change signal from git-watcher is
// subscribed in registerIpcHandlers (tests re-register and capture it).

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

interface StorageSubtreeUsage {
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

/**
 * The temp directories main WRITES into, uid-scoped (audit R95, documented in
 * docs/security-boundaries.md): `os.tmpdir()` is world-writable and shared by
 * every user, so a fixed name under mode 0700 is claimed by whoever creates it
 * first and every other user's mkdir then fails EACCES — one local
 * `mkdir /tmp/<name>` switches the feature off machine-wide, and a dir a
 * foreign user owns is a write-squat target for what gets written into it.
 * `getStatusDir()` (hook-status.ts) carries the same suffix for the status
 * sidecars. Windows keeps the bare name: per-user %TEMP% already isolates.
 */
export function uidScopedTempDir(base: string): string {
  const uid = !isWin && typeof process.getuid === 'function' ? process.getuid() : undefined;
  return path.join(os.tmpdir(), uid === undefined ? base : `${base}-${uid}`);
}

export function registerIpcHandlers(): void {
  // PA-07: invalidate the Quick Open enumeration cache on the same debounced
  // git:changed signal the renderer receives.
  onGitChanged(invalidateEnumerations);
  ipcMain.handle('pty:create', async (_event, sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs: string, providerId: ProviderId = 'claude', initialPrompt?: string, systemPrompt?: string, envVars: string = '', configDir?: string, hostId?: string) => {
    const win = getMainWindow();
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
    // Audit R96: the cwd gate is host-aware. A REMOTE launch's cwd is a HOST
    // path, and isWithinKnownProject canonicalizes against the LOCAL disk
    // (realpath of existing dirs): a Windows controller turned `/srv/app` into
    // `C:\srv\app` and refused every remote provider launch, while a Linux
    // controller whose paths mirror the host's accepted the same string for the
    // WRONG machine. Remote launches are therefore contained against the project
    // roots recorded FOR THAT HOST (remote-fs' rule, no local disk touched).
    const remoteLaunchHost = hostId !== undefined && hostId !== LOCAL_HOST_ID ? hostId : undefined;
    // The launch's transcript dir on the plane the CLI runs on, ONE derivation
    // for both registration branches (audit T2 #5 + row 36): the host-side
    // spelling a registry-host launch's argv carries, else the local launch dir;
    // only the Pi-compatible providers take a `--session-dir`.
    const launchSessionDir =
      providerId === 'pi' || providerId === 'pi-bolt' || providerId === 'omp'
        ? remoteLaunchHost !== undefined
          ? remoteLaunchSessionDir(providerId, sessionId)
          : resolveLaunchSessionDir(providerId, sessionId)
        : undefined;
    if (remoteLaunchHost !== undefined) {
      if (!isRemotePathInKnownProject(remoteLaunchHost, cwd)) {
        rejectLaunch(`Refused to launch: the working directory ${cwd} is not a known project of host ${JSON.stringify(remoteLaunchHost)}.`);
        return;
      }
    } else {
      // Phase 3 belt, on the RAW string (the requireGitTarget lesson): a path a
      // REMOTE project owns must not spawn the LOCAL CLI in the mirror dir.
      const mirroredOwner = remoteProjectOwnerOf(cwd);
      if (mirroredOwner !== undefined) {
        rejectLaunch(`Refused to launch: ${cwd} is a project on remote host ${JSON.stringify(mirroredOwner)} — start the session with that host selected.`);
        return;
      }
      if (!isWithinKnownProject(path.resolve(cwd))) {
        rejectLaunch(`Refused to launch: the working directory ${cwd} is not a known project.`);
        return;
      }
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
      // Audit T2 #5: a remote launch's dir is the HOST-side spelling (the
      // same remoteLaunchSessionDir the spawn argv carries — one derivation,
      // both planes; a local userData path can never exist on the host).
      registerTranscriptSync(sessionId, providerId, cliSessionId, cwd, configDir, { sessionDir: launchSessionDir, hostId });
      // ...and let the provider re-attach to its own on-disk state,
      // seeding the sessions watcher as an ADOPTED entry (known id +
      // existing transcript path) so a later `/clear` — a brand-new
      // transcript under a new id in the launch's own dir — is
      // re-adopted instead of the tab freezing on the pre-clear file.
      provider.onSessionResumed?.(sessionId, cwd, win, configDir, cliSessionId, remoteLaunchHost);
    } else {
      provider.onSessionStarted?.(sessionId, cwd, win, configDir, remoteLaunchHost);
      // Audit row 36: a REMOTE fresh Pi/Pi-Bolt launch writes its transcript on
      // the HOST, so the provider's local sessions watcher never sees it and the
      // tab would stay blank for the session's whole life. The launch pinned
      // its CLI id in the argv (`--session-id`), so the host-side transcript is
      // attributable from its first append — register the same host-plane sync
      // the RESUME branch above uses, with the same host dir derivation.
      // OMP pins no id (it generates one on the host), so it has nothing to
      // attribute and stays blank until resumed (docs/provider-contracts.md).
      if (remoteLaunchHost !== undefined) {
        const pinnedCliId = provider.getLaunchCliSessionId?.(sessionId) ?? null;
        if (pinnedCliId) {
          registerTranscriptSync(sessionId, providerId, pinnedCliId, cwd, configDir, {
            sessionDir: launchSessionDir,
            hostId: remoteLaunchHost,
          });
        }
      }
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
            const rejectedWin = getMainWindow();
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
          const w = getMainWindow();
          if (w && !w.isDestroyed()) {
            w.webContents.send('pty:exit', sessionId, exitCode, signal, exitReason, pid);
          }
        },
        configDir,
        hostId
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
    const win = getMainWindow();
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
    const dataSink = ptyDataSink(() => getMainWindow(), sessionId);
    spawnShellPty(
      sessionId,
      cwd,
      dataSink,
      (exitCode, signal) => {
        dataSink.flush();
        const w = getMainWindow();
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

  function ptyDataSink(getWindow: () => BrowserWindow | null | undefined, sessionId: string): PtyDataSink {
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

  // Row 26 slice 5: the 17 fs:* registrations live in ipc/fs-domains.ts, with
  // the gate/consent/enumeration machinery only they use. One call registers
  // all of them; the channels were previously written at three sites in this
  // file (registration is keyed by channel, so the order is not observable).
  registerFsDomains();

  ipcMain.handle('store:load', () => {
    return loadState();
  });


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
    // SA-P2-4: preferences key allowlist at the boundary, before the store's
    // gate-root validation and the main-owned graft (both run in saveState).
    saveState(sanitizePersistedState(state));
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
    // SA-P2-4: same allowlist as store:save — same renderer payload class.
    saveStateSync(sanitizePersistedState(state));
    event.returnValue = true;
  }, () => false));

  // Synchronous startup channel: the renderer applies theme/zoom before its
  // first paint, before the async store:load resolves. Served from the
  // in-memory state cache, so no file read happens on this path.
  ipcMain.on('store:startup-prefs', safeOn('store:startup-prefs', (event) => {
    const prefs = loadState().preferences;
    event.returnValue = { theme: prefs.theme ?? null, zoomFactor: prefs.zoomFactor ?? null };
  }, () => ({ theme: null, zoomFactor: null })));

  // Row 26 slice 1: the leaf domains (disk-health, vibeyard, menu, update) live
  // in src/main/ipc/leaf-domains.ts; the only closure value they need is the
  // live known-project path list.
  registerLeafDomains({ getKnownProjectPaths });
  // Row 26 slice 2: github/app/mcp domains in src/main/ipc/app-domains.ts. The
  // preload path keeps computing here (__dirname must stay the big file's).
  registerAppDomains({
    requireGitRoot,
    isWithinKnownProject,
    getBrowserPreloadPath: () =>
      path.join(__dirname, '..', '..', 'preload', 'preload', 'browser-tab-preload.js'),
  });

  // Row 26 slice 3: stats/readiness/profiles in src/main/ipc/support-domains.ts.
  registerSupportDomains({ requireGitRoot });
  // Row 26 slice 4: the hosts:* domain in src/main/ipc/hosts-domains.ts. The
  // only closure value it needs is the pty coalescer factory, shared with the
  // pty:* handlers below, so it stays here and is injected.
  registerHostsDomains({ createPtyDataSink: ptyDataSink });

  // Row 31: the renderer's console goes to devtools and dies with the window,
  // so renderer diagnostics never reached `finevibe.log` (main's console is
  // tee'd there by log-file.ts). One intake: validate, tag, and write through
  // the tee'd console. Fire-and-forget (`ipcMain.on`): a log line never
  // blocks the renderer, and the renderer's own per-minute budget
  // (src/renderer/log.ts) plus installConsoleThrottle bound the volume.
  const RENDERER_LOG_LEVELS = new Set(['log', 'info', 'warn', 'error']);
  // P2-108 on-body contract (`safeOn`): a throw here — a console patched out,
  // a log-file sink that died — must not take main down with it. There is no
  // syncFallback: `log:write` is a send, the renderer never waits on it.
  ipcMain.on('log:write', safeOn('log:write', (_event, level: unknown, message: unknown) => {
    if (typeof level !== 'string' || !RENDERER_LOG_LEVELS.has(level)) return;
    if (typeof message !== 'string') return;
    console[level as 'log' | 'info' | 'warn' | 'error'](`[renderer] ${message.slice(0, 2000)}`);
  }));


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
   * The paste temp dir: `finevibe-paste` uid-suffixed on POSIX (the
   * world-writable-tmpdir rule now lives in `uidScopedTempDir`, shared with the
   * browser screenshot dir — audit R95).
   */
  function getPasteDir(): string {
    return uidScopedTempDir('finevibe-paste');
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
  // P2 (todos/archives/plans/clipboard-paste-latency-plan.md): probe a file-list format
  // only on the platform that defines it AND when `availableFormats()`
  // (already fetched by the caller for free) lists it on this clipboard.
  // A plain-text paste then costs two acquisitions — formats + text — down
  // from six, with zero thrown probes and zero warns; the throw-and-warn
  // probes this replaces read formats that are simply not on a text
  // clipboard. Which format is live per OS is P0-measured
  // (docs/performance.md): Windows FileNameW (Electron's
  // readBuffer('CF_HDROP') answers 0 bytes — Chromium maps the drop list
  // onto text/uri-list — so the CF_HDROP branch stays as the gated
  // pre-wide-senders fallback), macOS (audit R116: `public.file-url` first,
  // the deprecated `NSFilenamesPboardType` plist as the fallback), Linux
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
    // Audit R116: `NSFilenamesPboardType` is the pre-UTI type, and a growing
    // set of senders (Finder's single-file copy, anything writing an
    // NSPasteboardItem via `writeObjects([NSURL])`) publish only
    // `public.file-url`. With nothing but that flavor the branch below read
    // nothing, and the paste degraded to the file NAME the sender echoed as
    // clipboard text. Electron surfaces the flavor through `clipboard.read`
    // (`read(format): string`), which hands back the pasteboard's raw bytes:
    // one `file://` URL, NUL-padded.
    // ponytail: one URL per pasteboard item, which is what the flavor carries;
    // multi-file copies are exactly the case that still publishes the plist
    // below, so that branch stays as the fallback rather than decoding a
    // hypothetical multi-URL file-url.
    if (isMac && paths.length === 0 && hasFormat(formats, 'public.file-url')) {
      try {
        const tRead = CLIPBOARD_TIMING ? performance.now() : 0;
        const url = clipboard.read('public.file-url').replace(/\0[\s\S]*$/, '').trim();
        if (url.startsWith('file://')) paths.push(fileURLToPath(url));
        if (sub) sub.fileUrl = performance.now() - tRead;
      } catch (err) {
        console.warn('Failed to read clipboard file URL', err);
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
        for (const key of ['fileNameW', 'hdrop', 'fileUrl', 'nsPlist', 'uriList'] as const) {
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
    async (_event, providerId: ProviderId, projectPath: string, configDir?: string, hostId?: string) => {
      if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
        // Remote branch (per-host providers plan §3): read the host's config
        // through the sftp seam. SEC-03's shape preserved — the gates are the
        // host-scope analogues of the local ones (paths are host-side posix;
        // canonicalizing against the local disk would be meaningless).
        if (!getHost(hostId)) throw new Error(`Unknown host: ${JSON.stringify(hostId)}`);
        if (configDir !== undefined) {
          // Managed-profile gate, host scope: configDir must be exactly a
          // persisted profile's configDir recorded FOR THIS HOST — the same
          // "never derived from the payload's path shape" rule as the local
          // branch, without the local-fs canonicalization.
          const profiles = loadState().profiles ?? [];
          const isManagedRemote = profiles.some((p) => (p.hostId ?? LOCAL_HOST_ID) === hostId && p.configDir === configDir);
          if (!isManagedRemote) throw new Error(`Not a managed profile config dir: ${JSON.stringify(configDir)}`);
        }
        // Audit T2 #4: project containment is HOST-scoped. The gate roots
        // are the project paths RECORDED FOR THIS HOST (`ProjectRecord.hostId`,
        // normalized 'local' at load) — never the local-disk roots, which
        // canonicalize against the controller's filesystem and would let a
        // locally-known path unlock a read of the same string on the host.
        // Until T5 registers remote projects, a host with no recorded
        // project of its own gets no remote project scope at all.
        const hostProjects = (loadState().projects ?? []).filter(
          (p) => (p.hostId ?? LOCAL_HOST_ID) === hostId,
        );
        // Audit R94: the compare is remote-fs' ONE containment helper (used by
        // the fs tree rails too), which rejects `..` on the raw segments and
        // compares normalized spellings on both sides. The old raw `startsWith`
        // let `/proj/evil/../../secret` through the gate and `joinPosix` +
        // `normalizeProviderPath` collapsed the `..` AFTER it — an arbitrary
        // host-directory read of the fixed config filenames (.mcp.json, tokens
        // in) behind a path that looked contained.
        if (!isRemotePathInKnownProject(hostId, projectPath)) {
          throw new Error(
            hostProjects.length === 0
              ? `No projects are registered for host ${JSON.stringify(hostId)} — remote project-scope config is refused`
              : `Path is not within a known project of host ${JSON.stringify(hostId)}: ${JSON.stringify(projectPath)}`,
          );
        }
        const { getRemoteProviderConfig } = await import('./hosts/remote-provider-config');
        return getRemoteProviderConfig(providerId, hostId, projectPath, configDir);
      }
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
    const win = getMainWindow();
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
    const win = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
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

  ipcMain.handle('provider:checkBinary', async (_event, providerId: ProviderId = 'claude', hostId?: string) => {
    if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
      // Per-host providers plan §2: a registry host answers from its record —
      // no probing, no SSH on the request path. Stale (or never-probed)
      // records answer anyway and refresh in the background over the exec
      // lane (concurrent refreshes dedupe).
      const record = getHost(hostId);
      if (!record) return false;
      const probedAt = record.lastProbeAt ? Date.parse(record.lastProbeAt) : 0;
      if (Date.now() - probedAt > 24 * 60 * 60 * 1000) {
        refreshHostTools(record).catch(() => { /* the next checkBinary retries */ });
      }
      return record.prerequisites?.[providerId]?.ok === true;
    }
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

  // Replay every status file. The hook scripts write only on change, so a
  // title already on disk produces no further fs event — without this, turning
  // "Auto-name sessions" back on would leave existing tabs unnamed until their
  // title happened to change.
  ipcMain.on('session:resyncStatus', safeOn('session:resyncStatus', () => {
    const w = getMainWindow();
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
    const win = getMainWindow();
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
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      showAndFocusWindow(win);
    }
  }));

  // `app:closeConfirmed` is registered in src/main/main.ts: the reply has to
  // act on the quit/window-close split main.ts stamps when it asks (audit row
  // 90), so the whole lane lives beside the close and before-quit handlers.


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
    // Audit R95: the screenshot dir took the bare, machine-shared
    // `os.tmpdir()/finevibe-screenshots` — one local `mkdir` of that name under
    // 0700 made every other user's screenshot write fail, and the dir was a
    // write-squat target. Same uid suffix + 0700 as the paste dir.
    const dir = uidScopedTempDir('finevibe-screenshots');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
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

  // Row 26 slice 6: the 13 git:* registrations live in ipc/git-domains.ts with
  // the root/file gates only they use (`requireGitRoot`, exported back here for
  // the github/readiness lanes that share the root rule). The one dep is the
  // git:changed emitter — the emitter lives in git-watcher.ts and the
  // onGitChanged(invalidateEnumerations) subscription (PA-07) stays above, in
  // this file, where the fs cache import lives.
  registerGitDomains({ notifyGitChanged });

  ipcMain.handle('pty:getCwd', (_event, sessionId: string) => getPtyCwd(sessionId));

  // Both run git in the renderer-named cwd (`git ls-files` for the readiness
  // scan, `git remote get-url` for the repo detect), so both take the same


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
    // SA-P2-5: projectPath is renderer-supplied and reaches a writer —
    // installCopilotHooks does mkdirSync+writeFileSync under it. Same
    // known-project gate as mcp:removeServer / config:watchProject: a project
    // the board never registered is refused before any provider runs.
    if (projectPath && !isWithinKnownProject(path.resolve(projectPath))) {
      console.warn(`settings:reinstall blocked: ${projectPath} is not within a known project`);
      return { success: false, error: 'Path is not within a known project' };
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
    // SA-P3: validate read and echoed (foreignStatusLineCommand) files under
    // any renderer-supplied dir — the same trust surface reinstall/decline
    // gate. Refuse out-of-scope args with the all-clear shape the validators
    // themselves return for non-applicable providers: no banner, no echo.
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      console.warn(`settings:validate refused: ${configDir} is not a managed profile directory`);
      return { statusLine: 'finevibe', hooks: 'complete', hookDetails: {} };
    }
    if (projectPath && !isWithinKnownProject(path.resolve(projectPath))) {
      console.warn(`settings:validate refused: ${projectPath} is not within a known project`);
      return { statusLine: 'finevibe', hooks: 'complete', hookDetails: {} };
    }
    const result = getProvider(providerId).validateSettings(projectPath, configDir);
    // SA-P2-1: a declined consent covering the CURRENT foreign command is the
    // user's Keep — surface it so Setup renders a neutral tier and the badge
    // stays silent, instead of a red dot + a Fix that performs the declined
    // Replace. A declined record with no recorded command freezes onto the
    // current foreign command (mirrors the settings-guard gate).
    if (result.statusLine === 'foreign') {
      const { consent, command } = getDirConsent(loadState().preferences, configDir);
      if (consent === 'declined' && (!command || command === result.foreignStatusLineCommand)) {
        return { ...result, userKeptStatusLine: true };
      }
    }
    return result;
  });

  // P1-14: for a profile session the warning banner is the single consent
  // surface (spawn is a hot path and never shows the modal). Dismissing the
  // foreign-statusLine banner is the Keep: record declined consent for that
  // dir so the per-spawn gate honors it and the banner stops re-firing.
  // Managed-dir gate mirrors pty:create / settings:reinstall; the record is
  // inert data with no filesystem effect.
  ipcMain.on('settings:declineStatusLine', safeOn('settings:declineStatusLine', (_event, configDir: string | undefined, foreignCommand: string | null) => {
    if (configDir && !isManagedMcpConfigDir(configDir)) return;
    // SA-P3: a banner dismissal with NO dir is the global ~/.claude surface —
    // recording it writes the global declined record and mutes the boot
    // consent modal, which owns global consent. The banner is the consent
    // surface only for PROFILE dirs (P1-14); a global decline goes through
    // the modal.
    if (!configDir) return;
    recordDirConsent(configDir, 'declined', foreignCommand ?? null);
  }));



  registerMcpHandlers();
}
