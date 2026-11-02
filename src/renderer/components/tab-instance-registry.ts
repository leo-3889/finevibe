/**
 * Row 28: the shared tab-pane instance registry.
 *
 * project-tab, team and kanban each kept a verbatim copy of the same
 * singleton (interface + `Map<sessionId, instance>` + getter) - a 0.60-0.62
 * mirror family from the code-cleanup audit. One generic registry; each
 * feature's `instance.ts` stays as the typed 3-line re-export so every
 * consumer (and every `vi.mock('./instance')`) keeps working unchanged.
 *
 * Renderer-side, so the src/main module-map cap rule does not apply; the map
 * is bounded by open tab panes (a session id per pane, destroyed on close).
 */
export interface TabInstance {
  sessionId: string;
  projectId: string;
  element: HTMLElement;
  destroy(): void;
}

export interface TabRegistry<T extends TabInstance> {
  instances: Map<string, T>;
  getInstance(sessionId: string): T | undefined;
}

export function createTabRegistry<T extends TabInstance>(): TabRegistry<T> {
  const instances = new Map<string, T>();
  return { instances, getInstance: (sessionId: string) => instances.get(sessionId) };
}
