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
