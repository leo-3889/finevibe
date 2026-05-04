import { GridStack, type GridStackNode, type GridItemHTMLElement } from 'gridstack';
import type { OverviewLayout, OverviewWidget, OverviewWidgetType } from '../../../shared/types.js';
import type { WidgetInstance, WidgetHost } from './widgets/widget-host.js';
import { getWidgetMeta } from './widgets/widget-registry.js';

interface MountedWidget {
  record: OverviewWidget;
  instance: WidgetInstance;
  itemEl: GridItemHTMLElement;
}

export interface ProjectTabGridOptions {
  projectId: string;
  rootEl: HTMLElement;
  initialLayout: OverviewLayout;
  onChange(layout: OverviewLayout): void;
  onOpenSettings(widget: OverviewWidget): void;
}

export interface ProjectTabGrid {
  setEditMode(on: boolean): void;
  isEditMode(): boolean;
  addWidget(type: OverviewWidgetType): void;
  removeWidget(widgetId: string): void;
  /** Update a widget's per-instance config and remount just that tile's body. */
  updateWidgetConfig(widgetId: string, patch: Record<string, unknown>): void;
  destroy(): void;
}

const CHANGE_DEBOUNCE_MS = 400;

export function createProjectTabGrid(opts: ProjectTabGridOptions): ProjectTabGrid {
  const { projectId, rootEl, onChange, onOpenSettings } = opts;
  // Local working copy of widget config (gridstack only tracks x/y/w/h).
  let layout: OverviewLayout = { gridVersion: 1, widgets: opts.initialLayout.widgets.map((w) => ({ ...w })) };
  let editMode = false;
  let destroyed = false;
  let changeDebounceHandle: number | null = null;

  rootEl.classList.add('grid-stack', 'project-tab-grid');

  const grid = GridStack.init(
    {
      column: 12,
      cellHeight: 56,
      margin: 8,
      float: false,
      disableResize: true,
      disableDrag: true,
      acceptWidgets: false,
      handle: '.widget-drag-handle',
      animate: true,
    },
    rootEl,
  );

  const mounted = new Map<string, MountedWidget>();

  function flushChange(): void {
    if (changeDebounceHandle !== null) {
      clearTimeout(changeDebounceHandle);
      changeDebounceHandle = null;
    }
    onChange(serialize());
  }

  function scheduleChange(): void {
    if (changeDebounceHandle !== null) clearTimeout(changeDebounceHandle);
    changeDebounceHandle = window.setTimeout(() => {
      changeDebounceHandle = null;
      onChange(serialize());
    }, CHANGE_DEBOUNCE_MS);
  }

  const buildHost = (record: OverviewWidget): WidgetHost => ({
    projectId,
    widgetId: record.id,
    widgetType: record.type,
    getConfig<T extends Record<string, unknown>>(): T {
      const live = layout.widgets.find((w) => w.id === record.id);
      return ((live?.config ?? {}) as T);
    },
    setConfig(patch: Record<string, unknown>) {
      updateWidgetConfig(record.id, patch);
    },
    openSettings() {
      onOpenSettings(record);
    },
    requestRefresh() {
      const m = mounted.get(record.id);
      m?.instance.refresh?.();
    },
  });

  function buildTile(record: OverviewWidget): { wrapper: HTMLElement; body: HTMLElement } {
    const meta = getWidgetMeta(record.type);
    const wrapper = document.createElement('div');
    wrapper.className = 'widget-tile';

    const header = document.createElement('div');
    header.className = 'widget-header widget-drag-handle';

    const title = document.createElement('span');
    title.className = 'widget-title';
    title.textContent = meta?.displayName ?? record.type;
    header.appendChild(title);

    const actions = document.createElement('span');
    actions.className = 'widget-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'widget-action-btn';
    refreshBtn.title = 'Refresh';
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = mounted.get(record.id);
      m?.instance.refresh?.();
    });
    actions.appendChild(refreshBtn);

    if (meta?.hasSettings) {
      const gear = document.createElement('button');
      gear.className = 'widget-action-btn';
      gear.title = 'Settings';
      gear.textContent = '⚙';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        onOpenSettings(record);
      });
      actions.appendChild(gear);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'widget-action-btn widget-action-remove';
    removeBtn.title = 'Remove widget';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWidget(record.id);
    });
    actions.appendChild(removeBtn);

    header.appendChild(actions);
    wrapper.appendChild(header);

    const body = document.createElement('div');
    body.className = 'widget-body';
    wrapper.appendChild(body);

    return { wrapper, body };
  }

  function mountInstance(record: OverviewWidget, body: HTMLElement): WidgetInstance | null {
    const meta = getWidgetMeta(record.type);
    if (!meta) {
      const fallback = document.createElement('div');
      fallback.className = 'widget-empty';
      fallback.textContent = `Unknown widget type: ${record.type}`;
      body.appendChild(fallback);
      return null;
    }
    const instance = meta.factory(buildHost(record));
    body.appendChild(instance.element);
    return instance;
  }

  function placeWidget(record: OverviewWidget, opts: { autoPosition?: boolean } = {}): void {
    const { wrapper, body } = buildTile(record);
    const widgetOpts: Record<string, unknown> = {
      w: record.w,
      h: record.h,
      id: record.id,
      content: '',
    };
    if (opts.autoPosition) {
      widgetOpts.autoPosition = true;
    } else {
      widgetOpts.x = record.x;
      widgetOpts.y = record.y;
    }
    const itemEl = grid.addWidget(widgetOpts as never);
    if (!itemEl) {
      console.warn('[project-tab] gridstack failed to add widget', record);
      return;
    }
    const contentSlot = itemEl.querySelector('.grid-stack-item-content') as HTMLElement | null;
    if (!contentSlot) {
      console.warn('[project-tab] grid-stack-item-content not found on new tile', record);
      return;
    }
    contentSlot.appendChild(wrapper);

    const instance = mountInstance(record, body);
    mounted.set(record.id, {
      record,
      instance: instance ?? { element: document.createElement('div'), destroy() {} },
      itemEl,
    });
  }

  function remountBody(widgetId: string): void {
    const m = mounted.get(widgetId);
    if (!m) return;
    m.instance.destroy();
    const body = m.itemEl.querySelector('.widget-body') as HTMLElement | null;
    if (!body) return;
    body.innerHTML = '';
    const instance = mountInstance(m.record, body);
    m.instance = instance ?? { element: document.createElement('div'), destroy() {} };
  }

  function serialize(): OverviewLayout {
    const items = grid.save(false) as GridStackNode[];
    const byId = new Map(items.map((n) => [String(n.id ?? ''), n]));
    const widgets: OverviewWidget[] = layout.widgets.map((w) => {
      const node = byId.get(w.id);
      return {
        ...w,
        x: typeof node?.x === 'number' ? node.x : w.x,
        y: typeof node?.y === 'number' ? node.y : w.y,
        w: typeof node?.w === 'number' ? node.w : w.w,
        h: typeof node?.h === 'number' ? node.h : w.h,
      };
    });
    return { gridVersion: 1, widgets };
  }

  function setEditMode(on: boolean): void {
    editMode = on;
    if (on) {
      grid.enableMove(true);
      grid.enableResize(true);
    } else {
      grid.enableMove(false);
      grid.enableResize(false);
    }
    rootEl.classList.toggle('edit-mode', on);
  }

  function addWidget(type: OverviewWidgetType): void {
    const meta = getWidgetMeta(type);
    if (!meta) return;
    const record: OverviewWidget = {
      id: crypto.randomUUID(),
      type,
      x: 0,
      y: 0,
      w: meta.defaultSize.w,
      h: meta.defaultSize.h,
      config: { ...meta.defaultConfig },
    };
    layout = { ...layout, widgets: [...layout.widgets, record] };
    placeWidget(record, { autoPosition: true });
    const m = mounted.get(record.id);
    m?.itemEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    flushChange();
  }

  function removeWidget(widgetId: string): void {
    const m = mounted.get(widgetId);
    if (!m) return;
    m.instance.destroy();
    grid.removeWidget(m.itemEl, true, false);
    mounted.delete(widgetId);
    layout = { ...layout, widgets: layout.widgets.filter((w) => w.id !== widgetId) };
    flushChange();
  }

  function updateWidgetConfig(widgetId: string, patch: Record<string, unknown>): void {
    const live = layout.widgets.find((w) => w.id === widgetId);
    if (!live) return;
    live.config = { ...(live.config ?? {}), ...patch };
    const m = mounted.get(widgetId);
    if (m) m.record.config = live.config;
    flushChange();
    remountBody(widgetId);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (changeDebounceHandle !== null) {
      clearTimeout(changeDebounceHandle);
      changeDebounceHandle = null;
    }
    for (const m of mounted.values()) m.instance.destroy();
    mounted.clear();
    grid.destroy(false);
  }

  // Initial widget placement (no change events fire because the listener is attached after).
  grid.batchUpdate();
  for (const w of layout.widgets) placeWidget(w);
  grid.batchUpdate(false);

  grid.on('change', scheduleChange);

  return { setEditMode, isEditMode: () => editMode, addWidget, removeWidget, updateWidgetConfig, destroy };
}
