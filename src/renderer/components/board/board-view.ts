import { appState } from '../../state.js';
import { getBoard, addTag, removeTag, updateTagColor, getTagCount, TAG_COLORS } from '../../board-state.js';
import { createColumnElement } from './board-column.js';
import { showTaskModal } from './board-task-modal.js';
import { initBoardDnd, isDragActive, addDragEndCallback } from './board-dnd.js';
import { showConfirmModal } from '../modal.js';
import { showContextMenu } from './board-context-menu.js';
import { showBoardHelpDialog } from './board-help-dialog.js';
import { t } from '../../i18n.js';
import { instances as kanbanInstances, getKanbanProjectIdForElement } from '../kanban/instance.js';
import type { TagDefinition, BoardData } from '../../../shared/types.js';
import {
  setSearchQuery, getSearchQuery, toggleTagFilter, isTagFilterActive,
  hasActiveFilters, getFilteredTasks, onFilterChange, getActiveTagFilters,
} from '../../board-filter.js';
import { onChange as onStatusChange, STATUS_GLYPH } from '../../session-activity.js';
import { onChange as onCostChange, getCost } from '../../session-cost.js';
import { onChange as onContextChange, getContext } from '../../session-context.js';
import { statusLabel, updateMetricsRow } from './board-card.js';
import { rlog } from '../../log.js';

const svgIcon = (inner: string): string =>
  `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// C5G-07: one board view per visible kanban pane, keyed by the pane element.
// The singleton this replaces was re-parented by renderBoard() into the ACTIVE
// pane, so any board-changed event moved the tree out of the other visible
// pane. Each pane owns its root and its own change key, so a mutation
// refreshes every visible pane (C3R-04 fixed teardown ownership, not dual
// visibility).
interface BoardViewInstance {
  root: HTMLElement;
  projectId: string;
  // Cheap change key for this instance's last full column rebuild: task ids +
  // column + order + assignee + tags, column titles, tag row, and the active
  // filter — everything a rebuild can show. board-changed fires on any board
  // mutation, including ones that change nothing visible, so an unchanged key
  // skips the innerHTML wipe and the full card rebuild.
  lastKey: string;
}

const viewInstances = new Map<HTMLElement, BoardViewInstance>();

// Search query and tag filters stay module-global on purpose (board-filter.ts):
// filter state is shared, so one search box / tag filter set drives every
// visible pane.
let pendingRender = false;
let offDragEnd: (() => void) | null = null;

function isKanbanActive(): boolean {
  const project = appState.activeProject;
  if (!project) return false;
  const active = project.sessions.find((s) => s.id === project.activeSessionId);
  return active?.type === 'kanban';
}

export function initBoard(): void {
  appState.on('board-changed', () => {
    if (isKanbanActive()) renderBoard();
  });
  appState.on('project-changed', () => {
    if (isKanbanActive()) renderBoard();
  });
  if (offDragEnd) offDragEnd();
  offDragEnd = addDragEndCallback(() => {
    if (pendingRender) renderBoard();
  });
  onFilterChange(() => {
    if (isKanbanActive()) renderBoard();
  });
  onStatusChange((sessionId, status) => {
    // C5G-07: a session card lives in exactly one pane's root (session ids are
    // global), so patch the first root that has it.
    for (const { root } of viewInstances.values()) {
      const dot = root.querySelector(
        `.card-status-dot[data-session-id="${sessionId}"]`,
      ) as HTMLElement | null;
      if (!dot) continue;
      dot.className = `card-status-dot ${status}`;
      dot.textContent = STATUS_GLYPH[status];
      const labelNode = dot.parentElement?.lastChild;
      if (labelNode && labelNode.nodeType === Node.TEXT_NODE) {
        labelNode.textContent = statusLabel(status);
      }
      return;
    }
  });
  const refreshMetrics = (sessionId: string): void => {
    for (const { root } of viewInstances.values()) {
      const row = root.querySelector(
        `.board-card-metrics[data-session-id="${sessionId}"]`,
      ) as HTMLElement | null;
      if (!row) continue;
      updateMetricsRow(row, getCost(sessionId), getContext(sessionId));
      return;
    }
  };
  onCostChange(refreshMetrics);
  onContextChange(refreshMetrics);

  let lastMetricsPref = appState.preferences.boardCardMetrics ?? true;
  appState.on('preferences-changed', () => {
    const cur = appState.preferences.boardCardMetrics ?? true;
    if (cur === lastMetricsPref) return;
    lastMetricsPref = cur;
    if (isKanbanActive()) renderBoard();
  });
}

function createBoardView(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'board-view';

  const header = document.createElement('div');
  header.className = 'board-header';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'board-title-group';

  const title = document.createElement('span');
  title.className = 'board-title';
  title.textContent = t('board.title');

  const helpBtn = document.createElement('button');
  helpBtn.className = 'board-help-btn';
  helpBtn.title = t('board.helpTooltip');
  helpBtn.setAttribute('aria-label', t('board.helpAriaLabel'));
  helpBtn.textContent = '?';
  helpBtn.addEventListener('click', () => showBoardHelpDialog());

  titleGroup.appendChild(title);
  titleGroup.appendChild(helpBtn);

  const actions = document.createElement('div');
  actions.className = 'board-header-actions';

  // Search box (rounded, with magnifier icon)
  const searchWrap = document.createElement('div');
  searchWrap.className = 'board-search';

  const searchIcon = document.createElement('span');
  searchIcon.className = 'board-search-icon';
  // Row 31 review: built with createElementNS — no innerHTML, no parser, no
  // string-to-DOM sink at all. Same geometry as the svgIcon() literal.
  {
    const NS = 'http://www.w3.org/2000/svg';
    const glyph = document.createElementNS(NS, 'svg');
    glyph.setAttribute('viewBox', '0 0 14 14');
    glyph.setAttribute('width', '14');
    glyph.setAttribute('height', '14');
    glyph.setAttribute('fill', 'none');
    glyph.setAttribute('stroke', 'currentColor');
    glyph.setAttribute('stroke-width', '1.5');
    glyph.setAttribute('stroke-linecap', 'round');
    glyph.setAttribute('stroke-linejoin', 'round');
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', '6');
    circle.setAttribute('cy', '6');
    circle.setAttribute('r', '4.25');
    const bar = document.createElementNS(NS, 'line');
    bar.setAttribute('x1', '9.25');
    bar.setAttribute('y1', '9.25');
    bar.setAttribute('x2', '12.5');
    bar.setAttribute('y2', '12.5');
    glyph.append(circle, bar);
    searchIcon.append(glyph);
  }

  const searchInput = document.createElement('input');
  searchInput.className = 'board-search-input';
  searchInput.placeholder = t('board.searchPlaceholder');
  searchInput.value = getSearchQuery();

  let searchDebounce: ReturnType<typeof setTimeout>;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setSearchQuery(searchInput.value), 150);
  });

  searchWrap.appendChild(searchIcon);
  searchWrap.appendChild(searchInput);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-primary';
  addBtn.innerHTML = `${svgIcon('<line x1="7" y1="2.5" x2="7" y2="11.5"/><line x1="2.5" y1="7" x2="11.5" y2="7"/>')}<span>${t('board.newTaskButton')}</span>`;
  addBtn.addEventListener('click', () => showTaskModal('create'));

  actions.appendChild(searchWrap);
  actions.appendChild(addBtn);

  header.appendChild(titleGroup);
  header.appendChild(actions);

  const tagRow = document.createElement('div');
  tagRow.className = 'board-tag-row';

  const columnsContainer = document.createElement('div');
  columnsContainer.className = 'board-columns';

  el.appendChild(header);
  el.appendChild(tagRow);
  el.appendChild(columnsContainer);

  return el;
}

export function renderBoard(target?: HTMLElement): void {
  if (target) {
    renderPaneBoard(target);
    return;
  }
  // Mutation path (dnd commit, inline rename, card/column/modal/context-menu
  // writes, board-changed): every pane that has a board refreshes, plus the
  // active pane so an untargeted first render still lands. The singleton used
  // to move the tree into the active pane and blank the other visible one.
  const panes = new Set<HTMLElement>(viewInstances.keys());
  const active = activeKanbanContainer();
  if (active) panes.add(active);
  for (const pane of panes) renderPaneBoard(pane);
}

function renderPaneBoard(pane: HTMLElement): void {
  // A drag in flight, or an inline column rename open in ANY pane: rebuilding
  // the trees wipes the gesture / the renamer. Flush at drag end.
  if (isDragActive() || hasInlineRename()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;

  const projectId = getKanbanProjectIdForElement(pane);
  if (!projectId) {
    rlog('warn', '[kanban] renderBoard called for a pane with no kanban instance');
    return;
  }
  const board = getBoard(projectId);
  if (!board) {
    rlog('warn', `[kanban] renderBoard called with no board for project ${projectId}`);
    return;
  }

  let instance = viewInstances.get(pane);
  if (!instance) {
    const root = createBoardView();
    pane.appendChild(root);
    instance = { root, projectId, lastKey: '' };
    viewInstances.set(pane, instance);
  }
  instance.projectId = projectId;
  instance.root.style.display = '';

  const key = boardChangeKey(board);
  if (key === instance.lastKey) return;
  instance.lastKey = key;

  const columnsContainer = instance.root.querySelector('.board-columns')!;
  columnsContainer.innerHTML = '';

  const tagRow = instance.root.querySelector('.board-tag-row') as HTMLElement;
  if (tagRow) renderTagRow(tagRow, board);

  const sortedColumns = [...board.columns].sort((a, b) => a.order - b.order);
  const tasks = board.tasks;

  for (const column of sortedColumns) {
    const allColumnTasks = tasks
      .filter(t => t.columnId === column.id)
      .sort((a, b) => a.order - b.order);
    const filteredTasks = getFilteredTasks(allColumnTasks);
    const colEl = createColumnElement(column, filteredTasks, allColumnTasks.length);
    columnsContainer.appendChild(colEl);
  }

  initBoardDnd();
}

function hasInlineRename(): boolean {
  for (const { root } of viewInstances.values()) {
    if (root.querySelector('.column-title-input')) return true;
  }
  return false;
}

// FNV-1a, 32 bit. Cheap full-text digest for the change key: prompt/notes
// are unbounded (a task prompt is a whole instruction), so slicing them
// would re-introduce the staleness the key exists to prevent (S4-02).
function textHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function boardChangeKey(board: BoardData): string {
  const cols = [...board.columns]
    .sort((a, b) => a.order - b.order)
    .map((c) => `${c.id}:${c.order}:${c.title}:${c.behavior}:${c.color ?? ''}:${c.locked ? 1 : 0}`)
    .join(',');
  const tags = board.tags
    ? [...board.tags].map((tg) => `${tg.name}:${tg.color}`).join(',')
    : '';
  const tasks = [...board.tasks]
    .sort((a, b) => a.order - b.order)
    // S4-02: title/prompt/notes render INTO the card; the key used to omit
    // them, so renaming a task (the modal writes them) kept the key equal
    // and the early return showed the stale title until an unrelated
    // change happened to move a card. sessionId/cliSessionId drive the
    // run/resume glyph and gate the live status/metrics rows — a run or
    // resume (board-session-sync writes them) is invisible until the key
    // sees them.
    .map(tk => `${tk.id}:${tk.columnId}:${tk.order}:${tk.assigneeId ?? ''}:${(tk.tags ?? []).join('+')}:${textHash(`${tk.title}\u0002${tk.prompt}\u0002${tk.notes ?? ''}`)}:${tk.sessionId ?? ''}:${tk.cliSessionId ?? ''}:${tk.providerId ?? ''}`)
    .join(',');
  const filters = `${getSearchQuery()}\u0000${[...getActiveTagFilters()].sort().join('+')}`;
  return `${cols}\u0001${tags}\u0001${tasks}\u0001${filters}\u0001${appState.preferences.boardCardMetrics ?? true}`;
}

export function hideBoardView(): void {
  for (const { root } of viewInstances.values()) {
    root.style.display = 'none';
  }
}

/**
 * C2R-16: drop every pane instance, so the per-tick status/cost/context
 * patches above stop scanning — and retaining — detached trees. renderBoard()
 * rebuilds on demand (exported key: C2R-15, reused by the project-tab kanban
 * widget). Full reset for tests and global teardown; pane teardown uses
 * resetBoardViewIf().
 */
export function resetBoardView(): void {
  for (const { root } of viewInstances.values()) {
    root.remove();
  }
  viewInstances.clear();
}

/**
 * C3R-04 + C5G-07: per-pane teardown. Destroying a pane drops exactly that
 * pane's instance and root; a surviving pane keeps its own live tree, so a
 * background project's teardown can neither freeze the visible board (the
 * global reset's bug) nor steal its element (the singleton's bug).
 */
export function resetBoardViewIf(paneEl: HTMLElement): void {
  const instance = viewInstances.get(paneEl);
  if (!instance) return;
  instance.root.remove();
  viewInstances.delete(paneEl);
}

function activeKanbanContainer(): HTMLElement | null {
  const project = appState.activeProject;
  if (!project) return null;
  const active = project.sessions.find((s) => s.id === project.activeSessionId);
  if (active?.type !== 'kanban') return null;
  const instance = kanbanInstances.get(active.id);
  return instance?.element ?? null;
}

function renderTagRow(container: HTMLElement, board: BoardData): void {
  container.innerHTML = '';
  container.style.display = '';

  // Tags (only if tags exist)
  if (board.tags && board.tags.length > 0) {
    const label = document.createElement('span');
    label.className = 'board-tag-row-label';
    label.textContent = t('board.filterLabel');
    container.appendChild(label);

    const pillsContainer = document.createElement('div');
    pillsContainer.className = 'board-tag-row-pills';

    const MAX_VISIBLE = 10;
    const tags = board.tags;

    for (let i = 0; i < Math.min(tags.length, MAX_VISIBLE); i++) {
      const pill = createTagRowPill(tags[i]);
      pillsContainer.appendChild(pill);
    }

    if (tags.length > MAX_VISIBLE) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'board-tag-row-more';
      moreBtn.textContent = t('board.tagsMore', { count: tags.length - MAX_VISIBLE });
      moreBtn.addEventListener('click', () => {
        const isExpanded = pillsContainer.dataset.expanded === 'true';
        if (isExpanded) {
          while (pillsContainer.children.length > MAX_VISIBLE) {
            pillsContainer.removeChild(pillsContainer.lastChild!);
          }
          pillsContainer.appendChild(moreBtn);
          moreBtn.textContent = t('board.tagsMore', { count: tags.length - MAX_VISIBLE });
          pillsContainer.dataset.expanded = 'false';
        } else {
          moreBtn.remove();
          for (let i = MAX_VISIBLE; i < tags.length; i++) {
            pillsContainer.appendChild(createTagRowPill(tags[i]));
          }
          pillsContainer.appendChild(moreBtn);
          moreBtn.textContent = t('board.tagsShowLess');
          pillsContainer.dataset.expanded = 'true';
        }
      });
      pillsContainer.appendChild(moreBtn);
    }

    container.appendChild(pillsContainer);

    // "+" button to add new tag
    const addBtn = document.createElement('button');
    addBtn.className = 'board-tag-row-add';
    addBtn.textContent = t('board.addTagButtonLabel');
    addBtn.title = t('board.addTagTooltip');
    addBtn.addEventListener('click', () => showInlineTagInput(container));
    container.appendChild(addBtn);
  }

  // Filter count indicator
  if (hasActiveFilters()) {
    const total = board.tasks.length;
    const filtered = getFilteredTasks(board.tasks).length;
    const countEl = document.createElement('span');
    countEl.className = 'board-filter-count';
    countEl.textContent = t('board.filterCount', { filtered, total });
    container.appendChild(countEl);
  }
}

function createTagRowPill(tag: TagDefinition): HTMLElement {
  const pill = document.createElement('span');
  pill.className = 'tag-pill tag-pill-header';
  pill.dataset.color = tag.color;
  pill.dataset.tagName = tag.name;
  pill.textContent = tag.name;

  if (hasActiveFilters() && getActiveTagFilters().size > 0 && !isTagFilterActive(tag.name)) {
    pill.classList.add('inactive');
  }

  pill.addEventListener('click', () => {
    toggleTagFilter(tag.name);
  });

  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const colorItems = TAG_COLORS.map(color => ({
      label: t('board.tagColorOption', { color }),
      action: () => updateTagColor(tag.name, color),
      disabled: color === tag.color,
    }));

    showContextMenu(e.clientX, e.clientY, [
      ...colorItems,
      { label: '', action: () => {}, disabled: true },
      {
        label: t('contextMenu.board.deleteTag'),
        danger: true,
        action: () => {
          const count = getTagCount(tag.name);
          const msg = count > 0
            ? t('board.deleteTagConfirmWithTasks', { name: tag.name, count })
            : t('board.deleteTagConfirmEmpty', { name: tag.name });
          showConfirmModal(t('board.deleteTagConfirmTitle'), msg, () => removeTag(tag.name));
        },
      },
    ]);
  });

  return pill;
}

function showInlineTagInput(container: HTMLElement): void {
  const existing = container.querySelector('.board-tag-row-input');
  if (existing) { (existing as HTMLInputElement).focus(); return; }

  const input = document.createElement('input');
  input.className = 'board-tag-row-input';
  input.placeholder = t('board.tagInputPlaceholder');
  input.maxLength = 30;

  // Removing a focused input fires blur, and that blur is the whole UI3-10 bug:
  // Escape used to commit the half-typed tag, Enter committed twice through its
  // own follow-up blur, and a board-changed rebuild (innerHTML wipe) committed
  // whatever was typed. committed covers the two key handlers; isConnected covers
  // the rebuild, whose removal nobody flagged.
  let committed = false;

  const commit = () => {
    committed = true;
    const name = input.value.trim();
    if (name) addTag(name);
    input.remove();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { committed = true; input.remove(); }
  });
  input.addEventListener('blur', () => { if (!committed && input.isConnected) commit(); });

  const addBtn = container.querySelector('.board-tag-row-add');
  if (addBtn) container.insertBefore(input, addBtn);
  else container.appendChild(input);
  input.focus();
}
