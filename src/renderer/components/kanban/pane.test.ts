// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pane only orchestrates the shell + board-view; stub the board so the
// suite stays about the pane's own wiring (row 28: shell extraction).
vi.mock('../board/board-view.js', () => ({
  renderBoard: vi.fn(),
  hideBoardView: vi.fn(),
  resetBoardViewIf: vi.fn(),
}));

import { renderBoard, hideBoardView, resetBoardViewIf } from '../board/board-view.js';
import { instances, getKanbanInstance } from './instance.js';
import {
  createKanbanPane,
  attachKanbanToContainer,
  showKanbanPane,
  hideAllKanbanPanes,
  destroyKanbanPane,
} from './pane.js';

const board = {
  render: renderBoard as ReturnType<typeof vi.fn>,
  hideAll: hideBoardView as ReturnType<typeof vi.fn>,
  reset: resetBoardViewIf as ReturnType<typeof vi.fn>,
};

beforeEach(() => {
  instances.clear();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('kanban pane (shared tab-pane shell)', () => {
  it('creates one hidden pane element per session, keyed by session id', () => {
    createKanbanPane('s1', 'p1');
    const first = getKanbanInstance('s1')!;
    expect(first.element.className).toBe('kanban-pane hidden');
    expect(first.element.dataset['sessionId']).toBe('s1');
    expect(first.projectId).toBe('p1');

    createKanbanPane('s1', 'p1');
    expect(instances.size).toBe(1);
    expect(getKanbanInstance('s1')!.element).toBe(first.element);
  });

  it('attaches to a container once, and only moves when the parent changes', () => {
    createKanbanPane('s1', 'p1');
    const el = getKanbanInstance('s1')!.element;
    const a = document.createElement('div');
    const b = document.createElement('div');

    attachKanbanToContainer('s1', a);
    attachKanbanToContainer('s1', a);
    expect(a.children).toHaveLength(1);

    attachKanbanToContainer('s1', b);
    expect(a.children).toHaveLength(0);
    expect(el.parentElement).toBe(b);

    attachKanbanToContainer('missing', a);
    expect(a.children).toHaveLength(0);
  });

  it('show() unhides, toggles split and re-renders the board', () => {
    createKanbanPane('s1', 'p1');
    const el = getKanbanInstance('s1')!.element;

    showKanbanPane('s1', true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.classList.contains('split')).toBe(true);
    expect(board.render).toHaveBeenCalledWith(el);

    showKanbanPane('s1', false);
    expect(el.classList.contains('split')).toBe(false);

    board.render.mockClear();
    showKanbanPane('missing', false);
    expect(board.render).not.toHaveBeenCalled();
  });

  it('hideAll() hides every pane and releases the board singleton', () => {
    createKanbanPane('s1', 'p1');
    createKanbanPane('s2', 'p1');
    showKanbanPane('s1', false);

    hideAllKanbanPanes();
    for (const instance of instances.values()) {
      expect(instance.element.classList.contains('hidden')).toBe(true);
    }
    expect(board.hideAll).toHaveBeenCalledTimes(1);
  });

  it('destroy() drops the registry entry, detaches the element, resets the board', () => {
    createKanbanPane('s1', 'p1');
    const container = document.createElement('div');
    attachKanbanToContainer('s1', container);
    const el = getKanbanInstance('s1')!.element;

    destroyKanbanPane('s1');
    expect(instances.has('s1')).toBe(false);
    expect(el.parentElement).toBeNull();
    expect(board.reset).toHaveBeenCalledWith(el);

    board.reset.mockClear();
    destroyKanbanPane('missing');
    expect(board.reset).not.toHaveBeenCalled();
  });
});
