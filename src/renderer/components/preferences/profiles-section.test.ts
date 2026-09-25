import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  profiles: [] as any[],
  preferences: { defaultProfileId: undefined as string | undefined },
  addProfile: vi.fn(async () => ({})),
  updateProfile: vi.fn(),
  removeProfile: vi.fn(),
  setPreference: vi.fn(),
}));

const modalState = vi.hoisted(() => ({
  showModal: vi.fn(),
  closeModal: vi.fn(),
  setModalError: vi.fn(),
  showConfirmDialog: vi.fn(),
}));

const selectState = vi.hoisted(() => {
  const instances = new Map<string, {
    options: Array<{ value: string; label: string }>;
    value: string;
    element: Record<string, any>;
    getValue: () => string;
    setValue: (value: string) => void;
    destroy: () => void;
  }>();
  return {
    instances,
    reset() { instances.clear(); },
  };
});

const mockKeychainStatus = vi.hoisted(() => vi.fn());

vi.mock('../../state.js', () => ({ appState: mockState }));
vi.mock('../modal.js', () => ({
  showModal: modalState.showModal,
  closeModal: modalState.closeModal,
  setModalError: modalState.setModalError,
  showConfirmDialog: modalState.showConfirmDialog,
}));
vi.mock('../../platform.js', () => ({ isMac: true, isWin: false, isLinux: false }));
vi.mock('../../provider-availability.js', () => ({
  loadProviderAvailability: vi.fn(async () => {}),
  getAvailableProviderMetas: vi.fn(() => [
    { id: 'claude', displayName: 'Claude Code', capabilities: { profiles: true } },
    { id: 'pi', displayName: 'Pi', capabilities: { profiles: true } },
  ]),
  getProviderCapabilities: vi.fn((id: string) => ({ profiles: id === 'claude' || id === 'pi' })),
}));
vi.mock('../custom-select.js', () => ({
  createCustomSelect: (id: string, options: Array<{ value: string; label: string }>, defaultValue: string) => {
    const element = makeElement('div');
    element.className = 'custom-select';
    const instance = {
      options,
      value: defaultValue,
      element,
      getValue() { return instance.value; },
      setValue(value: string) { instance.value = value; },
      destroy() {},
    };
    selectState.instances.set(id, instance);
    return instance;
  },
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
    title: '',
    id: '',
    parentElement: null,
    appendChild(child: Record<string, any>) {
      child.parentElement = element;
      children.push(child);
      return child;
    },
    addEventListener(event: string, cb: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    removeEventListener(event: string, cb: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners[event.type] ?? []) listener(event);
    },
    classList: {
      add(...tokens: string[]) { tokens.forEach((token) => classValues.add(token)); },
      remove(...tokens: string[]) { tokens.forEach((token) => classValues.delete(token)); },
      toggle(token: string, force?: boolean) {
        if (force ?? !classValues.has(token)) classValues.add(token);
        else classValues.delete(token);
      },
      contains(token: string) { return classValues.has(token); },
    },
  };

  Object.defineProperty(element, 'innerHTML', {
    get() { return ''; },
    set() { children.length = 0; },
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

function collectInTree(root: Record<string, any>, predicate: (node: Record<string, any>) => boolean): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  for (const child of root.children as Record<string, any>[]) {
    if (predicate(child)) found.push(child);
    found.push(...collectInTree(child, predicate));
  }
  return found;
}

function click(el: Record<string, any>): void {
  el.dispatchEvent({ type: 'click' });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeProfile(id: string, name: string, providerId: string) {
  return { id, name, providerId, configDir: `/cfg/${id}`, managed: true, createdAt: 0 };
}

const ctx = {
  isActiveSection: () => true,
  rerenderSection: vi.fn(),
  setSetupBadge: vi.fn(),
  beginRecorder: vi.fn(),
  endRecorder: vi.fn(),
  originalTheme: 'dark' as const,
};

describe('createProfilesSection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    selectState.reset();
    mockState.profiles = [];
    mockState.preferences.defaultProfileId = undefined;
    mockKeychainStatus.mockResolvedValue({ status: 'supported' });

    vi.stubGlobal('document', {
      createElement: (tagName: string) => makeElement(tagName),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      body: makeElement('body'),
    });
    vi.stubGlobal('window', {
      vibeyard: { profiles: { keychainStatus: mockKeychainStatus } },
    });
  });

  async function render() {
    const { createProfilesSection } = await import('./profiles-section.js');
    const container = makeElement('div');
    createProfilesSection(ctx).render(container);
    return container;
  }

  it('lists pi profiles alongside claude profiles, each with a provider tag', async () => {
    mockState.profiles = [
      makeProfile('work', 'Work', 'claude'),
      makeProfile('home', 'Home', 'pi'),
    ];
    const container = await render();

    expect(findInTree(container, (n) => n.textContent === 'Work')).not.toBeNull();
    expect(findInTree(container, (n) => n.textContent === 'Home')).not.toBeNull();
    const providerTags = collectInTree(container, (n) => n.className === 'profile-row-tag profile-row-tag-provider');
    expect(providerTags.map((n) => n.textContent)).toEqual(['claude', 'pi']);
  });

  it('ignores non-profile-capable profiles in the list', async () => {
    mockState.profiles = [
      makeProfile('work', 'Work', 'claude'),
      makeProfile('gem', 'Gem', 'gemini'),
    ];
    const container = await render();

    expect(findInTree(container, (n) => n.textContent === 'Work')).not.toBeNull();
    expect(findInTree(container, (n) => n.textContent === 'Gem')).toBeNull();
  });

  it('lists pi profiles in the default-profile selector with the provider in the label', async () => {
    mockState.profiles = [
      makeProfile('work', 'Work', 'claude'),
      makeProfile('home', 'Home', 'pi'),
    ];
    await render();

    const select = selectState.instances.get('pref-default-profile');
    expect(select?.options).toEqual([
      { value: '', label: 'Default' },
      { value: 'work', label: 'Work · claude' },
      { value: 'home', label: 'Home · pi' },
    ]);
  });

  it('offers a provider field in the add modal, defaulting to claude', async () => {
    const container = await render();
    click(findInTree(container, (n) => n.className === 'btn-primary')!);
    await flush();

    expect(modalState.showModal).toHaveBeenCalledTimes(1);
    const fields = modalState.showModal.mock.calls[0][1];
    const providerField = fields.find((f: any) => f.id === 'profile-provider');
    expect(providerField).toBeDefined();
    expect(providerField.type).toBe('select');
    expect(providerField.defaultValue).toBe('claude');
    expect(providerField.options).toEqual([
      { value: 'claude', label: 'Claude Code' },
      { value: 'pi', label: 'Pi' },
    ]);
  });

  it('blocks claude profile creation when the keychain status is unsupported', async () => {
    mockKeychainStatus.mockResolvedValue({ status: 'unsupported', version: '2.1.19' });
    const container = await render();
    await flush(); // render() caches the keychain status
    click(findInTree(container, (n) => n.className === 'btn-primary')!);
    await flush();

    const onConfirm = modalState.showModal.mock.calls[0][2];
    await onConfirm({ 'profile-name': 'Work', 'profile-provider': 'claude', 'profile-path': '' });

    expect(modalState.setModalError).toHaveBeenCalledWith('profile-name', expect.stringContaining('Claude Code'));
    expect(mockState.addProfile).not.toHaveBeenCalled();
  });

  it('skips the keychain guard for pi profiles', async () => {
    mockKeychainStatus.mockResolvedValue({ status: 'unsupported', version: '2.1.19' });
    const container = await render();
    await flush(); // render() caches the keychain status
    click(findInTree(container, (n) => n.className === 'btn-primary')!);
    await flush();

    const onConfirm = modalState.showModal.mock.calls[0][2];
    await onConfirm({ 'profile-name': 'PiWork', 'profile-provider': 'pi', 'profile-path': '' });

    expect(mockState.addProfile).toHaveBeenCalledWith({ name: 'PiWork', providerId: 'pi', customPath: undefined });
    expect(modalState.setModalError).not.toHaveBeenCalled();
  });
});
