import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  preferences: {
    soundOnSessionWaiting: true,
    notificationsDesktop: true,
    debugMode: false,
    sessionHistoryEnabled: true,
    insightsEnabled: true,
    autoTitleEnabled: true,
    theme: 'dark' as 'dark' | 'light',
    defaultProvider: 'claude',
    sidebarViews: {
      gitPanel: true,
      sessionHistory: true,
      discussions: true,
      fileTree: true,
      activeSessions: true,
    },
    boardCardMetrics: true,
  },
  on: vi.fn(() => () => {}),
  setPreference: vi.fn(),
  sidebarView: vi.fn((key: string) => (mockState.preferences.sidebarViews as Record<string, boolean>)[key] ?? true),
  setLocale: vi.fn(),
}));

const selectState = vi.hoisted(() => {
  const instances = new Map<string, {
    value: string;
    element: Record<string, unknown>;
    setValue: (value: string) => void;
    getValue: () => string;
    destroyCount: number;
    destroy: () => void;
  }>();
  return {
    instances,
    reset() {
      instances.clear();
    },
  };
});

vi.mock('../state.js', () => ({ appState: mockState }));
vi.mock('./modal.js', () => ({ closeModal: vi.fn() }));
vi.mock('../zoom.js', () => ({
  applyZoom: vi.fn(),
  getZoomFactor: vi.fn(() => 1),
  ZOOM_STEPS: [1, 1.25, 1.5],
}));
vi.mock('../shortcuts.js', () => ({
  shortcutManager: {
    getAll: vi.fn(() => new Map()),
    hasOverride: vi.fn(() => false),
    getKeys: vi.fn(() => []),
    setOverride: vi.fn(),
    resetOverride: vi.fn(),
  },
  displayKeys: vi.fn(() => ''),
  eventToAccelerator: vi.fn(() => null),
  shortcutLabel: vi.fn((def: { label: string }) => def.label),
  shortcutCategoryLabel: vi.fn((category: string) => category),
}));
vi.mock('../provider-availability.js', () => ({
  loadProviderAvailability: vi.fn(async () => {}),
  getProviderAvailabilitySnapshot: vi.fn(() => ({
    providers: [
      { id: 'claude', displayName: 'Claude Code' },
      { id: 'pi', displayName: 'Pi' },
    ],
    availability: new Map([['claude', true], ['pi', true]]),
  })),
}));
vi.mock('../state/specialized-sessions.js', () => ({
  isPlanModeSupported: (id: string) => id === 'claude',
  resolvePlanModePreference: (prefs: { planModeDefaults?: Record<string, boolean> }, id: string) =>
    id === 'claude' && (prefs.planModeDefaults?.[id] ?? true),
}));
vi.mock('./setup-checks.js', () => ({
  hasProviderIssue: vi.fn(() => false),
}));
vi.mock('./custom-select.js', () => ({
  createCustomSelect: vi.fn((id: string, _options: Array<{ value: string; label: string }>, initialValue: string, onChange?: (value: string) => void) => {
    const element = makeElement('div');
    element.className = 'custom-select';
    element.dataset.selectId = id;
    let value = initialValue;
      const instance = {
        value,
        element,
        setValue(nextValue: string) {
          value = nextValue;
        instance.value = nextValue;
        onChange?.(nextValue);
      },
        getValue() {
          return value;
        },
        destroyCount: 0,
        destroy() {
          instance.destroyCount += 1;
        },
      };
      selectState.instances.set(id, instance);
      return instance;
    }),
}));

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

function makeElement(tagName = 'div'): Record<string, any> {
  const children: Record<string, any>[] = [];
  const listeners: ListenerMap = {};
  const classValues = new Set<string>();
  const element: Record<string, any> = {
    tagName,
    children,
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    checked: false,
    type: '',
    id: '',
    parentElement: null,
    appendChild(child: Record<string, any>) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    remove() {
      if (!element.parentElement) return;
      const siblings = element.parentElement.children as Record<string, any>[];
      element.parentElement.children = siblings.filter((child) => child !== element);
      element.parentElement = null;
    },
    querySelector(selector: string) {
      if (!selector.startsWith('.')) return null;
      const targetClass = selector.slice(1);
      return findInTree(element, (node) => node.className?.split(/\s+/).includes(targetClass));
    },
    closest(selector: string) {
      if (!selector.startsWith('.')) return null;
      const targetClass = selector.slice(1);
      let current: Record<string, any> | null = element;
      while (current) {
        if (current.className?.split(/\s+/).includes(targetClass)) return current;
        current = current.parentElement;
      }
      return null;
    },
    addEventListener(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    removeEventListener(event: string, cb: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((listener) => listener !== cb);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners[event.type] ?? []) listener(event);
    },
    classList: {
      add(...tokens: string[]) { tokens.forEach((token) => classValues.add(token)); },
      remove(...tokens: string[]) { tokens.forEach((token) => classValues.delete(token)); },
      toggle(token: string, force?: boolean) {
        const shouldAdd = force ?? !classValues.has(token);
        if (shouldAdd) classValues.add(token);
        else classValues.delete(token);
      },
      contains(token: string) { return classValues.has(token); },
    },
  };

  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set(_value: string) {
      children.length = 0;
    },
    configurable: true,
  });

  return element;
}

function findInTree(root: Record<string, any>, predicate: (node: Record<string, any>) => boolean): Record<string, any> | null {
  for (const child of root.children as Record<string, any>[]) {
    if (predicate(child)) return child;
    const nested = findInTree(child, predicate);
    if (nested) return nested;
  }
  return null;
}

let docBody: Record<string, any>;

function findById(root: Record<string, any>, id: string): Record<string, any> | null {
  if (root.id === id) return root;
  for (const child of root.children as Record<string, any>[]) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function getElement(id: string): Record<string, any> {
  const found = findById(docBody, id);
  if (!found) throw new Error(`element not found: ${id}`);
  return found;
}

function click(el: Record<string, any>): void {
  el.dispatchEvent({ type: 'click' });
}

function selectPreferencesSection(section: string): void {
  const overlay = getElement('preferences-overlay');
  const menu = findInTree(overlay, (node) => node.className === 'preferences-menu');
  if (!menu) throw new Error('preferences menu not found');
  const item = (menu.children as Record<string, any>[]).find((c) => c.dataset?.section === section);
  if (!item) throw new Error(`menu item not found for section: ${section}`);
  menu.dispatchEvent({ type: 'click', target: item });
}

describe('showPreferencesModal theme preference', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    selectState.reset();
    docBody = makeElement('body');

    mockState.preferences.theme = 'dark';

    vi.stubGlobal('document', {
      documentElement: { dataset: {} as Record<string, string> },
      body: docBody,
      getElementById(id: string) { return findById(docBody, id); },
      createElement(tagName: string) { return makeElement(tagName); },
      createTextNode(text: string) { return { textContent: text }; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal('window', {
      finevibe: {
        provider: {
          listProviders: vi.fn(async () => []),
          checkBinary: vi.fn(async () => true),
        },
        settings: {
          validate: vi.fn(async () => ({ statusLine: 'missing', hooks: 'missing', hookDetails: {} })),
          reinstall: vi.fn(async () => {}),
        },
        menu: { rebuild: vi.fn() },
        app: { getVersion: vi.fn(async () => '0.0.0'), openExternal: vi.fn() },
        update: {
          checkNow: vi.fn(async () => {}),
          onAvailable: vi.fn(() => () => {}),
          onError: vi.fn(() => () => {}),
        },
      },
    });
  });

  it('uses the persisted theme value for the theme select', async () => {
    mockState.preferences.theme = 'light';
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal();
    selectPreferencesSection('appearance');

    expect(selectState.instances.get('pref-theme')?.getValue()).toBe('light');
  });

  it('previews and saves the selected theme', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal();
    selectPreferencesSection('appearance');

    const themeSelect = selectState.instances.get('pref-theme')!;
    themeSelect.setValue('light');

    expect((document as any).documentElement.dataset.theme).toBe('light');

    click(getElement('preferences-confirm'));

    expect(mockState.setPreference).toHaveBeenCalledWith('theme', 'light');
  });

  it('restores the original theme on cancel', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    (document as any).documentElement.dataset.theme = 'dark';
    showPreferencesModal();
    selectPreferencesSection('appearance');

    const themeSelect = selectState.instances.get('pref-theme')!;
    themeSelect.setValue('light');
    click(getElement('preferences-cancel'));

    expect((document as any).documentElement.dataset.theme).toBe('dark');
    expect(mockState.setPreference).not.toHaveBeenCalledWith('theme', 'light');
  });

  it('destroys each select once during cleanup', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal();
    selectPreferencesSection('appearance');

    click(getElement('preferences-confirm'));

    expect(selectState.instances.get('pref-theme')?.destroyCount).toBe(1);
    expect(selectState.instances.get('pref-zoom')?.destroyCount).toBe(1);
  });

  it('lists the Help menu item directly above About', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal();

    const overlay = getElement('preferences-overlay');
    const menu = findInTree(overlay, (node) => node.className === 'preferences-menu')!;
    const order = (menu.children as Record<string, any>[]).map((c) => c.dataset?.section);
    expect(order.indexOf('help')).toBe(order.indexOf('about') - 1);
  });

  it('opens directly on the Help section and renders the legend', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal('help');

    const overlay = getElement('preferences-overlay');
    expect(findInTree(overlay, (node) => node.className === 'help-container')).not.toBeNull();
  });
});

describe('General section plan-mode defaults', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    selectState.reset();
    docBody = makeElement('body');

    vi.stubGlobal('document', {
      documentElement: { dataset: {} as Record<string, string> },
      body: docBody,
      getElementById(id: string) { return findById(docBody, id); },
      createElement(tagName: string) { return makeElement(tagName); },
      createTextNode(text: string) { return { textContent: text }; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal('window', {
      finevibe: {
        provider: {
          listProviders: vi.fn(async () => []),
          checkBinary: vi.fn(async () => true),
        },
        menu: { rebuild: vi.fn() },
        app: { getVersion: vi.fn(async () => '0.0.0'), openExternal: vi.fn() },
      },
    });
  });

  it('renders only the selected default tool row, persists toggles immediately, and re-renders on tool change', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');

    showPreferencesModal();
    selectPreferencesSection('general');

    const claude = getElement('pref-plan-mode-claude');
    expect(claude.type).toBe('checkbox');
    expect(claude.checked).toBe(true);
    expect(claude.disabled).toBe(false);
    expect(findById(docBody, 'pref-plan-mode-pi')).toBeNull();

    claude.checked = false;
    claude.dispatchEvent({ type: 'change' });
    expect(mockState.setPreference).toHaveBeenCalledWith('planModeDefaults', { claude: false });

    selectState.instances.get('pref-default-provider')!.setValue('pi');
    expect(findById(docBody, 'pref-plan-mode-claude')).toBeNull();
    const pi = getElement('pref-plan-mode-pi');
    expect(pi.disabled).toBe(true);
    expect(pi.closest('.modal-toggle-field').title).toBe('Provider does not support plan mode');
  });
});

describe('Enter confirmation is stack-aware', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    selectState.reset();
    docBody = makeElement('body');

    mockState.preferences.theme = 'dark';

    vi.stubGlobal('document', {
      documentElement: { dataset: {} as Record<string, string> },
      body: docBody,
      getElementById(id: string) { return findById(docBody, id); },
      createElement(tagName: string) { return makeElement(tagName); },
      createTextNode(text: string) { return { textContent: text }; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal('window', {
      finevibe: {
        provider: {
          listProviders: vi.fn(async () => []),
          checkBinary: vi.fn(async () => true),
        },
        settings: {
          validate: vi.fn(async () => ({ statusLine: 'missing', hooks: 'missing', hookDetails: {} })),
          reinstall: vi.fn(async () => {}),
        },
        menu: { rebuild: vi.fn() },
        app: { getVersion: vi.fn(async () => '0.0.0'), openExternal: vi.fn() },
        update: {
          checkNow: vi.fn(async () => {}),
          onAvailable: vi.fn(() => () => {}),
          onError: vi.fn(() => () => {}),
        },
      },
    });
  });

  it('ignores Enter while a nested dialog is stacked above preferences', async () => {
    const { showPreferencesModal } = await import('./preferences-modal.js');
    const { pushModal, modalStackDepth } = await import('./modal-manager.js');

    showPreferencesModal();
    const overlay = getElement('preferences-overlay');
    expect(overlay.style.display).toBe('');
    expect(modalStackDepth()).toBe(1);

    // Every document keydown listener in play: Preferences' Enter handler plus
    // modal-manager's capture-phase ESC listener, dispatched as a real document
    // would deliver one keypress.
    const keydown = ((document as any).addEventListener as ReturnType<typeof vi.fn>).mock.calls
      .filter(([type]: [string]) => type === 'keydown')
      .map(([, cb]: [string, (e: Record<string, unknown>) => void]) => cb);
    const pressEnter = () => {
      for (const listener of keydown) listener({ key: 'Enter', preventDefault: () => {} });
    };

    // A nested Add-profile / Rename / Delete dialog from modal.ts registers its
    // own Enter handler; Enter there must not also confirm Preferences (which
    // would close the modal the nested dialog lives in).
    const popNested = pushModal({ onEscape: vi.fn() });
    expect(modalStackDepth()).toBe(2);

    pressEnter();
    expect(overlay.style.display).toBe('');
    expect(mockState.setPreference).not.toHaveBeenCalled();

    popNested();
    expect(modalStackDepth()).toBe(1);

    pressEnter();
    expect(overlay.style.display).toBe('none');
  });
});
