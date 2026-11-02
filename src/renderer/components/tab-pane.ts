/**
 * Row 28 (code-cleanup audit): the tab-pane shell the kanban and team panes
 * both built line-for-line — create (element + `hidden` + session id dataset +
 * registry entry), attach (append only when the parent differs), show (unhide,
 * toggle `split`, re-render), hide-all and destroy.
 *
 * Each feature keeps its own `pane.ts` with the same named exports and its own
 * registry; only the three places where their semantics genuinely differ move
 * into the callbacks: the view re-rendered on show, the view-level singleton
 * released on hide-all, and any extra teardown on destroy.
 *
 * Deliberately structural (no import of `tab-instance-registry.ts`): every pane
 * instance type in the feature `instance.ts` files satisfies `PaneInstance`, so
 * the shell stays independent of how a feature builds its registry.
 */
export interface PaneInstance {
  sessionId: string;
  projectId: string;
  element: HTMLElement;
  destroy(): void;
}

export interface TabPaneShell {
  create(sessionId: string, projectId: string): void;
  attach(sessionId: string, container: HTMLElement): void;
  show(sessionId: string, isSplit: boolean): void;
  hideAll(): void;
  destroy(sessionId: string): void;
}

export function createTabPaneShell(config: {
  instances: Map<string, PaneInstance>;
  className: string;
  /** Re-render the pane's own view after it becomes visible. */
  onShow?: (instance: PaneInstance) => void;
  /** Release the feature's view-level singleton (the visible pane's instance). */
  onHideAll?: () => void;
  /** Extra teardown after the instance is removed from the registry. */
  onDestroy?: (instance: PaneInstance) => void;
}): TabPaneShell {
  const { instances, className, onShow, onHideAll, onDestroy } = config;

  return {
    create(sessionId, projectId) {
      if (instances.has(sessionId)) return;

      const el = document.createElement('div');
      el.className = `${className} hidden`;
      el.dataset['sessionId'] = sessionId;

      instances.set(sessionId, {
        sessionId,
        projectId,
        element: el,
        destroy() {
          el.remove();
        },
      });
    },

    attach(sessionId, container) {
      const instance = instances.get(sessionId);
      if (!instance) return;
      if (instance.element.parentElement !== container) {
        container.appendChild(instance.element);
      }
    },

    show(sessionId, isSplit) {
      const instance = instances.get(sessionId);
      if (!instance) return;
      instance.element.classList.remove('hidden');
      instance.element.classList.toggle('split', isSplit);
      onShow?.(instance);
    },

    hideAll() {
      for (const instance of instances.values()) {
        instance.element.classList.add('hidden');
      }
      onHideAll?.();
    },

    destroy(sessionId) {
      const instance = instances.get(sessionId);
      if (!instance) return;
      instances.delete(sessionId);
      instance.destroy();
      onDestroy?.(instance);
    },
  };
}
