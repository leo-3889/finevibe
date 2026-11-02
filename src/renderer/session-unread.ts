import { appState } from './state.js';
import { onChange as onStatusChange, type SessionStatus } from './session-activity.js';

type UnreadChangeCallback = () => void;

const unreadSessions = new Set<string>();
const listeners: UnreadChangeCallback[] = [];
const prevStatus = new Map<string, SessionStatus>();
let readPending = false;
// PA-11: N background→completed transitions land in one status burst; without
// coalescing each one rebuilt the sidebar project list AND the tab strip (2N
// full rebuilds during terminal paint). One listener pass per frame.
let notifyScheduled = false;
// Todo #44: rAF is the coalescer, not the delivery guarantee. A page that is not
// painting (minimized, hidden, occluded — exactly where notifications arrive)
// queues rAF callbacks and never runs them, so the set changed and nobody was
// told: the tab dots, sidebar accent and swarm dots kept rendering the last
// frame's count. The timer is the net; `flushListeners` runs one pass per
// schedule, so the frame path stays the common one and a burst is still one pass.
const NOTIFY_FALLBACK_MS = 32;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function flushListeners(): void {
  if (!notifyScheduled) return; // the other source already ran this pass
  notifyScheduled = false;
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  // Snapshot: a subscriber that unsubscribes during the pass (panel teardown
  // off a mutation) must not splice a later listener out of the live array
  // (review 24db32b8 #5).
  for (const cb of [...listeners]) cb();
}

function notify(): void {
  // rAF coalescing pattern (active-sessions-panel.ts): burst → one rebuild/frame.
  if (notifyScheduled) return;
  notifyScheduled = true;
  requestAnimationFrame(flushListeners);
  notifyTimer = setTimeout(flushListeners, NOTIFY_FALLBACK_MS);
}

/**
 * Read transitions bypass the frame wait: the sidebar renders synchronously on
 * `project-changed`, so deferring past paint would show the accent colour and
 * then remove it (the microtask contract of markActiveSessionRead). Listeners
 * re-derive everything from state, so one synchronous pass also absorbs any
 * pending coalesced transition pass.
 */
function notifyNow(): void {
  // UNCONDITIONAL delivery: a read can land when no pass is scheduled at all
  // (a lone background transition long ago), and this is that delete's only
  // delivery - gating on notifyScheduled left the sidebar accent lit until the
  // next unrelated transition (review 24db32b8). Absorbs any pending pass.
  notifyScheduled = false;
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  for (const cb of listeners) cb();
}

/**
 * The focused session has been seen — drop it from the unread set.
 *
 * Deferred by a microtask because switching projects is a *sequence*, not one
 * event: callers do `setActiveProject` then activate a session (e.g. the Active
 * Sessions panel). Reading `activeSessionId` the instant `project-changed` fires
 * would see the target project's PREVIOUS session and clear an unread badge the
 * user never saw; one microtask later the sequence has settled. It must be a
 * microtask and not rAF — the sidebar renders synchronously on `project-changed`,
 * so deferring past paint would show the accent colour and then remove it.
 * The latch keeps a burst (`stepNav` emits both events) to one scheduled pass.
 */
function markActiveSessionRead(): void {
  if (readPending) return;
  readPending = true;
  queueMicrotask(() => {
    readPending = false;
    const sessionId = appState.activeProject?.activeSessionId;
    if (!sessionId) return;
    // PA-11: a read must land before paint, not on the transition frame.
    if (unreadSessions.delete(sessionId)) notifyNow();
  });
}

export function init(): void {
  onStatusChange((sessionId, status) => {
    const prev = prevStatus.get(sessionId);
    prevStatus.set(sessionId, status);

    if (prev === 'working' && (status === 'waiting' || status === 'completed' || status === 'input')) {
      // Find which project this session belongs to
      const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
      // "Focused", not "visible": a dimmed swarm pane is on screen but still counts
      // as unread — split-layout renders `swarm-unread` on exactly those panes.
      const isFocusedSession =
        project?.id === appState.activeProjectId && sessionId === project?.activeSessionId;
      if (project && !isFocusedSession) {
        unreadSessions.add(sessionId);
        notify();
      }
    }
  });

  // `session-changed` covers tab clicks and Cmd+1..9. `project-changed` is just as
  // load-bearing: clicking a project in the sidebar brings that project's active
  // session on screen without ever touching activeSessionId, so it emits no
  // `session-changed` — and the session it reveals renders no unread tab dot
  // (tab-list masks the active tab), leaving the sidebar project name accent-coloured
  // with no click left that could clear it.
  appState.on('session-changed', markActiveSessionRead);
  appState.on('project-changed', markActiveSessionRead);

  appState.on('session-removed', (data?: unknown) => {
    const d = data as { sessionId?: string } | undefined;
    if (d?.sessionId) {
      removeSession(d.sessionId);
    }
  });
}

export function isUnread(sessionId: string): boolean {
  return unreadSessions.has(sessionId);
}

export function hasUnreadInProject(projectId: string): boolean {
  const project = appState.projects.find(p => p.id === projectId);
  if (!project) return false;
  return project.sessions.some(s => unreadSessions.has(s.id));
}

export function removeSession(sessionId: string): void {
  if (unreadSessions.delete(sessionId)) {
    prevStatus.delete(sessionId);
    notify();
  } else {
    prevStatus.delete(sessionId);
  }
}

export function onChange(callback: UnreadChangeCallback): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  unreadSessions.clear();
  listeners.length = 0;
  prevStatus.clear();
  readPending = false;
  notifyScheduled = false;
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}
