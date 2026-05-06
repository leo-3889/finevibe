import type { OverviewWidgetType } from '../../../../shared/types.js';

export interface WidgetHost {
  projectId: string;
  widgetId: string;
  widgetType: OverviewWidgetType;
  /** Read the current per-widget config (typed by the caller). */
  getConfig<T extends Record<string, unknown>>(): T;
  /** Persist a partial config patch. Triggers a re-mount of the widget. */
  setConfig(patch: Record<string, unknown>): void;
  /** Open the standard settings dialog for this widget. */
  openSettings(): void;
  /** Force the widget to re-fetch its data. */
  requestRefresh(): void;
}

export interface WidgetInstance {
  /** The element to mount inside the gridstack tile body. */
  element: HTMLElement;
  destroy(): void;
  /** Optional: triggered by the host's "refresh" button or the parent. */
  refresh?(): void;
}

export type WidgetFactory = (host: WidgetHost) => WidgetInstance;
