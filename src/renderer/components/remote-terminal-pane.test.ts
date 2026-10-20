import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeTerminal {
  options: Record<string, unknown>;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
  }

  loadAddon(): void {}
  onData(): void {}
  onSelectionChange(): void {}
  open(): void {}
  write(): void {}
  dispose(): void {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = (_: () => void) => ({ dispose() {} });
    dispose() {}
  },
}));
vi.mock('../state.js', () => ({
  appState: {
    preferences: { theme: 'dark' },
  },
}));

const mockShowContextMenu = vi.hoisted(() => vi.fn());
vi.mock('./terminal-context-menu.js', () => ({
  showTerminalContextMenu: (...args: unknown[]) => mockShowContextMenu(...args),
}));

class FakeClassList {
  private values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  textContent = '';
  innerHTML = '';

  appendChild(child: FakeElement): FakeElement {
    // Mirror the DOM: appending a node that already has a parent moves it.
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  listeners = new Map<string, Array<(e: any) => void>>();

  addEventListener(type: string, handler: (e: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  fire(type: string, event: any = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.find((child) => child.className.split(/\s+/).includes(className));
  }

  private find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  createElement(): FakeElement {
    return new FakeElement();
  }
}

describe('applyThemeToAllRemoteTerminals()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('document', new FakeDocument());
  });

  it('updates existing remote terminals to the selected theme', async () => {
    const { darkTerminalTheme, lightTerminalTheme } = await import('../terminal-theme.js');
    const { createRemoteTerminalPane, getRemoteTerminalInstance, applyThemeToAllRemoteTerminals, _resetForTesting } = await import('./remote-terminal-pane.js');

    _resetForTesting();
    createRemoteTerminalPane('remote-1', 'readonly', 80, 24, () => {});
    const instance = getRemoteTerminalInstance('remote-1')!;

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(darkTerminalTheme);

    applyThemeToAllRemoteTerminals('light');

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(lightTerminalTheme);
  });

  it('uses the current light theme for newly created remote terminals', async () => {
    const { lightTerminalTheme } = await import('../terminal-theme.js');
    const { appState } = await import('../state.js');
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');

    appState.preferences.theme = 'light';

    _resetForTesting();
    createRemoteTerminalPane('remote-2', 'readonly', 80, 24, () => {});
    const instance = getRemoteTerminalInstance('remote-2')!;

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(lightTerminalTheme);
  });
});

describe('attachRemoteToContainer()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('document', new FakeDocument());
  });

  /** Stand in for the .xterm node terminal.open() would have created. */
  function markOpened(element: FakeElement): void {
    const screen = new FakeElement();
    screen.className = 'xterm';
    element.querySelector('.xterm-wrap')!.appendChild(screen);
  }

  it('does not re-append a pane that is already in the container', async () => {
    // appendChild on an existing child removes and re-inserts it, blurring
    // whatever is focused inside and collapsing any selection.
    const { createRemoteTerminalPane, attachRemoteToContainer, getRemoteTerminalInstance, _resetForTesting } =
      await import('./remote-terminal-pane.js');
    const container = new FakeElement();

    _resetForTesting();
    createRemoteTerminalPane('remote-attach', 'readonly', 80, 24, () => {});
    attachRemoteToContainer('remote-attach', container as unknown as HTMLElement);

    const element = getRemoteTerminalInstance('remote-attach')!.element as unknown as FakeElement;
    markOpened(element);

    attachRemoteToContainer('remote-attach', container as unknown as HTMLElement);
    attachRemoteToContainer('remote-attach', container as unknown as HTMLElement);

    expect(container.children).toEqual([element]);
  });

  it('moves a pane attached to a different container', async () => {
    const { createRemoteTerminalPane, attachRemoteToContainer, getRemoteTerminalInstance, _resetForTesting } =
      await import('./remote-terminal-pane.js');
    const first = new FakeElement();
    const second = new FakeElement();

    _resetForTesting();
    createRemoteTerminalPane('remote-move', 'readonly', 80, 24, () => {});
    attachRemoteToContainer('remote-move', first as unknown as HTMLElement);

    const element = getRemoteTerminalInstance('remote-move')!.element as unknown as FakeElement;
    markOpened(element);

    attachRemoteToContainer('remote-move', second as unknown as HTMLElement);

    expect(first.children).toEqual([]);
    expect(second.children).toEqual([element]);
  });
});

describe('remote pane context menu', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('document', new FakeDocument());
  });

  it('opens the terminal context menu wired to the data channel (readwrite)', async () => {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');
    _resetForTesting();
    const onInput = vi.fn();
    createRemoteTerminalPane('remote-menu', 'readwrite', 80, 24, onInput);
    const element = getRemoteTerminalInstance('remote-menu')!.element as unknown as FakeElement;

    element.fire('contextmenu', { clientX: 10, clientY: 20, preventDefault: vi.fn() });

    expect(mockShowContextMenu).toHaveBeenCalledTimes(1);
    const [x, y, , write] = mockShowContextMenu.mock.calls[0] as [
      number, number, unknown, (data: string) => void,
    ];
    expect(x).toBe(10);
    expect(y).toBe(20);
    write('ls\r');
    expect(onInput).toHaveBeenCalledWith('ls\r');
  });

  it('read-only panes get a context menu whose writes are dropped', async () => {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');
    _resetForTesting();
    const onInput = vi.fn();
    createRemoteTerminalPane('remote-ro', 'readonly', 80, 24, onInput);
    const element = getRemoteTerminalInstance('remote-ro')!.element as unknown as FakeElement;

    element.fire('contextmenu', { clientX: 1, clientY: 2, preventDefault: vi.fn() });

    expect(mockShowContextMenu).toHaveBeenCalledTimes(1);
    const write = mockShowContextMenu.mock.calls[0][3] as (data: string) => void;
    write('rm -rf /\r');
    expect(onInput).not.toHaveBeenCalled();
  });
});
