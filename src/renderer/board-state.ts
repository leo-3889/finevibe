import { appState } from './state.js';
import { showBoardNotice } from './board-notice.js';
import { t } from './i18n.js';
import type { BoardTask, BoardColumn, BoardData, ColumnBehavior, ProjectRecord, TagDefinition } from '../shared/types.js';

// C5G-08: growth caps for persisted board data. Entries are written to the
// project board in the state store, so an unbounded board bloats every save;
// the add paths refuse (undefined) past the cap. Limits are code constants,
// not Preferences (docs/FEATURES.md Appendix A).
export const MAX_BOARD_COLUMNS = 50;
export const MAX_BOARD_TASKS = 2000;
export const MAX_BOARD_TAGS = 100;

function resolveProject(projectId?: string): ProjectRecord | undefined {
  return projectId ? appState.projects.find(p => p.id === projectId) : appState.activeProject;
}

export function getBoard(projectId?: string): BoardData | undefined {
  return resolveProject(projectId)?.board;
}

export function getColumnByBehavior(behavior: ColumnBehavior, projectId?: string): BoardColumn | undefined {
  const board = getBoard(projectId);
  if (!board) return undefined;
  return board.columns.find(c => c.behavior === behavior);
}

export function getTasksForColumn(columnId: string): BoardTask[] {
  const board = getBoard();
  if (!board) return [];
  return board.tasks
    .filter(t => t.columnId === columnId)
    .sort((a, b) => a.order - b.order);
}

export function getTaskBySessionId(sessionId: string, projectId?: string): BoardTask | undefined {
  const board = getBoard(projectId);
  if (!board) return undefined;
  return board.tasks.find(t => t.sessionId === sessionId);
}

export function getTaskByCliSessionId(cliSessionId: string): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.tasks.find(t => t.cliSessionId === cliSessionId);
}

export function addTask(partial: Partial<BoardTask>): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  // C5G-08: refuse past the persisted-task cap.
  if (board.tasks.length >= MAX_BOARD_TASKS) return undefined;

  const columnId = partial.columnId ?? getColumnByBehavior('inbox')?.id ?? board.columns[0]?.id;
  if (!columnId) return undefined;

  const tasksInColumn = board.tasks.filter(t => t.columnId === columnId);
  const maxOrder = tasksInColumn.reduce((max, t) => Math.max(max, t.order), -1);

  const now = Date.now();
  const taskId = partial.id ?? crypto.randomUUID();
  const task: BoardTask = {
    id: taskId,
    title: partial.title ?? '',
    prompt: partial.prompt ?? '',
    columnId,
    order: maxOrder + 1,
    createdAt: partial.createdAt || now,
    updatedAt: now,
    ...(partial.notes ? { notes: partial.notes } : {}),
    ...(partial.tags && partial.tags.length > 0 ? { tags: partial.tags } : {}),
    ...(partial.providerId ? { providerId: partial.providerId } : {}),
    ...(partial.profileId ? { profileId: partial.profileId } : {}),
    ...(partial.assigneeId && appState.getTeamMemberById(partial.assigneeId) ? { assigneeId: partial.assigneeId } : {}),
    ...(partial.planMode !== undefined ? { planMode: partial.planMode } : {}),
  };

  board.tasks.push(task);
  appState.notifyBoardChanged();
  return task;
}

/**
 * The Kanban Done-gate (team-lead-persona-plan M2b, increment I4): on a board with
 * `leadGate` in a lead-enabled project, a card that has RUN lands in a
 * `behavior: 'terminal'` column only on a lead-APPROVED review. Pure predicate, so
 * `moveTask` and the modal's `updateTask` column write share one rule, and the rule
 * reads only what it needs:
 * - gate off (`!board.leadGate`) or project lead absent/disabled → never blocks
 *   (zero behavior delta, the pre-I4 path);
 * - target column is not terminal, or the card already lives there (a reorder inside
 *   Done is not a landing) → never blocks;
 * - a card with NO session at all (a hand-written card, nothing was ever run, so
 *   there is nothing to review) → moves freely. `sessionId` is cleared at load
 *   (state/persistence.ts), so a card whose session ran is still recognised by its
 *   `cliSessionId` — that is the post-restart shape;
 * - reviewed: `approved` passes, `flagged` and no-verdict-at-all are refused.
 */
export function isLeadGateBlocked(task: BoardTask, toColumnId: string, projectId?: string): boolean {
  const project = resolveProject(projectId);
  const board = project?.board;
  if (!project?.lead?.enabled || !board?.leadGate) return false;
  if (board.columns.find(c => c.id === toColumnId)?.behavior !== 'terminal') return false;
  if (task.columnId === toColumnId) return false;
  if (!task.sessionId && !task.cliSessionId) return false;
  return task.leadReview?.verdict !== 'approved';
}

function leadGateMessage(task: BoardTask): string {
  return task.leadReview?.verdict === 'flagged'
    ? t('board.leadGate.refusalFlagged')
    : t('board.leadGate.refusalUnreviewed');
}

/** Toggle the per-board Done-gate. Off DELETES the key, so a board that is not gated
 * serializes exactly as it did before I4 (the additive-key idiom). */
export function setLeadGate(enabled: boolean, projectId?: string): void {
  const board = getBoard(projectId);
  if (!board) return;
  if (enabled) board.leadGate = true;
  else delete board.leadGate;
  appState.notifyBoardChanged();
}

export function updateTask(taskId: string, updates: Partial<BoardTask>, projectId?: string): void {
  const board = getBoard(projectId);
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;
  const safeUpdates = { ...updates };
  if (safeUpdates.columnId && !board.columns.some(c => c.id === safeUpdates.columnId)) {
    delete safeUpdates.columnId;
  }
  // The task modal's Column picker is a column write like any other (I4): the gate
  // sees the PRE-write card (a landing, not a reorder) and drops the column change,
  // naming the refusal — the rest of the save still lands.
  if (safeUpdates.columnId && isLeadGateBlocked(task, safeUpdates.columnId, projectId)) {
    showBoardNotice(leadGateMessage(task));
    delete safeUpdates.columnId;
  }
  if (safeUpdates.assigneeId && !appState.getTeamMemberById(safeUpdates.assigneeId)) {
    delete safeUpdates.assigneeId;
  }
  Object.assign(task, safeUpdates, { updatedAt: Date.now() });
  appState.notifyBoardChanged();
}

export function deleteTask(taskId: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;

  const columnId = task.columnId;
  const order = task.order;
  board.tasks = board.tasks.filter(t => t.id !== taskId);

  board.tasks
    .filter(t => t.columnId === columnId && t.order > order)
    .forEach(t => t.order--);

  appState.notifyBoardChanged();
}

/** Returns false when the write was refused (unknown ids, or the lead Done-gate);
 * a refusal names itself to the user (`showBoardNotice`), never silently. */
export function moveTask(taskId: string, toColumnId: string, toOrder: number, projectId?: string): boolean {
  const board = getBoard(projectId);
  if (!board) return false;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return false;
  if (!board.columns.some(c => c.id === toColumnId)) return false;
  // The one choke point every card landing passes through — drag (board-dnd.ts),
  // the run-completion auto-move (board-session-sync.ts), Run → Active
  // (board-card.ts, never terminal) — so the gate lives here, not per call site.
  if (isLeadGateBlocked(task, toColumnId, projectId)) {
    showBoardNotice(leadGateMessage(task));
    return false;
  }

  const fromColumnId = task.columnId;

  if (fromColumnId !== toColumnId) {
    board.tasks
      .filter(t => t.columnId === fromColumnId && t.order > task.order)
      .forEach(t => t.order--);
  } else {
    // Same column: remove from current position first
    board.tasks
      .filter(t => t.columnId === fromColumnId && t.id !== taskId && t.order > task.order)
      .forEach(t => t.order--);
  }

  board.tasks
    .filter(t => t.columnId === toColumnId && t.order >= toOrder && t.id !== taskId)
    .forEach(t => t.order++);

  task.columnId = toColumnId;
  task.order = toOrder;
  task.updatedAt = Date.now();

  appState.notifyBoardChanged();
  return true;
}

export function addColumn(title: string, afterColumnId?: string): BoardColumn | undefined {
  const board = getBoard();
  if (!board) return undefined;
  // C5G-08: refuse past the persisted-column cap.
  if (board.columns.length >= MAX_BOARD_COLUMNS) return undefined;

  let insertOrder: number;
  if (afterColumnId) {
    const afterCol = board.columns.find(c => c.id === afterColumnId);
    insertOrder = afterCol ? afterCol.order + 1 : board.columns.length;
  } else {
    insertOrder = board.columns.length;
  }

  // Shift columns at or after insertion point
  board.columns
    .filter(c => c.order >= insertOrder)
    .forEach(c => c.order++);

  const column: BoardColumn = {
    id: crypto.randomUUID(),
    title,
    order: insertOrder,
    behavior: 'none',
  };
  board.columns.push(column);
  appState.notifyBoardChanged();
  return column;
}

export function renameColumn(columnId: string, title: string): void {
  const board = getBoard();
  if (!board) return;
  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;
  column.title = title;
  appState.notifyBoardChanged();
}

export function deleteColumn(columnId: string): void {
  const board = getBoard();
  if (!board) return;

  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;

  // Prevent deleting if it's the last column
  if (board.columns.length <= 1) return;

  // Prevent deleting behavior columns (inbox, active, terminal)
  if (column.behavior !== 'none') return;

  // Move orphaned tasks to inbox column
  const inboxCol = getColumnByBehavior('inbox') ?? board.columns.find(c => c.id !== columnId)!;
  const orphanedTasks = board.tasks.filter(t => t.columnId === columnId);
  const maxInboxOrder = board.tasks
    .filter(t => t.columnId === inboxCol.id)
    .reduce((max, t) => Math.max(max, t.order), -1);

  orphanedTasks.forEach((t, i) => {
    t.columnId = inboxCol.id;
    t.order = maxInboxOrder + 1 + i;
  });

  board.columns = board.columns.filter(c => c.id !== columnId);
  board.columns.sort((a, b) => a.order - b.order).forEach((c, i) => c.order = i);

  appState.notifyBoardChanged();
}

export function reorderColumns(columnIds: string[]): void {
  const board = getBoard();
  if (!board) return;
  for (let i = 0; i < columnIds.length; i++) {
    const col = board.columns.find(c => c.id === columnIds[i]);
    if (col) col.order = i;
  }
  appState.notifyBoardChanged();
}

export const TAG_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'cyan', 'pink', 'gray'];

export function addTag(name: string, color?: string): TagDefinition | undefined {
  const board = getBoard();
  if (!board) return undefined;
  if (!board.tags) board.tags = [];

  const normalized = name.toLowerCase().trim();
  if (board.tags.some(t => t.name === normalized)) return board.tags.find(t => t.name === normalized);

  // C5G-08: refuse new tags past the cap; a duplicate of an existing tag is
  // always allowed (resolved above) and does not grow the list.
  if (board.tags.length >= MAX_BOARD_TAGS) return undefined;

  const tagColor = color ?? TAG_COLORS[board.tags.length % TAG_COLORS.length];
  const tag: TagDefinition = { name: normalized, color: tagColor };
  board.tags.push(tag);
  appState.notifyBoardChanged();
  return tag;
}

export function removeTag(name: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  board.tags = board.tags.filter(t => t.name !== normalized);
  for (const task of board.tasks) {
    if (task.tags) {
      task.tags = task.tags.filter(t => t !== normalized);
    }
  }
  appState.notifyBoardChanged();
}

export function updateTagColor(name: string, color: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  const tag = board.tags.find(t => t.name === normalized);
  if (tag) {
    tag.color = color;
    appState.notifyBoardChanged();
  }
}

export function addTagToTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;

  const normalized = tagName.toLowerCase().trim();
  if (!normalized) return;

  // Auto-create the tag in the palette if it doesn't exist
  addTag(normalized);

  if (!task.tags) task.tags = [];
  if (task.tags.includes(normalized)) return;
  task.tags.push(normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function removeTagFromTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task || !task.tags) return;

  const normalized = tagName.toLowerCase().trim();
  task.tags = task.tags.filter(t => t !== normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function getTagColor(tagName: string): string {
  const board = getBoard();
  const tag = board?.tags?.find(t => t.name === tagName);
  return tag?.color ?? 'gray';
}

export function getTagCount(tagName: string): number {
  const board = getBoard();
  if (!board) return 0;
  return board.tasks.filter(t => t.tags?.includes(tagName)).length;
}

