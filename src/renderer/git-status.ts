import { appState } from './state.js';
import { onChange as onStatusChange } from './session-activity.js';
import type { GitWorktree } from './types.js';

export interface GitStatus {
  isGitRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
}

type GitStatusCallback = (projectId: string, status: GitStatus) => void;
type WorktreeChangeCallback = () => void;

const cache = new Map<string, GitStatus>();
const listeners: GitStatusCallback[] = [];
const worktreeChangeListeners: WorktreeChangeCallback[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
// Set when poll() is called while a poll is already in flight. The running
// poll loops once more so a request triggered mid-flight (e.g. a project
// switch) is never silently dropped — it re-reads the now-active project.
let repollRequested = false;

// Worktree cache: projectId → GitWorktree[]
const worktreeCache = new Map<string, GitWorktree[]>();
// Session → worktree path mapping
const sessionWorktreeMap = new Map<string, string>();
// Manual override: projectId → worktree path
const manualOverride = new Map<string, string>();
let worktreePollCounter = 0;
let unwatchGitChanged: (() => void) | null = null;
// PA-10: session-changed fires on every tab click / title / CLI-id adoption.
// Trailing-debounce the session-driven poll and skip it when the
// (project, worktree, session) key is unchanged from the last fetch — an
// adoption touches no git state at all.
const SESSION_POLL_DEBOUNCE_MS = 300;
let sessionPollTimer: ReturnType<typeof setTimeout> | null = null;
let lastFetchKey = '';

/** (project, worktree) identity of what a poll() would fetch.
 *  S3-04: the session id used to be part of the key — and the trigger
 *  PA-10 names (a tab click) changes exactly that component, so the
 *  dedupe guard never fired for clicks and every click paid a git
 *  status spawn (+ getCwd, + getWorktrees every 3rd pass). Git status is
 *  a pure function of (project, worktree): worktree switches change
 *  gitPath (detectSessionWorktree), so they still poll. */
function sessionPollKey(): string {
  const project = appState.activeProject;
  if (!project) return '';
  return `${project.id}|${getActiveGitPath(project.id)}`;
}

async function refreshWorktrees(projectId: string, projectPath: string): Promise<void> {
  try {
    const worktrees = await window.finevibe.git.getWorktrees(projectPath) as GitWorktree[];
    const prev = worktreeCache.get(projectId);
    worktreeCache.set(projectId, worktrees);

    // Clean up manual overrides pointing to deleted worktrees
    const override = manualOverride.get(projectId);
    if (override && !worktrees.some(w => w.path === override)) {
      manualOverride.delete(projectId);
    }

    const serialized = JSON.stringify(worktrees);
    if (!prev || JSON.stringify(prev) !== serialized) {
      for (const cb of worktreeChangeListeners) cb();
    }
  } catch {
    // Ignore errors
  }
}

async function detectSessionWorktree(sessionId: string): Promise<void> {
  const project = appState.activeProject;
  if (!project) return;

  // C2R-06: the cached worktree list is the local, cheap bail — a plain repo
  // (no worktree cache yet, or a single worktree) is the overwhelming
  // majority of sessions, and the old order paid a getCwd IPC round trip per
  // event before discarding the result.
  const worktrees = worktreeCache.get(project.id);
  if (!worktrees || worktrees.length <= 1) return;

  try {
    const cwd = await window.finevibe.pty.getCwd(sessionId);
    if (!cwd) return;

    // Find which worktree the cwd falls under (longest path match)
    let bestMatch = '';
    for (const wt of worktrees) {
      if ((cwd === wt.path || cwd.startsWith(`${wt.path}/`)) && wt.path.length > bestMatch.length) {
        bestMatch = wt.path;
      }
    }

    if (bestMatch) {
      const prev = sessionWorktreeMap.get(sessionId);
      sessionWorktreeMap.set(sessionId, bestMatch);
      if (prev !== bestMatch) {
        for (const cb of worktreeChangeListeners) cb();
      }
    }
  } catch {
    // Ignore errors
  }
}

async function poll(): Promise<void> {
  if (!appState.activeProject) return;
  // S3-07: the 60 s interval was the only gated entry point — the main-side
  // git push (the dominant source while agents edit files) and the
  // working->waiting status transitions called poll() from a hidden window,
  // spawning `git status` indefinitely. visibilitychange already runs
  // startInterval() -> poll() on the return to visible, so dropping the
  // hidden pass loses nothing.
  if (document.hidden) return;
  // A poll is already running. Flag a re-poll so it picks up the latest active
  // project when it finishes, instead of dropping this request on the floor.
  if (polling) {
    repollRequested = true;
    return;
  }

  polling = true;
  try {
    do {
      repollRequested = false;

      // Re-read each iteration: the active project may have changed while the
      // previous iteration was awaiting (that's why we looped).
      const project = appState.activeProject;
      if (!project) break;

      // Refresh worktree list every 3rd poll (~30s)
      worktreePollCounter++;
      if (worktreePollCounter % 3 === 1) {
        await refreshWorktrees(project.id, project.path);
      }

      // Detect active session's worktree
      const activeSession = appState.activeSession;
      if (activeSession && activeSession.type !== 'diff-viewer' && activeSession.type !== 'file-reader' && activeSession.type !== 'mcp-inspector') {
        await detectSessionWorktree(activeSession.id);
      }

      // Query git status using the resolved worktree path
      // PA-10: record what this fetch covered, so the session-changed
      // debounce can skip a poll that would ask for the same thing.
      const gitPath = getActiveGitPath(project.id);
      // S3-04: same (project, worktree) key as sessionPollKey() — the
      // session component here made the skip guard un-hittable on tab
      // clicks (the click changes the session, so old key != new key).
      lastFetchKey = `${project.id}|${gitPath}`;
      const status = await window.finevibe.git.getStatus(gitPath) as GitStatus;
      const cacheKey = `${project.id}:${gitPath}`;
      const prev = cache.get(cacheKey);
      cache.set(cacheKey, status);
      // Also set by projectId for backward compatibility
      cache.set(project.id, status);

      if (!prev || JSON.stringify(prev) !== JSON.stringify(status)) {
        for (const cb of listeners) cb(project.id, status);
      }
    } while (repollRequested);
  } catch {
    // Ignore errors
  } finally {
    polling = false;
  }
}

export function getGitStatus(projectId: string): GitStatus | null {
  return cache.get(projectId) ?? null;
}

/** Total uncommitted changes for a project, or null when it's not a git repo. */
export function gitChangeCount(projectId: string): number | null {
  const status = getGitStatus(projectId);
  if (!status || !status.isGitRepo) return null;
  return status.staged + status.modified + status.untracked + status.conflicted;
}

export function getWorktrees(projectId: string): GitWorktree[] | null {
  return worktreeCache.get(projectId) ?? null;
}

export function getActiveGitPath(projectId: string): string {
  // Manual override takes precedence
  const override = manualOverride.get(projectId);
  if (override) return override;

  // Check active session's worktree
  const project = appState.projects.find(p => p.id === projectId);
  if (project?.activeSessionId) {
    const sessionWt = sessionWorktreeMap.get(project.activeSessionId);
    if (sessionWt) return sessionWt;
  }

  // Fallback to project path
  return project?.path ?? '';
}

export function setActiveWorktree(projectId: string, path: string | null): void {
  if (path) {
    manualOverride.set(projectId, path);
  } else {
    manualOverride.delete(projectId);
  }
  // Trigger refresh
  poll();
  for (const cb of worktreeChangeListeners) cb();
}

export { poll as refreshGitStatus };

export function onChange(callback: GitStatusCallback): void {
  listeners.push(callback);
}

export function onWorktreeChange(callback: WorktreeChangeCallback): void {
  worktreeChangeListeners.push(callback);
}

function startInterval(): void {
  if (pollTimer) return; // Already polling
  if (document.hidden || !appState.activeProject) return; // No reason to poll
  poll();
  pollTimer = setInterval(poll, 60_000);
}

function stopInterval(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function startPolling(): void {
  startInterval();

  // Subscribe to main-process file system watcher push events (once)
  if (!unwatchGitChanged) {
    unwatchGitChanged = window.finevibe.git.onChanged(() => poll());
  }

  // Start watcher for current project
  if (appState.activeProject) {
    window.finevibe.git.watchProject(appState.activeProject.path);
  }

  // Pause/resume when window visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopInterval();
    } else {
      startInterval();
    }
  });

  // Watch + poll the active project, or stop when there is none. Fired on
  // project switch and on initial load — 'state-loaded' matters because a bare
  // project (active project, no session) emits only that event, so without it
  // the git panel would stay hidden until a session starts.
  const onActiveProjectChanged = () => {
    worktreePollCounter = 0; // Force worktree refresh on project switch
    if (!appState.activeProject) {
      stopInterval();
      return;
    }
    window.finevibe.git.watchProject(appState.activeProject.path);
    startInterval(); // ensure the periodic timer is running
    poll(); // immediate refresh — startInterval() no-ops when a timer already exists
  };
  appState.on('state-loaded', onActiveProjectChanged);
  appState.on('project-changed', onActiveProjectChanged);
  appState.on('session-added', () => poll());
  // Drop the session→worktree mapping when a session closes (the map would
  // otherwise grow by one entry per session ever run, for the app's lifetime).
  appState.on('session-removed', (data) => {
    const sessionId = (data as { sessionId?: string })?.sessionId;
    if (sessionId) sessionWorktreeMap.delete(sessionId);
  });
  // Prune the per-project caches when a project is removed (they would
  // otherwise grow by one entry per project ever opened, for the app's lifetime).
  appState.on('project-removed', (data) => {
    const projectId = typeof data === 'string' ? data : undefined;
    if (projectId) {
      // C2R-05: poll() writes two keys — the plain projectId (the legacy
      // accessor) and the composite `${projectId}:${gitPath}`. Deleting only
      // the plain key leaked one composite entry per worktree ever polled.
      for (const key of cache.keys()) {
        if (key === projectId || key.startsWith(`${projectId}:`)) cache.delete(key);
      }
      worktreeCache.delete(projectId);
    }
  });

  // Detect worktree on session change
  appState.on('session-changed', (data) => {
    // C2R-03: a manual worktree choice is a user decision, and only an actual
    // activation invalidates it. Auto-title and CLI-id adoption fan out as
    // 'metadata' and used to wipe the override on every one of them, snapping
    // the panel back to the auto-detected worktree. Payload-less events keep
    // the defensive full path.
    const payload = data as { kind?: string } | null | undefined;
    const project = appState.activeProject;
    if (project && (!payload?.kind || payload.kind === 'activate')) {
      manualOverride.delete(project.id);
    }
    // PA-10: every tab click / adoption used to fan out into 2–4 IPCs + git
    // spawns. Coalesce a burst into one trailing poll, and drop it when the
    // (project, worktree, session) triple is what the last fetch already read.
    // C2R-06: the worktree detection rides the same trailing edge, so a burst
    // of clicks detects once, for the FINAL active session.
    if (sessionPollTimer) clearTimeout(sessionPollTimer);
    sessionPollTimer = setTimeout(() => {
      sessionPollTimer = null;
      void (async () => {
        const activeSession = appState.activeSession;
        if (activeSession && activeSession.type !== 'diff-viewer' && activeSession.type !== 'file-reader' && activeSession.type !== 'mcp-inspector') {
          await detectSessionWorktree(activeSession.id);
        }
        // The detection can move the active worktree, so the poll key is only
        // trustworthy once it has settled.
        const key = sessionPollKey();
        if (key && key === lastFetchKey) return;
        poll();
      })();
    }, SESSION_POLL_DEBOUNCE_MS);
  });
  // Poll when a session transitions from working → waiting/completed
  onStatusChange((_sessionId, status) => {
    if (status === 'waiting' || status === 'completed') {
      // Also re-detect worktree on status transition
      detectSessionWorktree(_sessionId);
      poll();
    }
  });
}

export function stopPolling(): void {
  stopInterval();
}

// Test-only: clear all module-level state so each test starts from a clean
// slate (the production module is a long-lived singleton).
export function _resetForTesting(): void {
  stopInterval();
  polling = false;
  repollRequested = false;
  worktreePollCounter = 0;
  unwatchGitChanged = null;
  cache.clear();
  worktreeCache.clear();
  sessionWorktreeMap.clear();
  manualOverride.clear();
  listeners.length = 0;
  worktreeChangeListeners.length = 0;
  if (sessionPollTimer) clearTimeout(sessionPollTimer);
  sessionPollTimer = null;
  lastFetchKey = '';
}
