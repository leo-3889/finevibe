// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMatchesAnyShortcut, mockMatchEvent, mockPlatform, mockPreferences, mockActiveSession, webglState } = vi.hoisted(() => ({
  mockMatchesAnyShortcut: vi.fn(() => false),
  mockMatchEvent: vi.fn(() => false),
  mockPlatform: { isMac: false, isWin: false, isLinux: true },
  mockPreferences: { copyOnSelect: false } as { copyOnSelect: boolean },
  // The pane-alert banner attaches to the active session's mounted pane
  // (P1-20 rejections surface there).
  mockActiveSession: { current: null as { id: string } | null },
  webglState: {
    shouldThrow: false,
    lastInstance: null as null | { dispose: ReturnType<typeof vi.fn>; fireContextLoss: () => void },
  },
}));
vi.mock('../shortcuts.js', () => ({
  shortcutManager: {
    matchesAnyShortcut: (...args: unknown[]) => mockMatchesAnyShortcut(...args),
    matchEvent: (...args: unknown[]) => mockMatchEvent(...args),
  },
}));
vi.mock('../platform.js', () => ({
  get isMac() { return mockPlatform.isMac; },
  get isWin() { return mockPlatform.isWin; },
  get isLinux() { return mockPlatform.isLinux; },
}));
vi.mock('../state.js', () => ({
  appState: {
    get preferences() { return mockPreferences; },
    get activeSession() { return mockActiveSession.current; },
    on: () => {},
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    private listener: (() => void) | null = null;
    dispose = vi.fn();
    onContextLoss = (listener: () => void) => {
      this.listener = listener;
      return { dispose() {} };
    };
    constructor() {
      if (webglState.shouldThrow) throw new Error('no webgl');
      webglState.lastInstance = {
        dispose: this.dispose,
        fireContextLoss: () => this.listener?.(),
      };
    }
  },
}));

import { attachClipboardCopyHandler, attachCopyOnSelect, attachFileDropHandler, attachImagePasteHandler, collapseArmedTextareaOnContextMenu, copySelection, copyText, loadWebglWithFallback, pasteIntoTerminal, quoteShellPath, _resetClipboardCopyStateForTesting } from './terminal-utils.js';

const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
// P3: clipboard writes are fire-and-forget `ipcRenderer.send` — void, no
// promise round trip (the invoke twin paid a structured-clone reply per copy).
const mockFineVibeClipboardWrite = vi.fn();
const mockReadForPaste = vi.fn();
const mockSaveImage = vi.fn();
const mockGetDroppedFilePath = vi.fn();

// What main reports for a clipboard read; every case overrides what it varies on.
function pastePayload(
  overrides: Partial<{ text: string; html: string; files: string[]; imagePath: string | null; hasContent: boolean; textTruncated?: boolean }> = {}
) {
  return { text: '', html: '', files: [], imagePath: null, hasContent: false, ...overrides };
}

// Stand-in for the DataTransfer of a native paste event.
function fakeDataTransfer(files: File[] = [], text = '', html = ''): DataTransfer {
  return {
    files,
    types: files.length > 0 ? ['Files'] : html ? ['text/html'] : ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
    dropEffect: '',
    preventDefault: vi.fn(),
  } as unknown as DataTransfer;
}

// Mount the pane shape the pane-alert banner attaches to.
function mountPaneForBanner(): HTMLElement {
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.dataset.sessionId = 't1';
  const wrap = document.createElement('div');
  wrap.className = 'xterm-wrap';
  pane.appendChild(wrap);
  document.body.appendChild(pane);
  mockActiveSession.current = { id: 't1' };
  return pane;
}

afterEach(() => {
  document.body.innerHTML = '';
  mockActiveSession.current = null;
});

// Stand-in for the pane element the paste/drop handlers are attached to.
class FakeElement {
  private listeners = new Map<string, ((e: any) => void)[]>();
  classList = { add: vi.fn(), remove: vi.fn() };
  contains(node: unknown): boolean { return node === this; }
  addEventListener(type: string, fn: (e: any) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }
  fire(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

class FakeTerminal {
  private keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  private selectionListener: (() => void) | null = null;
  private _selection = '';
  modes = { bracketedPasteMode: false };

  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }
  simulateKey(event: Partial<KeyboardEvent>): boolean {
    return this.keyHandler ? this.keyHandler(event as KeyboardEvent) : true;
  }
  onSelectionChange(listener: () => void): { dispose(): void } {
    this.selectionListener = listener;
    return { dispose: () => { this.selectionListener = null; } };
  }
  fireSelectionChange(): void { this.selectionListener?.(); }
  getSelection(): string { return this._selection; }
  hasSelection(): boolean { return this._selection.length > 0; }
  setSelection(s: string): void { this._selection = s; }

  // Stand-ins for the DOM nodes xterm exposes once opened.
  element?: { addEventListener(type: string, fn: () => void): void };
  textarea?: { value: string; selectionRange: null | [number, number]; setSelectionRange(s: number, e: number): void };
  private contextMenuListener: (() => void) | null = null;
  focus = vi.fn();

  open(): void {
    this.textarea = {
      value: '',
      selectionRange: null,
      setSelectionRange(start: number, end: number) { this.selectionRange = [start, end]; },
    };
    this.element = {
      addEventListener: (type: string, fn: () => void) => {
        if (type === 'contextmenu') this.contextMenuListener = fn;
      },
    };
  }
  fireContextMenu(): void { this.contextMenuListener?.(); }
}

function stubPlatform(platform: string) {
  vi.stubGlobal('navigator', {
    platform,
    clipboard: { writeText: mockClipboardWrite },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadForPaste.mockResolvedValue(pastePayload());
  mockSaveImage.mockResolvedValue(null);
  mockGetDroppedFilePath.mockReturnValue('');
  mockMatchesAnyShortcut.mockReturnValue(false);
  mockMatchEvent.mockReturnValue(false);
  mockPreferences.copyOnSelect = false;
  vi.stubGlobal('window', {
    finevibe: {
      clipboard: {
        write: mockFineVibeClipboardWrite,
        readForPaste: mockReadForPaste,
        saveImage: mockSaveImage,
      },
      fs: { getDroppedFilePath: mockGetDroppedFilePath },
    },
  });
});

describe('attachClipboardCopyHandler (macOS)', () => {
  beforeEach(() => {
    stubPlatform('MacIntel');
    mockPlatform.isMac = true;
    mockPlatform.isWin = false;
  });

  it('copies selected text to clipboard on Ctrl+Shift+C keydown', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('hello');
    terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith('hello', 'explicit');
    // #160: no copy path may touch navigator.clipboard — the main process
    // writes a single plain-text flavor, Chromium's copy also writes rich ones.
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not copy on keyup', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('hello');
    terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keyup' });

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not copy when nothing is selected', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('');
    terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('returns false on Ctrl+Shift+C to prevent default', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(result).toBe(false);
  });

  it('returns false on Ctrl+F to let document handle search', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'f', type: 'keydown' });

    expect(result).toBe(false);
  });

  it('returns true for unhandled keys', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ key: 'a', type: 'keydown' });

    expect(result).toBe(true);
  });

  it('delegates unhandled keys to extend handler', () => {
    const terminal = new FakeTerminal();
    const extend = vi.fn().mockReturnValue(false);
    attachClipboardCopyHandler(terminal as any, extend);

    terminal.simulateKey({ key: 'Enter', shiftKey: true, type: 'keydown' });

    expect(extend).toHaveBeenCalled();
  });

  it('returns true when extend handler returns undefined', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any, () => undefined);

    const result = terminal.simulateKey({ key: 'a', type: 'keydown' });

    expect(result).toBe(true);
  });

  it('does not intercept Ctrl+C (lets xterm send SIGINT)', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('hello');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keydown' });

    expect(result).toBe(true);
    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not intercept Ctrl+V (lets xterm send control char)', () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown' });

    expect(result).toBe(true);
    expect(writeToPty).not.toHaveBeenCalled();
  });
});

describe('attachClipboardCopyHandler (Windows)', () => {
  beforeEach(() => {
    stubPlatform('Win32');
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
  });

  it('Ctrl+C copies selection and returns false', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('selected text');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keydown' });

    expect(result).toBe(false);
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith('selected text', 'explicit');
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('Ctrl+C without selection returns true (SIGINT passthrough)', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keydown' });

    expect(result).toBe(true);
    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('Ctrl+C does not copy on keyup', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('text');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keyup' });

    expect(result).toBe(false);
    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  // P1: Windows stops intercepting Ctrl+V. Returning false keeps xterm from
  // writing the literal DC1 to the PTY; NOT calling preventDefault lets
  // Chromium fire the native paste event, which attachImagePasteHandler and
  // xterm's own paste pipeline serve — the path macOS/Linux already used.
  // The keystroke itself touches neither the PTY nor the clipboard.
  it('Ctrl+V returns false and does not preventDefault (native paste fires)', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const preventDefault = vi.fn();
    const result = terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault });

    expect(result).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Ctrl+V issues zero clipboard IPCs and writes no bytes at the keystroke', () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty as any);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    expect(writeToPty).not.toHaveBeenCalled();
    expect(mockReadForPaste).not.toHaveBeenCalled();
  });

  it('Ctrl+V on keyup is suppressed the same way', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keyup', preventDefault: vi.fn() });

    expect(result).toBe(false);
    expect(mockReadForPaste).not.toHaveBeenCalled();
  });
  it('Ctrl+Shift+C still works for copy', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('shift-copy');
    const result = terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(result).toBe(false);
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith('shift-copy', 'explicit');
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });
});

describe('attachClipboardCopyHandler app shortcut suppression', () => {
  beforeEach(() => {
    stubPlatform('Win32');
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
  });

  it('returns false when key matches a registered app shortcut', () => {
    const terminal = new FakeTerminal();
    mockMatchEvent.mockReturnValue(true); // handler acted: key consumed
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'j', type: 'keydown' });

    expect(result).toBe(false);
  });

  it('falls through to default when key does not match any shortcut', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ key: 'a', type: 'keydown' });

    expect(result).toBe(true);
  });

  it('sends Ctrl+L to the PTY in a CLI terminal (goto-line handler declines)', () => {
    // matchEvent false = the accelerator matched but the handler no-oped
    // (no file-reader session) and did NOT preventDefault. Returning true
    // here is what lets \x0c reach readline — the Ctrl+L dead-key bug.
    const terminal = new FakeTerminal();
    mockMatchEvent.mockReturnValue(false);
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'l', type: 'keydown' });

    expect(mockMatchEvent).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('suppresses Ctrl+L for a file-reader session (goto-line handler acts)', () => {
    const terminal = new FakeTerminal();
    mockMatchEvent.mockReturnValue(true);
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'l', type: 'keydown' });

    expect(result).toBe(false);
  });

  it('sends Ctrl+R to the PTY outside a browser tab and suppresses it inside one', () => {
    // browser-reload declines for non-browser sessions (Ctrl+R is readline
    // reverse-search); it acts for browser-tab sessions.
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    mockMatchEvent.mockReturnValue(false);
    expect(terminal.simulateKey({ ctrlKey: true, key: 'r', type: 'keydown' })).toBe(true);

    mockMatchEvent.mockReturnValue(true);
    expect(terminal.simulateKey({ ctrlKey: true, key: 'r', type: 'keydown' })).toBe(false);
  });

  it('suppresses keyup of any registered accelerator via matchesAnyShortcut', () => {
    // keyup has no handler to run; it stays suppressed for registered
    // accelerators so xterm never processes a consumed shortcut's release.
    const terminal = new FakeTerminal();
    mockMatchesAnyShortcut.mockReturnValue(true);
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'j', type: 'keyup' });

    expect(mockMatchEvent).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });
});

describe('attachCopyOnSelect', () => {
  it('does not write to clipboard when copyOnSelect preference is off', () => {
    const terminal = new FakeTerminal();
    attachCopyOnSelect(terminal as any);

    terminal.setSelection('hello');
    terminal.fireSelectionChange();

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });

  it('writes selection to clipboard when copyOnSelect is on and selection is non-empty', () => {
    mockPreferences.copyOnSelect = true;
    const terminal = new FakeTerminal();
    attachCopyOnSelect(terminal as any);

    terminal.setSelection('selected');
    terminal.fireSelectionChange();

    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith('selected', 'selection');
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not write to clipboard when copyOnSelect is on but selection is empty', () => {
    mockPreferences.copyOnSelect = true;
    const terminal = new FakeTerminal();
    attachCopyOnSelect(terminal as any);

    terminal.setSelection('');
    terminal.fireSelectionChange();

    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();
  });
});


// P3: copy pays one fire-and-forget write per completed selection, zero when
// the (text, source) pair is unchanged, and nothing past the 256 Ki budget
// for a selection-driven copy. The pair comparison is what keeps the Linux
// PRIMARY contract: an explicit copy of the same string must not suppress
// the later selection-driven write, or middle-click paste loses the
// selection (docs/ui-conventions.md).
describe('copyText / copySelection (P3)', () => {
  beforeEach(() => {
    _resetClipboardCopyStateForTesting();
  });

  it('writes once per selection and zero when the selection text is unchanged', () => {
    const terminal = new FakeTerminal();
    terminal.setSelection('first');
    copySelection(terminal, 'selection');
    copySelection(terminal, 'selection');
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledTimes(1);

    terminal.setSelection('second');
    copySelection(terminal, 'selection');
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledTimes(2);
    expect(mockFineVibeClipboardWrite).toHaveBeenLastCalledWith('second', 'selection');
  });

  it('an explicit copy of the same text does not suppress a later selection write (PRIMARY contract)', () => {
    copyText('same', 'explicit');
    copyText('same', 'selection');
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledTimes(2);
    expect(mockFineVibeClipboardWrite).toHaveBeenNthCalledWith(1, 'same', 'explicit');
    expect(mockFineVibeClipboardWrite).toHaveBeenNthCalledWith(2, 'same', 'selection');
  });

  it('defers a selection-driven copy past the 256 Ki budget; explicit copies always write', () => {
    const huge = 'x'.repeat(256 * 1024 + 1);
    copyText(huge, 'selection');
    expect(mockFineVibeClipboardWrite).not.toHaveBeenCalled();

    copyText(huge, 'explicit');
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledWith(huge, 'explicit');
  });

  it('a selection copy just inside the budget writes', () => {
    copyText('y'.repeat(256 * 1024), 'selection');
    expect(mockFineVibeClipboardWrite).toHaveBeenCalledTimes(1);
  });
});
describe('loadWebglWithFallback', () => {
  beforeEach(() => {
    webglState.shouldThrow = false;
    webglState.lastInstance = null;
  });

  it('loads the addon and subscribes to onContextLoss', () => {
    const terminal = { loadAddon: vi.fn() };
    loadWebglWithFallback(terminal as any);

    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
    expect(webglState.lastInstance).not.toBeNull();
  });

  it('disposes the addon when the WebGL context is lost', () => {
    const terminal = { loadAddon: vi.fn() };
    loadWebglWithFallback(terminal as any);

    webglState.lastInstance!.fireContextLoss();

    expect(webglState.lastInstance!.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back silently when WebGL is unavailable', () => {
    webglState.shouldThrow = true;
    const terminal = { loadAddon: vi.fn() };

    expect(() => loadWebglWithFallback(terminal as any)).not.toThrow();
    expect(terminal.loadAddon).not.toHaveBeenCalled();
  });
});

describe('collapseArmedTextareaOnContextMenu', () => {
  // xterm parks the selection in its hidden textarea on right-click so a native
  // context-menu Copy can serialize it — the path that corrupts non-Latin text.
  it("collapses the selection xterm armed in its hidden textarea", () => {
    const terminal = new FakeTerminal();
    terminal.open();
    collapseArmedTextareaOnContextMenu(terminal as any);
    terminal.textarea!.value = 'Проверка';

    terminal.fireContextMenu();

    expect(terminal.textarea!.selectionRange).toEqual([0, 0]);
  });

  // xterm's IME CompositionHelper reads textarea.value back in a deferred
  // callback; wiping it would drop a candidate mid-composition.
  it('leaves the textarea contents intact for an in-flight IME composition', () => {
    const terminal = new FakeTerminal();
    terminal.open();
    collapseArmedTextareaOnContextMenu(terminal as any);
    terminal.textarea!.value = '你好';

    terminal.fireContextMenu();

    expect(terminal.textarea!.value).toBe('你好');
  });

  it('is a no-op for a terminal that was never opened', () => {
    expect(() => collapseArmedTextareaOnContextMenu(new FakeTerminal() as any)).not.toThrow();
  });
});

describe('pasteIntoTerminal (native paste event)', () => {
  beforeEach(() => {
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
  });

  it('turns a pasted screenshot into an injected temp path', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    const shot = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    mockSaveImage.mockResolvedValue('/tmp/finevibe-paste/paste-42.png');

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([shot]));

    expect(outcome).toBe('files');
    expect(mockSaveImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
    expect(writeToPty).toHaveBeenCalledWith('/tmp/finevibe-paste/paste-42.png ');
  });

  it('injects the real path of a copied file without re-saving its bytes', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    const file = new File([new Uint8Array([1])], 'diagram.png', { type: 'image/png' });
    mockGetDroppedFilePath.mockReturnValue('C:\\repo\\diagram.png');

    await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([file]));

    expect(mockSaveImage).not.toHaveBeenCalled();
    expect(writeToPty).toHaveBeenCalledWith('"C:\\repo\\diagram.png" ');
  });

  it('wraps an injected attachment path in bracketed paste when the mode is on', async () => {
    const terminal = new FakeTerminal();
    terminal.modes.bracketedPasteMode = true;
    const writeToPty = vi.fn();
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    mockSaveImage.mockResolvedValue('/tmp/paste-1.png');

    await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([file]));

    expect(writeToPty).toHaveBeenCalledWith('\x1b[200~/tmp/paste-1.png \x1b[201~');
  });

  // Text is xterm's own paste path; intercepting it would double-write the PTY.
  it('leaves a text-only paste to xterm', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([], 'hello'));

    expect(outcome).toBe('text');
    expect(writeToPty).not.toHaveBeenCalled();
    expect(mockReadForPaste).not.toHaveBeenCalled();
  });

  // A rich-text copy with no plain text has nothing for xterm's text pipeline.
  it('sends the markup source of a markup-only paste event', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([], '', '<p>hello</p>'));

    expect(outcome).toBe('text');
    expect(writeToPty).toHaveBeenCalledWith('<p>hello</p>');
  });

  it('refuses a pasted file whose Windows path carries a double quote (P1-20)', async () => {
    const pane = mountPaneForBanner();
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    const file = new File([new Uint8Array([1])], 'x"y & calc.exe', { type: 'image/png' });
    mockGetDroppedFilePath.mockReturnValue('C:\\x"y & calc.exe');

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([file]));

    // The spawn path rejects quote-bearing args outright; the paste twin
    // must inject nothing and say why.
    expect(outcome).toBe('files');
    expect(writeToPty).not.toHaveBeenCalled();
    expect(pane.querySelector('.insight-alert-message')?.textContent).toContain('x"y & calc.exe');
  });
});

describe('pasteIntoTerminal (main clipboard read)', () => {
  it('injects a clipboard file list as paths, exactly like a drop', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ files: ['/tmp/report.pdf', '/tmp/data.csv'] }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('files');
    expect(writeToPty).toHaveBeenCalledWith('/tmp/report.pdf /tmp/data.csv ');
  });

  // Flag-on twin of the test above: with the injection flag set the
  // main-read branch stamps [paste-timing] lines; every other test in this
  // file runs with the flag off and asserts the silent path by passing.
  it('logs paste-timing lines when the clipboard timing flag is on', async () => {
    (globalThis as { __FINEVIBE_CLIPBOARD_TIMING__?: boolean }).__FINEVIBE_CLIPBOARD_TIMING__ = true;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const terminal = new FakeTerminal();
      const writeToPty = vi.fn();
      mockReadForPaste.mockResolvedValue(pastePayload({ text: 'notes' }));

      const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(outcome).toBe('text');
      expect(writeToPty).toHaveBeenCalledWith('notes');
      expect(lines.some((l) => l.startsWith('[paste-timing] renderer readForPaste +'))).toBe(true);
      expect(lines.some((l) => l.startsWith('[paste-timing] renderer pty:write sent +'))).toBe(true);
      expect(lines).toContain('[paste-timing] counts clipboardRead=1 clipboardWrite=0');
    } finally {
      delete (globalThis as { __FINEVIBE_CLIPBOARD_TIMING__?: boolean }).__FINEVIBE_CLIPBOARD_TIMING__;
      log.mockRestore();
    }
  });

  it('sends markup source when a rich-text copy carries no plain text', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ html: '<b>notes</b>', hasContent: true }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('text');
    expect(writeToPty).toHaveBeenCalledWith('<b>notes</b>');
  });

  // Word and browser copies ship HTML next to plain text; the CLI wants the text.
  it('prefers plain text over the markup of the same copy', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'notes', html: '<b>notes</b>' }));

    await pasteIntoTerminal(terminal as any, writeToPty);

    expect(writeToPty).toHaveBeenCalledWith('notes');
  });

  // A file-manager copy leaves the file NAME as plain text (Explorer sets
  // FileName, Finder the display name). The native paste-event path treats the
  // files as the content for the same copy; the main-read path must agree.
  it('prefers a file list over the name echo a file-manager copy leaves as text', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'report.pdf', files: ['/tmp/report.pdf'] }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('files');
    expect(writeToPty).toHaveBeenCalledWith('/tmp/report.pdf ');
  });

  it('appends a materialised image to the file list it injects', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ files: ['/tmp/note.md'], imagePath: '/tmp/finevibe-paste/paste-9.png' }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('files');
    expect(writeToPty).toHaveBeenCalledWith('/tmp/note.md /tmp/finevibe-paste/paste-9.png ');
  });

  it('forwards a literal Ctrl+V for a flavor neither side translates', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ hasContent: true }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('passthrough');
    expect(writeToPty).toHaveBeenCalledWith('\x16');
  });

  it('sends nothing for an empty clipboard', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('empty');
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('refuses the quoted paths of a clipboard file list and keeps the rest (P1-20)', async () => {
    mockPlatform.isWin = true;
    const pane = mountPaneForBanner();
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({
      files: ['C:\\x"y & calc.exe', 'C:\\ok.md'],
      hasContent: true,
    }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('files');
    expect(writeToPty).toHaveBeenCalledWith('"C:\\ok.md" ');
    expect(pane.querySelector('.insight-alert-message')?.textContent).toContain('x"y & calc.exe');
    mockPlatform.isWin = false;
  });
});

  // P4: the 8 Mi character cap is a real content cut, so the pane says so —
  // the way every other paste-path refusal is surfaced.
  it('surfaces a truncation notice for a capped clipboard text (P4)', async () => {
    const pane = mountPaneForBanner();
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'x'.repeat(16), hasContent: true, textTruncated: true }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('text');
    expect(writeToPty).toHaveBeenCalledWith('x'.repeat(16));
    expect(pane.querySelector('.insight-alert-message')?.textContent).toContain('8 Mi');
  });


describe('attachImagePasteHandler', () => {
  it('claims a paste carrying files before xterm consumes the keystroke', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    const preventDefault = vi.fn();
    attachImagePasteHandler(terminal as any, element as any, writeToPty);
    const shot = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    mockSaveImage.mockResolvedValue('/tmp/paste-7.png');

    element.fire('paste', { clipboardData: fakeDataTransfer([shot]), preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    return vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('/tmp/paste-7.png '));
  });

  it('ignores a text-only paste so xterm pastes it', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    const preventDefault = vi.fn();
    attachImagePasteHandler(terminal as any, element as any, writeToPty);

    element.fire('paste', { clipboardData: fakeDataTransfer([], 'text'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('claims a markup-only paste so the CLI receives the markup', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    const preventDefault = vi.fn();
    attachImagePasteHandler(terminal as any, element as any, writeToPty);

    element.fire('paste', { clipboardData: fakeDataTransfer([], '', '<em>hi</em>'), preventDefault });

    expect(preventDefault).toHaveBeenCalled();
    return vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('<em>hi</em>'));
  });
});

// P1: one paste path on all three platforms. The Windows Ctrl+V keystroke
// now lands here through Chromium's native paste event, exactly like macOS
// ⌘V and Linux Ctrl+Shift+V: text is xterm's, files are the event's, and
// main's clipboard read runs only for the shapes the event provably cannot
// serve (Windows CF_HDROP-only, macOS NSFilenames-only, Linux file-manager
// copies; docs/ui-conventions.md paste contract).
describe('attachImagePasteHandler (P1 one native paste path per platform)', () => {
  function mountPastePane() {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    attachImagePasteHandler(terminal as any, element as any, writeToPty);
    return { element, writeToPty };
  }

  it('a plain-text paste issues zero clipboard IPCs and stays un-prevented for xterm', () => {
    const { element, writeToPty } = mountPastePane();
    const preventDefault = vi.fn();

    element.fire('paste', { clipboardData: fakeDataTransfer([], 'hello'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(writeToPty).not.toHaveBeenCalled();
    expect(mockReadForPaste).not.toHaveBeenCalled();
  });

  it('falls back to the main read when the event carries no usable payload (file-manager copies)', async () => {
    const { element, writeToPty } = mountPastePane();
    // A Nautilus copy: Chromium forwards no File objects, and the plain text
    // is the name echo. Main's `text/uri-list` read is the documented route.
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'report.pdf', files: ['/tmp/report.pdf'], hasContent: true }));

    element.fire('paste', { clipboardData: fakeDataTransfer(), preventDefault: vi.fn() });

    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('/tmp/report.pdf '));
    expect(mockReadForPaste).toHaveBeenCalledTimes(1);
  });

  it('forwards Ctrl+V when the event proves content main cannot read (Wayland portals)', async () => {
    const { element, writeToPty } = mountPastePane();
    // Portal permissions can empty the readable format set: the empty main
    // read must degrade to the CLI's own paste, never to a silent no-op.
    mockReadForPaste.mockResolvedValue(pastePayload());

    element.fire('paste', { clipboardData: fakeDataTransfer(), preventDefault: vi.fn() });

    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('\x16'));
  });
});

describe('attachFileDropHandler', () => {
  const droppedFile = () => new File([new Uint8Array([2])], 'photo.jpg', { type: 'image/jpeg' });

  beforeEach(() => {
    // The stubbed dropped paths below are Windows-shaped; match the shell.
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
  });

  it('types a dropped file path into a live terminal', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath.mockReturnValue('C:\\repo\\photo.jpg');
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => true);

    element.fire('drop', { dataTransfer: fakeDataTransfer([droppedFile()]), preventDefault: vi.fn() });

    expect(writeToPty).toHaveBeenCalledWith('"C:\\repo\\photo.jpg" ');
    expect(terminal.focus).toHaveBeenCalled();
  });

  it('quotes a dropped path with spaces into a single token', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath.mockReturnValue('C:\\My Docs\\photo.jpg');
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => true);

    element.fire('drop', { dataTransfer: fakeDataTransfer([droppedFile()]), preventDefault: vi.fn() });

    expect(writeToPty).toHaveBeenCalledWith('"C:\\My Docs\\photo.jpg" ');
  });

  it('leaves a plain POSIX path unquoted', () => {
    mockPlatform.isWin = false;
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath.mockReturnValue('/home/u/photo.jpg');
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => true);

    element.fire('drop', { dataTransfer: fakeDataTransfer([droppedFile()]), preventDefault: vi.fn() });

    expect(writeToPty).toHaveBeenCalledWith('/home/u/photo.jpg ');
  });

  it('ignores a drop on a terminal whose PTY is gone', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath.mockReturnValue('C:\\repo\\photo.jpg');
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => false);

    element.fire('drop', { dataTransfer: fakeDataTransfer([droppedFile()]), preventDefault: vi.fn() });

    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('ignores a drag carrying no files so the drop is left to Chromium', () => {
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const preventDefault = vi.fn();
    attachFileDropHandler(terminal as any, element as any, vi.fn(), () => true);

    element.fire('dragover', { dataTransfer: fakeDataTransfer([], 'some text'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('refuses a dropped Windows path carrying a double quote, surfacing the rejection (P1-20)', () => {
    const pane = mountPaneForBanner();
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath.mockReturnValue('C:\\x"y & calc.exe');
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => true);

    element.fire('drop', { dataTransfer: fakeDataTransfer([droppedFile()]), preventDefault: vi.fn() });

    // cmd.exe toggles quoting on every `"`: nothing reaches the prompt, and
    // the pane shows the refusal the spawn path makes.
    expect(writeToPty).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(pane.querySelector('.insight-alert-message')?.textContent).toContain('x"y & calc.exe');
  });

  it('types the accepted paths of a mixed drop and flags the refused one', () => {
    const pane = mountPaneForBanner();
    const terminal = new FakeTerminal();
    const element = new FakeElement();
    const writeToPty = vi.fn();
    mockGetDroppedFilePath
      .mockReturnValueOnce('C:\\x"y & calc.exe')
      .mockReturnValueOnce('C:\\repo\\photo.jpg');
    const file = () => new File([new Uint8Array([2])], 'photo.jpg', { type: 'image/jpeg' });
    attachFileDropHandler(terminal as any, element as any, writeToPty, () => true);

    element.fire('drop', { dataTransfer: fakeDataTransfer([file(), file()]), preventDefault: vi.fn() });

    expect(writeToPty).toHaveBeenCalledWith('"C:\\repo\\photo.jpg" ');
    expect(pane.querySelector('.insight-alert-message')?.textContent).toContain('x"y & calc.exe');
  });
});

describe('quoteShellPath', () => {
  afterEach(() => {
    mockPlatform.isWin = false;
  });

  it('leaves shell-safe paths untouched', () => {
    expect(quoteShellPath('photo.jpg')).toBe('photo.jpg');
    expect(quoteShellPath('/home/u/a-b_c.2.txt')).toBe('/home/u/a-b_c.2.txt');
  });

  it('quotes an empty path so it survives as one token', () => {
    expect(quoteShellPath('')).toBe("''");
  });

  it('POSIX: single-quotes spaces and escapes embedded single quotes', () => {
    mockPlatform.isWin = false;
    expect(quoteShellPath('My File.pdf')).toBe("'My File.pdf'");
    expect(quoteShellPath("it's.txt")).toBe("'it'\\''s.txt'");
    expect(quoteShellPath('a$b.txt')).toBe("'a$b.txt'");
    expect(quoteShellPath('a`b.txt')).toBe("'a`b.txt'");
    // Single quotes carry a literal double quote safely — the POSIX branch
    // is sound and keeps quoting what the Windows branch refuses.
    expect(quoteShellPath('a"b.txt')).toBe("'a\"b.txt'");
  });

  it('Windows: double-quotes spaces and doubles a trailing backslash', () => {
    mockPlatform.isWin = true;
    expect(quoteShellPath('C:\\My Docs\\a.txt')).toBe('"C:\\My Docs\\a.txt"');
    // A trailing backslash must not swallow the closing quote.
    expect(quoteShellPath('C:\\My Dir\\')).toBe('"C:\\My Dir\\\\"');
  });

  it('Windows: refuses a path containing a double quote (P1-20)', () => {
    // The spawn path rejects quote-bearing args outright (pty-manager's
    // quoteArgForCmdExe): cmd.exe toggles quoting on every `"` and honours
    // no escape, so the old `\"` form CLOSED the quoted region and left
    // `y & calc.exe` live on the command line. The quoter refuses the shape
    // the spawn path refuses; null tells the caller to reject, not inject.
    mockPlatform.isWin = true;
    expect(quoteShellPath('C:\\a"b.txt')).toBeNull();
    expect(quoteShellPath('x"y & calc.exe')).toBeNull();
  });
});
