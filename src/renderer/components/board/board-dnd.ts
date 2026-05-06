import { moveTask } from '../../board-state.js';

let isDragging = false;
let dragTaskId: string | null = null;
let ghostEl: HTMLElement | null = null;
let startX = 0;
let startY = 0;
const DRAG_THRESHOLD = 5;
let pointerStarted = false;
const dragEndCallbacks = new Set<() => void>();
let activeDropTarget: HTMLElement | null = null;
let cachedTargets: { el: HTMLElement; left: number; right: number; centerY: number }[] = [];
let currentScope: HTMLElement | null = null;
let initialized = false;

export function initBoardDnd(): void {
  if (initialized) return;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  initialized = true;
}

export function isDragActive(): boolean {
  return isDragging;
}

export function addDragEndCallback(cb: () => void): () => void {
  dragEndCallbacks.add(cb);
  return () => dragEndCallbacks.delete(cb);
}

function onPointerDown(e: PointerEvent): void {
  if (isDragging) return;
  const card = (e.target as HTMLElement).closest('.board-card') as HTMLElement | null;
  if (!card || !card.dataset.taskId) return;
  if ((e.target as HTMLElement).closest('button, input, textarea')) return;

  const scope = card.closest('.board-column')?.parentElement as HTMLElement | null;
  if (!scope) return;

  currentScope = scope;
  dragTaskId = card.dataset.taskId;
  startX = e.clientX;
  startY = e.clientY;
  pointerStarted = true;

  // Prevent the browser from stealing the gesture (text selection, etc.)
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  if (!pointerStarted || !dragTaskId) return;

  if (!isDragging) {
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (dx + dy < DRAG_THRESHOLD) return;

    isDragging = true;
    const card = currentScope?.querySelector(`.board-card[data-task-id="${dragTaskId}"]`) as HTMLElement | null;
    if (!card) { cancelDrag(); return; }

    card.classList.add('dragging');

    ghostEl = card.cloneNode(true) as HTMLElement;
    ghostEl.classList.remove('dragging');
    ghostEl.classList.add('board-card-ghost');
    ghostEl.style.width = card.offsetWidth + 'px';
    document.body.appendChild(ghostEl);

    injectDropTargets(dragTaskId);

    // Prevent text selection during drag
    e.preventDefault();
  }

  if (ghostEl) {
    ghostEl.style.left = e.clientX - 20 + 'px';
    ghostEl.style.top = e.clientY - 10 + 'px';
  }

  highlightNearestTarget(e.clientX, e.clientY);
}

function onPointerUp(e: PointerEvent): void {
  if (!isDragging || !dragTaskId) {
    cancelDrag();
    return;
  }

  // Final position update before reading the active target
  highlightNearestTarget(e.clientX, e.clientY);

  if (activeDropTarget) {
    const columnId = activeDropTarget.dataset.columnId!;
    const order = parseInt(activeDropTarget.dataset.order!, 10);
    moveTask(dragTaskId, columnId, order);
  }

  cancelDrag();
  for (const cb of dragEndCallbacks) cb();
}

function cancelDrag(): void {
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }

  removeDropTargets();
  cachedTargets = [];
  currentScope?.querySelectorAll('.board-card.dragging').forEach(el => el.classList.remove('dragging'));

  isDragging = false;
  dragTaskId = null;
  pointerStarted = false;
  activeDropTarget = null;
  currentScope = null;
}

/**
 * Inject narrow drop-target strips between cards in every column.
 * Each target stores the columnId and the order index the dragged card
 * would receive if dropped there.
 */
function injectDropTargets(excludeTaskId: string): void {
  if (!currentScope) return;

  for (const area of currentScope.querySelectorAll('.board-column-cards')) {
    const columnId = (area as HTMLElement).dataset.columnId;
    if (!columnId) continue;

    const cards = Array.from(area.querySelectorAll('.board-card')) as HTMLElement[];
    let order = 0;

    // Drop target before the first non-dragged card
    const firstTarget = createDropTarget(columnId, order);
    area.insertBefore(firstTarget, area.firstChild);

    for (const card of cards) {
      if (card.dataset.taskId === excludeTaskId) continue;
      order++;
      const target = createDropTarget(columnId, order);
      // Insert after this card (before its next sibling)
      card.insertAdjacentElement('afterend', target);
    }

  }

  // Cache target positions so highlightNearestTarget avoids querySelectorAll + getBoundingClientRect per pointermove
  cachedTargets = [];
  for (const el of currentScope.querySelectorAll('.board-drop-target')) {
    const rect = el.getBoundingClientRect();
    cachedTargets.push({ el: el as HTMLElement, left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 });
  }
}

function createDropTarget(columnId: string, order: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'board-drop-target';
  el.dataset.columnId = columnId;
  el.dataset.order = String(order);
  return el;
}

function removeDropTargets(): void {
  currentScope?.querySelectorAll('.board-drop-target').forEach(el => el.remove());
}

function highlightNearestTarget(x: number, y: number): void {
  const prev = activeDropTarget;
  let best: HTMLElement | null = null;
  let bestDist = Infinity;

  for (const t of cachedTargets) {
    if (x < t.left - 60 || x > t.right + 60) continue;
    const dist = Math.abs(y - t.centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = t.el;
    }
  }

  if (best !== prev) {
    if (prev) prev.classList.remove('active');
    if (best) best.classList.add('active');
    activeDropTarget = best;
  }
}
