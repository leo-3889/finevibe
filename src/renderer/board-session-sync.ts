import { appState } from './state.js';
import { onChange as onStatusChange } from './session-activity.js';
import { getTaskBySessionId, moveTask, updateTask, getColumnByBehavior } from './board-state.js';
import type { BoardTask } from '../shared/types.js';

function moveTaskToDone(task: BoardTask, projectId: string): void {
  const doneCol = getColumnByBehavior('terminal', projectId);
  if (doneCol && task.columnId !== doneCol.id) {
    moveTask(task.id, doneCol.id, 0, projectId);
  }
}

/**
 * sessionId → last-seen cliSessionId. Payload-less `session-changed` fires on every
 * activation (sidebar.ts documents this event's fan-out cost); the snapshot lets the
 * handler diff the session list and touch only the tasks whose session actually
 * gained a CLI session id, instead of scanning every project × every board task.
 */
let cliSessionSnapshot = new Map<string, string>();

function buildCliSessionSnapshot(): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const project of appState.projects) {
    for (const session of project.sessions) {
      snapshot.set(session.id, session.cliSessionId || '');
    }
  }
  return snapshot;
}

/** Persist a session's CLI session id onto the board task that references it. */
function syncTaskCliSessionId(sessionId: string): void {
  const found = appState.findSessionWithProject(sessionId);
  if (!found) return;
  const task = getTaskBySessionId(sessionId, found.project.id);
  const cliSessionId = found.session.cliSessionId;
  if (task && cliSessionId && task.cliSessionId !== cliSessionId) {
    updateTask(task.id, { cliSessionId }, found.project.id);
  }
}

/** Full project × task scan — used when session membership changes — plus snapshot reseed. */
function fullScanSync(): void {
  for (const project of appState.projects) {
    if (!project.board) continue;
    for (const task of project.board.tasks) {
      if (!task.sessionId) continue;
      const session = project.sessions.find(s => s.id === task.sessionId);
      if (session?.cliSessionId && task.cliSessionId !== session.cliSessionId) {
        updateTask(task.id, { cliSessionId: session.cliSessionId }, project.id);
      }
    }
  }
  cliSessionSnapshot = buildCliSessionSnapshot();
}

export function initBoardSessionSync(): void {
  cliSessionSnapshot = buildCliSessionSnapshot();

  onStatusChange((sessionId, status) => {
    if (status !== 'completed') return;
    for (const project of appState.projects) {
      const task = getTaskBySessionId(sessionId, project.id);
      if (task) moveTaskToDone(task, project.id);
    }
  });

  appState.on('session-removed', (data) => {
    const { projectId, sessionId, deferRender } = data as { projectId: string; sessionId: string; deferRender?: boolean };
    const task = getTaskBySessionId(sessionId, projectId);
    if (task) {
      updateTask(task.id, { sessionId: undefined }, projectId);
    }
    // C2R-14: batch closes (Close All / removeAllSessions) mark every
    // per-session event `deferRender`. The detach above is what the event is
    // for and stays; the full project × task scan is the N-per-batch cost, and
    // the batch's trailing `session-changed` kick diffs the survivors once.
    if (deferRender) return;
    fullScanSync();
  });

  appState.on('session-added', () => {
    fullScanSync();
  });

  // When CLI session ID is assigned → persist it on the task. Use the event payload
  // when present; on a payload-less event (activation, CLI id assignment, …) diff
  // against the snapshot and touch only changed sessions — two payload-less events
  // with no session change in between write zero task rows.
  appState.on('session-changed', (data) => {
    const { sessionId } = (data ?? {}) as { sessionId?: string };
    if (sessionId) {
      const found = appState.findSessionWithProject(sessionId);
      cliSessionSnapshot.set(sessionId, found?.session.cliSessionId || '');
      syncTaskCliSessionId(sessionId);
      return;
    }
    const next = buildCliSessionSnapshot();
    for (const [id, cliSessionId] of next) {
      if (cliSessionId && cliSessionSnapshot.get(id) !== cliSessionId) {
        syncTaskCliSessionId(id);
      }
    }
    cliSessionSnapshot = next;
  });
}
