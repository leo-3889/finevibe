import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CsiHandler = (params: number[]) => boolean;
type KeyHandler = (event: KeyboardEvent) => boolean | undefined;

class FakeTerminal {
  options: Record<string, unknown>;

  /** Captured DEC-private-mode handlers, keyed by CSI final byte (`?9001h/l`). */
  csiHandlers = new Map<string, CsiHandler>();

  customKeyHandler?: KeyHandler;

  private selection = '';

  parser = {
    registerCsiHandler: (id: { final: string }, handler: CsiHandler) => {
      this.csiHandlers.set(id.final, handler);
      return { dispose(): void {} };
    },
  };

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
  }

  loadAddon(): void {}
  onData(): void {}
  onSelectionChange(): void {}
  open(): void {}
  write(): void {}
  dispose(): void {}
  attachCustomKeyEventHandler(handler: KeyHandler): void {
    this.customKeyHandler = handler;
  }

  // Selection surface the shared clipboard handler uses (Cmd+C / Ctrl+Shift+C).
  getSelection(): string { return this.selection; }
  hasSelection(): boolean { return this.selection.length > 0; }
  setSelection(value: string): void { this.selection = value; }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = () => ({ dispose() {} });
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

// The shared key handler (`terminal-utils.attachClipboardCopyHandler`) reads the
// platform live, so the mac Edit-chord cases below can flip it. Default false:
// the win32 cases must not depend on the host that runs the suite.
const mockPlatform = vi.hoisted(() => ({ isMac: false, isWin: false, isLinux: true }));
vi.mock('../platform.js', () => ({
  get isMac() { return mockPlatform.isMac; },
  get isWin() { return mockPlatform.isWin; },
  get isLinux() { return mockPlatform.isLinux; },
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

  // `shortcuts.ts` scans for open overlays on every key it is asked about; the
  // pane tests never open one.
  querySelectorAll(): FakeElement[] {
    return [];
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

  // Audit row 115: the guest pane drives a host TUI, so Option must arrive as
  // Meta (ESC-prefix) there too — pinning a readwrite pane proves the option
  // is not gated on the readonly/disableStdin branch. macOptionClickForces
  // Selection stays unset (false): row 69 owns Option+click.
  it('constructs remote panes with macOptionIsMeta enabled', async () => {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');

    _resetForTesting();
    createRemoteTerminalPane('remote-meta', 'readwrite', 80, 24, () => {});
    const options = (getRemoteTerminalInstance('remote-meta')!.terminal as unknown as FakeTerminal).options;

    expect(options.macOptionIsMeta).toBe(true);
    expect(options.macOptionClickForcesSelection).toBeUndefined();
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

describe('remote pane win32-input-mode keys', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('document', new FakeDocument());
  });

  function press(terminal: FakeTerminal, name: string, extra: Record<string, unknown> = {}) {
    return terminal.customKeyHandler?.({
      key: name,
      type: 'keydown',
      preventDefault: vi.fn(),
      ...extra,
    } as unknown as KeyboardEvent);
  }

  it('forwards Escape as an INPUT_RECORD while the host PTY has mode 9001 on', async () => {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');
    _resetForTesting();
    const onInput = vi.fn();
    createRemoteTerminalPane('remote-win32', 'readwrite', 80, 24, onInput);
    const terminal = getRemoteTerminalInstance('remote-win32')!.terminal as unknown as FakeTerminal;

    // Mode off: every key is left to xterm (true = not suppressed).
    expect(press(terminal, 'Escape')).toBe(true);
    expect(onInput).not.toHaveBeenCalled();

    // The host's ConPTY requests win32-input-mode; its ?9001h reaches this
    // parser through writeRemoteData.
    expect(terminal.csiHandlers.get('h')!([9001, 1004])).toBe(false);

    expect(press(terminal, 'Escape')).toBe(false);
    expect(onInput).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');

    // Non-target keys still pass through; the host PTY receives the plain text.
    expect(press(terminal, 'a')).toBe(true);
    expect(onInput).toHaveBeenCalledTimes(1);

    // ConPTY's arming is monotonic: after `?9001l` the encoder keeps
    // consuming Escape — a bare ESC byte would die in the armed ConPTY.
    terminal.csiHandlers.get('l')!([9001]);
    expect(press(terminal, 'Escape')).toBe(false);
    // The encoder keeps forwarding INPUT_RECORDs to the PTY.
    expect(onInput).toHaveBeenCalledTimes(2);
  });

  it('read-only panes attach no custom key handler', async () => {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');
    _resetForTesting();
    const onInput = vi.fn();
    createRemoteTerminalPane('remote-win32-ro', 'readonly', 80, 24, onInput);
    const terminal = getRemoteTerminalInstance('remote-win32-ro')!.terminal as unknown as FakeTerminal;

    expect(terminal.customKeyHandler).toBeUndefined();
  });
});

// Rows 92/70 follow-up (`e8295d11` gap): the guest pane installed only the
// win32 encoder, so the mac Edit chords died there while the local panes
// answered them — xterm writes no byte for a meta-only a/c/x/z and the Edit
// menu hands those keys back to the renderer. Mirrors the mac chord cases in
// terminal-utils.test.ts on the REMOTE pane, because the bug was the wiring,
// not the shared handler.
describe('remote pane mac Edit chords', () => {
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('document', new FakeDocument());
    vi.stubGlobal('window', { finevibe: { clipboard: { write: clipboardWrite } } });
    mockPlatform.isMac = true;
    mockPlatform.isWin = false;
  });

  afterEach(() => {
    mockPlatform.isMac = false;
    vi.unstubAllGlobals();
  });

  function press(terminal: FakeTerminal, event: Record<string, unknown>) {
    return terminal.customKeyHandler?.({
      type: 'keydown',
      preventDefault: vi.fn(),
      ...event,
    } as unknown as KeyboardEvent);
  }

  async function readwritePane(id: string) {
    const { createRemoteTerminalPane, getRemoteTerminalInstance, _resetForTesting } = await import('./remote-terminal-pane.js');
    _resetForTesting();
    const onInput = vi.fn();
    createRemoteTerminalPane(id, 'readwrite', 80, 24, onInput);
    return { terminal: getRemoteTerminalInstance(id)!.terminal as unknown as FakeTerminal, onInput };
  }

  it('copies a selection with Cmd+C through main instead of writing a byte to the host', async () => {
    const { terminal, onInput } = await readwritePane('remote-cmd-c');
    terminal.setSelection('remote-copy');

    expect(press(terminal, { key: 'c', code: 'KeyC', metaKey: true })).toBe(false);

    expect(clipboardWrite).toHaveBeenCalledWith('remote-copy', 'explicit');
    expect(onInput).not.toHaveBeenCalled();
  });

  it('sends Ctrl+C to the host for a bare Cmd+C (no selection)', async () => {
    const { terminal, onInput } = await readwritePane('remote-cmd-sigint');

    expect(press(terminal, { key: 'c', code: 'KeyC', metaKey: true })).toBe(false);

    expect(onInput).toHaveBeenCalledWith('\x03');
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('forwards Cmd+A/X/Z as their Ctrl bytes', async () => {
    const { terminal, onInput } = await readwritePane('remote-cmd-bytes');

    press(terminal, { key: 'a', code: 'KeyA', metaKey: true });
    press(terminal, { key: 'x', code: 'KeyX', metaKey: true });
    press(terminal, { key: 'z', code: 'KeyZ', metaKey: true });

    expect(onInput.mock.calls.map(([data]) => data)).toEqual(['\x01', '\x18', '\x1a']);
  });

  // Row 92 follow-up: the chord table is keyed by the PHYSICAL key, so a
  // Cyrillic layout (e.key='И' on the physical C) still copies.
  it('copies with Cmd+И on a non-Latin layout', async () => {
    const { terminal, onInput } = await readwritePane('remote-cmd-cyrillic');
    terminal.setSelection('remote-cyrillic');

    expect(press(terminal, { key: 'И', code: 'KeyC', metaKey: true })).toBe(false);

    expect(clipboardWrite).toHaveBeenCalledWith('remote-cyrillic', 'explicit');
    expect(onInput).not.toHaveBeenCalled();
  });

  it('keeps the win32 encoder alive behind the shared handler', async () => {
    // xterm keeps ONE custom key handler: the shared attach must chain the
    // encoder, not replace it, or Escape goes back to a bare ESC on a ConPTY
    // host (the row the encoder exists for).
    const { terminal, onInput } = await readwritePane('remote-both-handlers');
    terminal.csiHandlers.get('h')!([9001]);

    expect(press(terminal, { key: 'Escape' })).toBe(false);

    expect(onInput).toHaveBeenCalledWith('\x1b[27;1;27;1;0;1_');
    expect(clipboardWrite).not.toHaveBeenCalled();
  });
});
