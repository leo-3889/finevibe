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
import type { ProjectRecord } from '../../../shared/types.js';

function setupKanban(): HTMLElement {
  _resetForTesting();
  document.body.innerHTML = '';
  kanbanInstances.clear();
  // C5G-07: pane instances are keyed by pane element; drop the previous
  // test's panes so their roots never leak into this one's renders.
  resetBoardView();
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

describe('board-view pane-instance reset (C2R-16)', () => {
  it('rebuilds for a new pane instead of reviving the detached tree', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // The pane that owned its instance is destroyed and the board is
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

describe('board-view per-pane reset (C3R-04)', () => {
  it('leaves a live pane intact when a foreign element is destroyed', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // destroyKanbanPane() of a BACKGROUND project's pane: its element never
    // owned a board instance, so the visible pane's root must survive.
    const foreign = document.createElement('div');
    document.body.appendChild(foreign);
    resetBoardViewIf(foreign);

    renderBoard();
    expect(container.querySelector('.board-card')).toBe(card);
  });

  it('drops the instance when its owning pane is destroyed', () => {
    const container = setupKanban();
    addTask({ title: 'T', prompt: 'p', columnId: 'col-a' });
    initBoard();
    renderBoard();
    const card = container.querySelector('.board-card');
    expect(card).not.toBeNull();

    // instance.destroy() detaches the pane element (its board subtree travels
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

describe('board-view multi-instance (C5G-07)', () => {
  // Two kanban tabs open at once (split/swarm): one pane per project, both
  // visible. The singleton this replaces was re-parented into the ACTIVE pane
  // by every untargeted render, blanking the other visible pane.
  interface TwoPanes {
    paneA: HTMLElement;
    paneB: HTMLElement;
    projectA: ProjectRecord;
    projectB: ProjectRecord;
    columnA: string;
  }

  function setupTwoPanes(): TwoPanes {
    _resetForTesting();
    document.body.innerHTML = '';
    kanbanInstances.clear();
    resetBoardView();
    (window as unknown as { finevibe: unknown }).finevibe = {
      store: { load: vi.fn(async () => null), save: vi.fn() },
    };

    const projectA = appState.addProject('Alpha', '/alpha');
    const projectB = appState.addProject('Beta', '/beta');
    const panes = [
      [projectA, 'kb-a', ['Backlog', 'Active', 'Done']],
      [projectB, 'kb-b', ['B Inbox', 'B Doing', 'B Done']],
    ] as const;
    for (const [project, sessionId, titles] of panes) {
      project.board = {
        columns: titles.map((title, i) => ({
          id: `${project.id}-col-${i}`,
          title,
          order: i,
          behavior: (['inbox', 'active', 'terminal'] as const)[i],
        })),
        tasks: [],
      };
      project.sessions.push({ id: sessionId, name: 'Kanban', type: 'kanban' } as never);
      project.activeSessionId = sessionId;
    }
    // Project A is the active one: the board-state mutation paths (addTask /
    // updateTask) write its board, so project B's board is only reachable
    // through its pane — exactly the split-view situation the finding is about.
    appState.setActiveProject(projectA.id);

    const paneFor = (project: ProjectRecord, sessionId: string): HTMLElement => {
      const el = document.createElement('div');
      el.dataset['sessionId'] = sessionId;
      document.body.appendChild(el);
      kanbanInstances.set(sessionId, {
        sessionId,
        projectId: project.id,
        element: el,
        destroy: () => el.remove(),
      });
      return el;
    };

    return {
      paneA: paneFor(projectA, 'kb-a'),
      paneB: paneFor(projectB, 'kb-b'),
      projectA,
      projectB,
      columnA: projectA.board!.columns[0].id,
    };
  }

  const columnTitles = (pane: HTMLElement): (string | null)[] =>
    [...pane.querySelectorAll('.column-title')].map((el) => el.textContent);

  it('renders each pane with its own project columns; neither is blanked', () => {
    const { paneA, paneB, columnA } = setupTwoPanes();
    addTask({ title: 'A task', prompt: 'p', columnId: columnA });
    initBoard();

    renderBoard(paneA);
    renderBoard(paneB);

    const rootA = paneA.querySelector('.board-view');
    const rootB = paneB.querySelector('.board-view');
    expect(rootA).not.toBeNull();
    expect(rootB).not.toBeNull();
    // Each root is parented in its OWN pane: no re-parenting, no blank pane.
    expect(rootA!.parentElement).toBe(paneA);
    expect(rootB!.parentElement).toBe(paneB);

    expect(columnTitles(paneA)).toEqual(['Backlog', 'Active', 'Done']);
    expect(columnTitles(paneB)).toEqual(['B Inbox', 'B Doing', 'B Done']);
    // Project A's task renders in A's tree only.
    expect(paneA.querySelector('.board-card-title')!.textContent).toBe('A task');
    expect(paneB.querySelector('.board-card')).toBeNull();
  });

  it('an untargeted render refreshes every pane, not just the active one', () => {
    const { paneA, paneB, projectB, columnA } = setupTwoPanes();
    const task = addTask({ title: 'Old A', prompt: 'p', columnId: columnA })!;
    initBoard();
    renderBoard(paneA);
    renderBoard(paneB);
    const rootB = paneB.querySelector('.board-view');

    // A mutation of the ACTIVE project's board (through the real path:
    // updateTask fires board-changed) plus a background-board change. The
    // singleton moved its one tree into the active pane here, blanking B.
    updateTask(task.id, { title: 'New A' });
    projectB.board!.columns[0].title = 'B Renamed';
    renderBoard();

    expect(paneA.querySelector('.board-card-title')!.textContent).toBe('New A');
    expect(columnTitles(paneB)).toEqual(['B Renamed', 'B Doing', 'B Done']);
    // Both trees survive: neither pane's root moved.
    expect(paneA.querySelector('.board-view')!.parentElement).toBe(paneA);
    expect(paneB.querySelector('.board-view')).toBe(rootB);
  });

  it('destroying one pane leaves the other rooted and renderable', () => {
    const { paneA, paneB, projectB } = setupTwoPanes();
    initBoard();
    renderBoard(paneA);
    renderBoard(paneB);
    const rootB = paneB.querySelector('.board-view');
    expect(rootB).not.toBeNull();

    // destroyKanbanPane('kb-a'): instance.destroy() detaches pane A, then the
    // conditional reset drops exactly A's instance (C3R-04, now exact).
    kanbanInstances.delete('kb-a');
    paneA.remove();
    resetBoardViewIf(paneA);

    expect(paneA.querySelector('.board-view')).toBeNull();
    expect(paneB.querySelector('.board-view')).toBe(rootB);

    projectB.board!.columns[0].title = 'B Renamed';
    renderBoard();
    expect(columnTitles(paneB)).toEqual(['B Renamed', 'B Doing', 'B Done']);
  });
});

describe('board-view change key providerId (P2-65)', () => {
  it('re-renders the card provider icon when only providerId changes', async () => {
    const { hasMultipleAvailableProviders } = await import('../../provider-availability.js');
    vi.mocked(hasMultipleAvailableProviders).mockReturnValue(true);
    const container = setupKanban();
    const task = addTask({ title: 'T', prompt: 'p', columnId: 'col-a' })!;
    initBoard();
    renderBoard();
    const before = container.querySelector('.tab-provider-icon')!.getAttribute('alt');

    // Provider-only edit: the modal persists task.providerId; the key used to
    // omit it, so the early return kept the old icon.
    updateTask(task.id, { providerId: before === 'codex' ? 'claude' : 'codex' });
    const after = container.querySelector('.tab-provider-icon')!.getAttribute('alt');
    expect(after).not.toBe(before);
  });
});
