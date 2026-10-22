export interface KanbanInstance {
  sessionId: string;
  projectId: string;
  element: HTMLElement;
  destroy(): void;
}

export const instances = new Map<string, KanbanInstance>();

export function getKanbanInstance(sessionId: string): KanbanInstance | undefined {
  return instances.get(sessionId);
}

/**
 * C5G-07: the project whose board a pane element renders. Pane elements carry
 * their session id (kanban/pane.ts); board-view keys its per-pane instances by
 * the element, so it resolves the board through the pane's own instance.
 */
export function getKanbanProjectIdForElement(el: HTMLElement): string | null {
  const sessionId = el.dataset['sessionId'];
  const instance = sessionId ? instances.get(sessionId) : [...instances.values()].find((i) => i.element === el);
  return instance?.projectId ?? null;
}
