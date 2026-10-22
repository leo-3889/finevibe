import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
// Terminal copies go through the main process, not navigator.clipboard (#160).
const mockFineVibeClipboardWrite = vi.fn().mockResolvedValue(undefined);
const mockPtyWrite = vi.fn();

class FakeTerminal {
  cols = 120;
  rows = 30;
  options: Record<string, unknown>;
  private keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  // win32-input-mode detection captures the `?9001h/l` CSI handlers here so a
  // test can flip mode 9001 on the pane's terminal, as node-pty's startup
  // request does on a real Windows ConPTY.
  csiHandlers = new Map<string, (params: number[]) => boolean>();
  parser = {
    registerCsiHandler: (id: { final: string }, cb: (params: number[]) => boolean) => {
      this.csiHandlers.set(id.final, cb);
      return { dispose() {} };
    },
  };
  enableWin32Mode(on: boolean): void {
    this.csiHandlers.get(on ? 'h' : 'l')!([9001]);
  }
  private _selection = '';

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
  }

  loadAddon(): void {}
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  simulateKey(event: Partial<KeyboardEvent>): boolean {
    return this.keyHandler ? this.keyHandler(event as KeyboardEvent) : true;
  }
  getSelection(): string { return this._selection; }
  setSelection(s: string): void { this._selection = s; }
  onSelectionChange(_listener: () => void): { dispose(): void } { return { dispose() {} }; }
  onData(_cb: (data: string) => void): void {}
  open(): void {}
  write(): void {}
  focus(): void {}
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
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

const mockStateOn = vi.fn();

vi.mock('../state.js', () => ({
  appState: {
    projects: [],
    activeProject: null,
    preferences: { theme: 'dark' },
    on: (...args: unknown[]) => mockStateOn(...args),
    setTerminalPanelOpen: vi.fn(),
    setTerminalPanelHeight: vi.fn(),
  },
}));

vi.mock('./terminal-pane.js', () => ({ fitAllVisible: vi.fn() }));
vi.mock('./search-bar.js', () => ({ destroySearchBar: vi.fn(), hideSearchBar: vi.fn() }));
vi.mock('../shortcuts.js', () => ({
  shortcutManager: { getKeys: vi.fn(() => []), matchEvent: vi.fn(() => false), matchesAnyShortcut: vi.fn(() => false) },
  displayKeys: vi.fn(() => ''),
}));

class FakeEl {
  style: Record<string, string> = {};
  classList = { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) };
  children: FakeEl[] = [];
  offsetHeight = 200;

  addEventListener(): void {}
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  contains(): boolean { return false; }
  querySelector(): null { return null; }
  observe(): void {}
}

function makeFakeDocument() {
  const els = new Map<string, FakeEl>();
  return {
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, new FakeEl());
      return els.get(id)!;
    },
    createElement: () => new FakeEl(),
    addEventListener: vi.fn(),
    body: new FakeEl(),
  };
}

describe('project-terminal Ctrl+Shift+C clipboard copy', () => {
  let stateHandlers: Record<string, (() => void)[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    stateHandlers = {};
    mockStateOn.mockImplementation((event: string, cb: () => void) => {
      if (!stateHandlers[event]) stateHandlers[event] = [];
      stateHandlers[event].push(cb);
    });

    vi.stubGlobal('document', makeFakeDocument());
    vi.stubGlobal('window', {
      finevibe: {
        pty: { write: mockPtyWrite, kill: vi.fn(), resize: vi.fn(), createShell: vi.fn() },
        clipboard: { write: mockFineVibeClipboardWrite },
      },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: mockClipboardWrite } });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  });

  async function setupTerminal() {
    const { appState } = await import('../state.js');
    const { initProjectTerminal, getShellTerminalInstance, getActiveShellSessionId } = await import('./project-terminal.js');

    const project = { id: 'proj1', path: '/project', terminalPanelOpen: true, terminalPanelHeight: 200, sessions: [] };
    (appState as any).activeProject = project;
    (appState as any).projects = [project];

    initProjectTerminal();

    // Trigger state-loaded → showPanel → createShell
    stateHandlers['state-loaded']?.forEach(cb => cb());

    const sessionId = getActiveShellSessionId();
    return sessionId ? getShellTerminalInstance(sessionId) : undefined;
  }

  it('copies selected text to clipboard on Ctrl+Shift+C keydown', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    term.setSelection('copied text');
    term.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith('copied text', 'explicit');
  });

  it('does not copy on keyup', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    term.setSelection('some text');
    term.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keyup' });

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not copy when nothing is selected', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    term.setSelection('');
    term.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('returns false to prevent default on Ctrl+Shift+C', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    const result = term.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(result).toBe(false);
  });

  it('routes Escape through the win32 INPUT_RECORD encoder when mode 9001 is on', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    // node-pty's startup request enables win32-input-mode on the shell pane.
    term.enableWin32Mode(true);
    const result = term.simulateKey({ key: 'Escape', type: 'keydown', preventDefault: vi.fn() });

    // A bare ESC is swallowed by ConPTY's parser under mode 9001, so the pane
    // writes the spec #4999 INPUT_RECORD to the shell PTY and suppresses xterm.
    expect(mockPtyWrite).toHaveBeenCalledWith(instance!.sessionId, '\x1b[27;1;27;1;0;1_');
    expect(result).toBe(false);
  });

  it('leaves Escape to xterm when mode 9001 is off', async () => {
    const instance = await setupTerminal();
    const term = instance!.terminal as unknown as FakeTerminal;

    const result = term.simulateKey({ key: 'Escape', type: 'keydown' });

    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('applyThemeToAllShells()', () => {
  let stateHandlers: Record<string, (() => void)[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    stateHandlers = {};
    mockStateOn.mockImplementation((event: string, cb: () => void) => {
      if (!stateHandlers[event]) stateHandlers[event] = [];
      stateHandlers[event].push(cb);
    });

    vi.stubGlobal('document', makeFakeDocument());
    vi.stubGlobal('window', {
      finevibe: {
        pty: { write: mockPtyWrite, kill: vi.fn(), resize: vi.fn(), createShell: vi.fn() },
      },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: mockClipboardWrite } });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  });

  it('updates existing shell terminals to the selected theme', async () => {
    const { darkTerminalTheme, lightTerminalTheme } = await import('../terminal-theme.js');
    const { appState } = await import('../state.js');
    const { initProjectTerminal, getShellTerminalInstance, getActiveShellSessionId, applyThemeToAllShells } = await import('./project-terminal.js');

    const project = { id: 'proj1', path: '/project', terminalPanelOpen: true, terminalPanelHeight: 200, sessions: [] };
    (appState as any).activeProject = project;
    (appState as any).projects = [project];

    initProjectTerminal();
    stateHandlers['state-loaded']?.forEach(cb => cb());

    const sessionId = getActiveShellSessionId()!;
    const instance = getShellTerminalInstance(sessionId)!;

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(darkTerminalTheme);

    applyThemeToAllShells('light');

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(lightTerminalTheme);
  });

  it('uses the current light theme for newly created shell terminals', async () => {
    const { lightTerminalTheme } = await import('../terminal-theme.js');
    const { appState } = await import('../state.js');
    const { initProjectTerminal, getShellTerminalInstance, getActiveShellSessionId } = await import('./project-terminal.js');

    const project = { id: 'proj1', path: '/project', terminalPanelOpen: true, terminalPanelHeight: 200, sessions: [] };
    (appState as any).activeProject = project;
    (appState as any).projects = [project];
    (appState as any).preferences.theme = 'light';

    initProjectTerminal();
    stateHandlers['state-loaded']?.forEach(cb => cb());

    const sessionId = getActiveShellSessionId()!;
    const instance = getShellTerminalInstance(sessionId)!;

    expect((instance.terminal as unknown as FakeTerminal).options.theme).toBe(lightTerminalTheme);
  });
});

describe('project-terminal fit resize (P3-10)', () => {
  let stateHandlers: Record<string, (() => void)[]>;
  let mockPtyResize: ReturnType<typeof vi.fn>;
  let unhandled: unknown[];
  const onUnhandled = (err: unknown) => { unhandled.push(err); };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    stateHandlers = {};
    mockStateOn.mockImplementation((event: string, cb: () => void) => {
      if (!stateHandlers[event]) stateHandlers[event] = [];
      stateHandlers[event].push(cb);
    });
    mockPtyResize = vi.fn();

    vi.stubGlobal('document', makeFakeDocument());
    vi.stubGlobal('window', {
      finevibe: {
        pty: {
          write: mockPtyWrite,
          kill: vi.fn(),
          resize: mockPtyResize,
          createShell: vi.fn().mockResolvedValue(undefined),
        },
        clipboard: { write: mockFineVibeClipboardWrite },
      },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: mockClipboardWrite } });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  });

  it('sends one resize per geometry change and swallows rejected resizes', async () => {
    const { appState } = await import('../state.js');
    const m = await import('./project-terminal.js');
    const project = { id: 'proj1', path: '/project', terminalPanelOpen: true, terminalPanelHeight: 200, sessions: [] };
    (appState as any).activeProject = project;
    (appState as any).projects = [project];
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);

    try {
      m.initProjectTerminal();
      const show = () => stateHandlers['state-loaded']?.forEach((cb) => cb());
      const sent = () => mockPtyResize.mock.calls.map((c) => `${c[1]}x${c[2]}`);
      show();
      const sessionId = m.getActiveShellSessionId()!;
      const instance = m.getShellTerminalInstance(sessionId)!;
      const base = sent().length;
      expect(base).toBeGreaterThan(0);

      // Two more show cycles at an UNCHANGED geometry: the memo keeps the
      // wire quiet — every fit past the first is a byte-identical 120x30.
      show();
      show();
      expect(sent()).toHaveLength(base);

      (instance.terminal as unknown as FakeTerminal).rows = 24;
      show();
      expect(sent()).toHaveLength(base + 1);
      expect(sent()[base]).toBe('120x24');

      // A PTY that died between fit and IPC used to reject into the void:
      // the promise is now attached and swallowed.
      mockPtyResize.mockImplementation(() => Promise.reject(new Error('pty is gone')));
      (instance.terminal as unknown as FakeTerminal).rows = 20;
      show();
      expect(sent()).toHaveLength(base + 2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// C5R-05: '+ New Terminal' was uncapped — every pane pins a PTY + ConPTY +
// xterm, and exited shells (pane + overlay + label alive) count toward the
// 50-per-project cap. Beyond it the click is refused with the note swapped
// into the button label/title, the file's only chrome-level channel.
describe('project-terminal shell cap (C5R-05)', () => {
  class ChromeFakeEl extends FakeEl {
    innerHTML = '';
    textContent = '';
    className = '';
    querySelectorAll(): HTMLElement[] { return []; }
  }
  class ClickableFakeEl extends ChromeFakeEl {
    listeners: Record<string, Array<() => void>> = {};
    textContent = '+';
    title = '';
    addEventListener(type: string, cb: () => void): void {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(cb);
    }
  }

  let newBtn: ClickableFakeEl;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    newBtn = new ClickableFakeEl();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'btn-new-terminal' ? newBtn : new ChromeFakeEl()),
      // esc() reads innerHTML off created spans; the chrome elements need
      // querySelectorAll/innerHTML for renderSidebar's escape+rebind path.
      createElement: () => {
        const el = new ChromeFakeEl();
        el.innerHTML = '';
        el.textContent = '';
        el.className = '';
        return el;
      },
      addEventListener: vi.fn(),
      body: new FakeEl(),
    });
    vi.stubGlobal('window', {
      finevibe: { pty: { write: mockPtyWrite, kill: vi.fn(), resize: vi.fn(), createShell: vi.fn() } },
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: mockClipboardWrite } });
    vi.stubGlobal('ResizeObserver', class { observe(): void {} });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  });

  it('refuses the 51st shell and notes the cap on the button', async () => {
    const { appState } = await import('../state.js');
    const { initProjectTerminal } = await import('./project-terminal.js');
    (appState as any).activeProject = { id: 'proj1', path: '/project', terminalPanelOpen: true, terminalPanelHeight: 200, sessions: [] };
    (appState as any).projects = [(appState as any).activeProject];
    initProjectTerminal();

    const clicks = newBtn.listeners['click'] ?? [];
    expect(clicks.length).toBe(1);
    for (let i = 0; i < 50; i++) clicks[0]();
    expect(newBtn.textContent).toBe('+'); // the 50th creation is allowed

    clicks[0](); // the 51st
    expect(newBtn.textContent).toBe('50');
    expect(String(newBtn.title)).toContain('Terminal limit reached');
  });
});
