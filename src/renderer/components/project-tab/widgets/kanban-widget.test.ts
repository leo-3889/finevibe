// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { WidgetHost } from './widget-host.js';

// Same card-render graph mocks as board/board-view.test.ts: the widget renders
// through createColumnElement and shares board-view's change key.
vi.mock('../../board/board-task-modal.js', () => ({ showTaskModal: vi.fn() }));
vi.mock('../../board/board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('../../modal.js', () => ({ showConfirmModal: vi.fn() }));
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

import { appState, _resetForTesting } from '../../../state.js';
import { addTask, updateTask } from '../../../board-state.js';
import { createKanbanWidget } from './kanban-widget.js';

function setup(): WidgetHost {
  _resetForTesting();
  document.body.innerHTML = '';
  (window as unknown as { finevibe: unknown }).finevibe = {
    store: { load: vi.fn(async () => null), save: vi.fn() },
  };
  const project = appState.addProject('Test', '/test');
  project.board = {
    columns: [
      { id: 'col-a', title: 'Backlog', order: 0, behavior: 'inbox' },
      { id: 'col-b', title: 'Active', order: 1, behavior: 'active' },
    ],
    tasks: [],
  };
  return { projectId: project.id } as WidgetHost;
}

describe('kanban-widget change key (C2R-15)', () => {
  it('keeps its DOM when board-changed carries no visible change', () => {
    const host = setup();
    const task = addTask({ title: 'T', prompt: 'p', columnId: 'col-a' })!;
    const widget = createKanbanWidget(host);
    const column = widget.element.querySelector('.board-column');
    expect(column).not.toBeNull();

    // board-changed fires on every mutation, and updateTask emits even for a
    // write that changes nothing a rebuild could show (updatedAt is not in the
    // key). The wipe used to rebuild every column for it.
    updateTask(task.id, { title: 'T' });
    expect(widget.element.querySelector('.board-column')).toBe(column);
  });

  it('rebuilds when the key changes', () => {
    const host = setup();
    const task = addTask({ title: 'T', prompt: 'p', columnId: 'col-a' })!;
    const widget = createKanbanWidget(host);
    const column = widget.element.querySelector('.board-column');

    updateTask(task.id, { title: 'Renamed' });
    expect(widget.element.querySelector('.board-column')).not.toBe(column);
    expect(widget.element.textContent).toContain('Renamed');
  });

  it('renders the empty state on a board-less first render (key is "")', () => {
    const host = setup();
    appState.projects[0].board = undefined;
    const widget = createKanbanWidget(host);
    expect(widget.element.textContent).toContain('No board yet.');
  });
});
