import { appState } from '../../../state.js';
import { createColumnElement } from '../../board/board-column.js';
import { showTaskModal } from '../../board/board-task-modal.js';
import { addDragEndCallback, initBoardDnd, isDragActive } from '../../board/board-dnd.js';
import { createWidgetEmpty } from './widget-empty.js';
import type { BoardData } from '../../../../shared/types.js';
import type { WidgetFactory } from './widget-host.js';

export const createKanbanWidget: WidgetFactory = (host) => {
  const root = document.createElement('div');
  root.className = 'widget-kanban';

  const toolbar = document.createElement('div');
  toolbar.className = 'widget-kanban-toolbar';

  const countLabel = document.createElement('span');
  countLabel.className = 'widget-kanban-count';
  toolbar.appendChild(countLabel);

  const openTabBtn = document.createElement('button');
  openTabBtn.className = 'widget-kanban-add-btn';
  openTabBtn.textContent = 'Open Kanban tab';
  openTabBtn.title = 'Open the full Kanban tab';
  openTabBtn.addEventListener('click', () => {
    appState.openKanbanTab(host.projectId);
  });
  toolbar.appendChild(openTabBtn);

  const addBtn = document.createElement('button');
  addBtn.className = 'widget-kanban-add-btn';
  addBtn.textContent = '+ Task';
  addBtn.title = 'Add a new task';
  addBtn.addEventListener('click', () => showTaskModal('create'));
  toolbar.appendChild(addBtn);

  root.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'widget-kanban-body';
  root.appendChild(body);

  function getBoardForProject(): BoardData | undefined {
    return appState.projects.find((p) => p.id === host.projectId)?.board;
  }

  let pendingRender = false;

  function render(): void {
    if (isDragActive()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;

    const board = getBoardForProject();
    body.innerHTML = '';

    if (!board || board.columns.length === 0) {
      countLabel.textContent = '';
      renderEmpty('No board yet.');
      return;
    }

    const totalTasks = board.tasks.length;
    countLabel.textContent = totalTasks === 1 ? '1 task' : `${totalTasks} tasks`;

    if (totalTasks === 0) {
      renderEmpty('No tasks yet.');
      return;
    }

    const sortedColumns = [...board.columns].sort((a, b) => a.order - b.order);
    for (const column of sortedColumns) {
      const tasksInCol = board.tasks
        .filter((t) => t.columnId === column.id)
        .sort((a, b) => a.order - b.order);

      body.appendChild(createColumnElement(column, tasksInCol));
    }
  }

  function renderEmpty(label: string): void {
    body.appendChild(createWidgetEmpty(label, 'Add a task', () => showTaskModal('create')));
  }

  // Live cost/context/status updates would mean a full re-render on every PTY
  // tick; the full kanban tab covers that. The widget only redraws on
  // structural board changes.
  const offBoard = appState.on('board-changed', () => render());

  initBoardDnd();
  const offDragEnd = addDragEndCallback(() => {
    if (pendingRender) render();
  });

  render();

  return {
    element: root,
    destroy() {
      offBoard();
      offDragEnd();
    },
    refresh() {
      render();
    },
  };
};
