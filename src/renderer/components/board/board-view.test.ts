// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors board-card.test.ts mocks (the card-render graph) plus the
// jsdom harness of board-dnd.test.ts: real state/board-state, real DOM.
vi.mock('./board-task-modal.js', () => ({ showTaskModal: vi.fn() }));
vi.mock('./board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('../modal.js', () => ({ showConfirmModal: vi.fn() }));
vi.mock('../terminal-pane.js', () => ({ setPendingPrompt: vi.fn() }));
vi.mock('../../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(),
  hasMultipleAvailableProviders: vi.fn(() => false),
}));
vi.mock('../../session-activity.js', () => ({
  getStatus: vi.fn(() => null),
  onChange: vi.fn(() => () => {}),
  STATUS_GLYPH: { working: '\u25C6', idle: '\u25C7', error: '\u25CF' },
}));
vi.mock('../../session-cost.js', () => ({
  getCost: vi.fn(() => null),
  onChange: vi.fn(() => () => {}),
  restoreCost: vi.fn(),
  formatTokens: (n: number) => String(n),
}));
vi.mock('../../session-context.js', () => ({
  getContext: vi.fn(() => null),
  onChange: vi.fn(() => () => {}),
  restoreContext: vi.fn(),
  getContextSeverity: () => '',
}));

import { appState, _resetForTesting } from '../../state.js';
import { addTask, updateTask } from '../../board-state.js';
import { initBoard, renderBoard } from './board-view.js';
import { instances as kanbanInstances } from '../kanban/instance.js';

function setupKanban(): HTMLElement {
  _resetForTesting();
  document.body.innerHTML = '';
  kanbanInstances.clear();
  (window as unknown as { finevibe: unknown }).finevibe = {
    store: { load: vi.fn(async () => null), save: vi.fn() },
  };
  const project = appState.addProject('Test', '/test');
  project.board = {
    columns: [
      { id: 'col-a', title: 'Backlog', order: 0, behavior: 'inbox' },
      { id: 'col-b', title: 'Active', order: 1, behavior: 'active' },
      { id: 'col-c', title: 'Done', order: 2, behavior: 'terminal' },
    ],
    tasks: [],
  };
  // Kanban tab active (isKanbanActive gate of the board-changed subscription)
  // with its instance element as the untargeted renderBoard() container.
  project.sessions.push({ id: 'kb-1', name: 'Kanban', type: 'kanban' } as never);
  project.activeSessionId = 'kb-1';
  const container = document.createElement('div');
  document.body.appendChild(container);
  kanbanInstances.set('kb-1', {
    sessionId: 'kb-1',
    projectId: project.id,
    element: container,
    destroy: () => {},
  });
  return container;
}

describe('board-view change key (S4-02)', () => {
  it('updates the card text when a task title changes through board-changed', () => {
    const container = setupKanban();
    const task = addTask({ title: 'Old title', prompt: 'p', columnId: 'col-a' })!;
    initBoard();
    renderBoard();
    expect(container.querySelector('.board-card-title')!.textContent).toBe('Old title');

    updateTask(task.id, { title: 'New title' }); // fires board-changed → renderBoard
    expect(container.querySelector('.board-card-title')!.textContent).toBe('New title');
  });

  it('updates the run/resume glyph when sessionId/cliSessionId change through board-changed', () => {
    const container = setupKanban();
    const task = addTask({ title: 'T', prompt: 'p', columnId: 'col-a' })!;
    initBoard();
    renderBoard();
    // Plain run glyph: no session, no resume target.
    expect(container.querySelector('.card-run-btn')!.textContent).toBe('\u25B6');

    // S4-02: the key used to omit sessionId/cliSessionId, so the run/resume
    // state (written by runTask/board-session-sync) stayed invisible until an
    // unrelated structural change moved a card.
    updateTask(task.id, { sessionId: 'sess-1' });
    expect(container.querySelector('.card-run-btn')!.textContent).toBe('>>>');

    updateTask(task.id, { sessionId: undefined });
    updateTask(task.id, { cliSessionId: 'cli-1' });
    expect(container.querySelector('.card-run-btn')!.textContent).toBe('\u21BB');
  });
});
