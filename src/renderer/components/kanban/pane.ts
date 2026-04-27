import { instances, type KanbanInstance } from './instance.js';
import { renderBoard, hideBoardView } from '../board/board-view.js';

export function createKanbanPane(sessionId: string, projectId: string): void {
  if (instances.has(sessionId)) return;

  const el = document.createElement('div');
  el.className = 'kanban-pane hidden';
  el.dataset['sessionId'] = sessionId;

  const instance: KanbanInstance = {
    sessionId,
    projectId,
    element: el,
    destroy() {
      el.remove();
    },
  };
  instances.set(sessionId, instance);
}

export function attachKanbanToContainer(sessionId: string, container: HTMLElement): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.element.parentElement !== container) {
    container.appendChild(instance.element);
  }
}

export function showKanbanPane(sessionId: string, isSplit: boolean): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.element.classList.remove('hidden');
  instance.element.classList.toggle('split', isSplit);
  renderBoard(instance.element);
}

export function hideAllKanbanPanes(): void {
  for (const instance of instances.values()) {
    instance.element.classList.add('hidden');
  }
  hideBoardView();
}

export function destroyKanbanPane(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instances.delete(sessionId);
  instance.destroy();
}

export { getKanbanInstance } from './instance.js';
