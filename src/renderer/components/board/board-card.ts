import type { BoardTask } from '../../../shared/types.js';
import { appState } from '../../state.js';
import { getColumnByBehavior, updateTask, moveTask, deleteTask, getTagColor } from '../../board-state.js';
import { getStatus } from '../../session-activity.js';
import { showTaskModal } from './board-task-modal.js';
import { showContextMenu } from './board-context-menu.js';
import { showConfirmModal } from '../modal.js';
import { setPendingPrompt } from '../terminal-pane.js';

export function createCardElement(task: BoardTask): HTMLElement {
  const el = document.createElement('div');
  el.className = 'board-card';
  el.dataset.taskId = task.id;
  el.draggable = true;

  // Top row: title + action button
  const topRow = document.createElement('div');
  topRow.className = 'board-card-top';

  const titleEl = document.createElement('div');
  titleEl.className = 'board-card-title';
  titleEl.textContent = task.title || truncate(task.prompt, 60) || 'Untitled';

  const runBtn = document.createElement('button');
  runBtn.className = 'card-run-btn';
  const hasActiveSession = !!task.sessionId;
  const canResume = !hasActiveSession && !!task.cliSessionId;
  runBtn.title = hasActiveSession ? 'Focus session' : canResume ? 'Resume' : 'Run';
  runBtn.textContent = hasActiveSession ? '>>>' : canResume ? '\u21BB' : '\u25B6';
  runBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runTask(task);
  });

  topRow.appendChild(titleEl);
  topRow.appendChild(runBtn);
  el.appendChild(topRow);

  // Tags row (if any)
  if (task.tags && task.tags.length > 0) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'board-card-tags';
    const maxVisible = 3;
    const visibleTags = task.tags.slice(0, maxVisible);
    for (const tagName of visibleTags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill tag-pill-sm';
      pill.dataset.color = getTagColor(tagName);
      pill.textContent = tagName;
      tagsEl.appendChild(pill);
    }
    if (task.tags.length > maxVisible) {
      const more = document.createElement('span');
      more.className = 'tag-pill-overflow';
      more.textContent = `+${task.tags.length - maxVisible}`;
      tagsEl.appendChild(more);
    }
    el.appendChild(tagsEl);
  }

  if (task.sessionId) {
    const status = getStatus(task.sessionId);
    if (status) {
      const bottomRow = document.createElement('div');
      bottomRow.className = 'board-card-bottom';

      const statusEl = document.createElement('span');
      statusEl.className = 'board-card-status-inline';
      const dot = document.createElement('span');
      dot.className = `card-status-dot ${status}`;
      const statusLabels: Record<string, string> = {
        working: 'Working',
        waiting: 'Waiting',
        'prompt-waiting': 'Waiting',
        idle: 'Idle',
        completed: 'Done',
        input: 'Input',
      };
      statusEl.appendChild(dot);
      statusEl.appendChild(document.createTextNode(statusLabels[status] ?? status));
      bottomRow.appendChild(statusEl);
      el.appendChild(bottomRow);
    }
  }

  // Click card body -> edit modal
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    showTaskModal('edit', task);
  });

  // Right-click -> context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Edit', action: () => showTaskModal('edit', task) },
      { label: 'Delete', danger: true, action: () => confirmDeleteTask(task) },
    ]);
  });

  return el;
}

function confirmDeleteTask(task: BoardTask): void {
  const label = task.title || task.prompt.slice(0, 40) || 'this task';
  showConfirmModal(
    'Delete Task',
    `Are you sure you want to delete "${label}"? This cannot be undone.`,
    () => deleteTask(task.id),
  );
}


export function runTask(task: BoardTask): void {
  const project = appState.activeProject;
  if (!project) return;

  // If task has active session, just focus it
  if (task.sessionId) {
    focusTaskSession(task);
    return;
  }

  let resumed = false;

  // Try to resume from cliSessionId
  if (task.cliSessionId) {
    const existingSession = project.sessions.find(s => s.cliSessionId === task.cliSessionId);
    if (existingSession) {
      appState.setActiveSession(project.id, existingSession.id);
      updateTask(task.id, { sessionId: existingSession.id });
      resumed = true;
    } else {
      const archived = project.sessionHistory?.find(a => a.cliSessionId === task.cliSessionId);
      if (archived) {
        const session = appState.resumeFromHistory(project.id, archived.id);
        if (session) {
          updateTask(task.id, { sessionId: session.id });
          resumed = true;
        }
      }
    }
  }

  // Fallback: spawn a fresh session
  if (!resumed) {
    if (!task.prompt.trim()) {
      showTaskModal('edit', task);
      return;
    }
    const sessionName = task.title || task.prompt.slice(0, 40);
    const session = task.planMode
      ? appState.addPlanSession(project.id, sessionName, true, task.providerId)
      : appState.addSession(project.id, sessionName, undefined, task.providerId);
    if (session) {
      updateTask(task.id, { sessionId: session.id });
      const activeCol = getColumnByBehavior('active');
      if (activeCol && task.columnId !== activeCol.id) {
        moveTask(task.id, activeCol.id, 0);
      }
      // Set prompt on the terminal instance — it will be passed as a
      // CLI startup argument when spawnTerminal runs (via requestAnimationFrame)
      if (task.prompt.trim()) {
        setPendingPrompt(session.id, task.prompt);
      }
    }
  }
}

export function focusTaskSession(task: BoardTask): void {
  const project = appState.activeProject;
  if (!project || !task.sessionId) return;
  appState.setActiveSession(project.id, task.sessionId);
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  const firstLine = str.split('\n')[0];
  return firstLine.length > len ? firstLine.slice(0, len) + '...' : firstLine;
}
