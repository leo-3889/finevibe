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

// UI3-10: only addTag is stubbed — the change-key tests above rely on the real
// board-state (addTask/updateTask/board-changed), so the rest is spread through.
const mockAddTag = vi.hoisted(() => vi.fn());
vi.mock('../../board-state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../board-state.js')>();
  return { ...actual, addTag: mockAddTag };
});

import { appState, _resetForTesting } from '../../state.js';
import { addTask, updateTask } from '../../board-state.js';
import { initBoard, renderBoard, resetBoardView, resetBoardViewIf } from './board-view.js';
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

describe('board-view inline tag input (UI3-10)', () => {
  // Nothing clears mocks in this file and the hoisted addTag spy outlives the
  // tests above — count commits per test.
  beforeEach(() => mockAddTag.mockClear());

  // The "+" button only renders when the board has tags, so seed one.
  function openTagInput(): { container: HTMLElement; input: HTMLInputElement } {
    const container = setupKanban();
    appState.activeProject!.board!.tags = [{ name: 'existing', color: 'blue' }];
    initBoard();
    renderBoard();
    (container.querySelector('.board-tag-row-add') as HTMLButtonElement).click();
    return { container, input: container.querySelector('.board-tag-row-input') as HTMLInputElement };
  }

  function key(input: HTMLInputElement, keyName: string): void {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
  }

  // jsdom does not fire blur when a focused element is removed; a browser does,
  // and that blur is the whole UI3-10 bug — dispatch it the way the browser does.
  function blur(input: HTMLInputElement): void {
    input.dispatchEvent(new window.Event('blur'));
  }

  it('Escape discards the half-typed tag instead of committing it', () => {
    const { container, input } = openTagInput();
    input.value = 'half';

    key(input, 'Escape');
    blur(input);

    expect(mockAddTag).not.toHaveBeenCalled();
    expect(container.querySelector('.board-tag-row-input')).toBeNull();
  });

  it('Enter commits the tag exactly once', () => {
    const { container, input } = openTagInput();
    input.value = 'full';

    key(input, 'Enter');
    blur(input);

    expect(mockAddTag).toHaveBeenCalledTimes(1);
    expect(mockAddTag).toHaveBeenCalledWith('full');
    expect(container.querySelector('.board-tag-row-input')).toBeNull();
  });

  it('a board-changed rebuild wipes the row without committing what was typed', () => {
    const { container, input } = openTagInput();
    input.value = 'typing';

    // A real board change: the board-changed subscription calls renderBoard,
    // whose renderTagRow() clears the row under the focused input.
    addTask({ title: 'T', prompt: 'p', columnId: 'col-b' });
    blur(input);

    expect(mockAddTag).not.toHaveBeenCalled();
    expect(container.querySelector('.board-tag-row-input')).toBeNull();
  });
});

describe('board-view singleton reset (C2R-16)', () => {
  it('rebuilds for a new pane instead of reviving the detached tree', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // The pane that owned the singleton is destroyed and the board is
    // unchanged: without the reset both the retained element and the last
    // change key short-circuit the next pane's render (and the per-tick
    // status/cost patches keep scanning the detached tree meanwhile).
    kanbanInstances.clear();
    document.body.innerHTML = '';
    resetBoardView();

    const next = document.createElement('div');
    document.body.appendChild(next);
    kanbanInstances.set('kb-1', {
      sessionId: 'kb-1',
      projectId: appState.activeProject!.id,
      element: next,
      destroy: () => {},
    });
    renderBoard();

    const rebuilt = next.querySelector('.board-card');
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toBe(card);
  });
});

describe('board-view conditional reset (C3R-04)', () => {
  it('leaves the singleton intact when a non-owning pane is destroyed', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // destroyKanbanPane() of a BACKGROUND project's pane: its element never
    // owned the board, so the visible pane's singleton must survive.
    const foreign = document.createElement('div');
    document.body.appendChild(foreign);
    resetBoardViewIf(foreign);

    renderBoard();
    expect(container.querySelector('.board-card')).toBe(card);
  });

  it('clears the singleton when the owning pane is destroyed', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // instance.destroy() detaches the pane element (board subtree travels
    // with it), then destroyKanbanPane resets through the conditional form.
    container.remove();
    resetBoardViewIf(container);

    const next = document.createElement('div');
    document.body.appendChild(next);
    kanbanInstances.set('kb-1', {
      sessionId: 'kb-1',
      projectId: appState.activeProject!.id,
      element: next,
      destroy: () => {},
    });
    renderBoard();

    const rebuilt = next.querySelector('.board-card');
    expect(rebuilt).not.toBeNull();
    expect(rebuilt).not.toBe(card);
  });
});
