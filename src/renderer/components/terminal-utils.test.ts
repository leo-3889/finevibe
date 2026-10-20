// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMatchesAnyShortcut, mockMatchEvent, mockPlatform, mockPreferences, webglState } = vi.hoisted(() => ({
  mockMatchesAnyShortcut: vi.fn(() => false),
  mockMatchEvent: vi.fn(() => false),
  mockPlatform: { isMac: false, isWin: false, isLinux: true },
  mockPreferences: { copyOnSelect: false } as { copyOnSelect: boolean },
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
  appState: { get preferences() { return mockPreferences; } },
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

import { attachClipboardCopyHandler, attachCopyOnSelect, attachFileDropHandler, attachImagePasteHandler, collapseArmedTextareaOnContextMenu, loadWebglWithFallback, pasteIntoTerminal, quoteShellPath } from './terminal-utils.js';

const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
const mockVibeyardClipboardWrite = vi.fn().mockResolvedValue(undefined);
const mockReadForPaste = vi.fn();
const mockSaveImage = vi.fn();
const mockGetDroppedFilePath = vi.fn();

// What main reports for a clipboard read; every case overrides what it varies on.
function pastePayload(
  overrides: Partial<{ text: string; html: string; files: string[]; imagePath: string | null; hasContent: boolean }> = {}
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
    vibeyard: {
      clipboard: {
        write: mockVibeyardClipboardWrite,
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

    expect(mockVibeyardClipboardWrite).toHaveBeenCalledWith('hello', 'explicit');
    // #160: no copy path may touch navigator.clipboard — the main process
    // writes a single plain-text flavor, Chromium's copy also writes rich ones.
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not copy on keyup', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('hello');
    terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keyup' });

    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not copy when nothing is selected', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('');
    terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
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
    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
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
    expect(mockVibeyardClipboardWrite).toHaveBeenCalledWith('selected text', 'explicit');
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('Ctrl+C without selection returns true (SIGINT passthrough)', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keydown' });

    expect(result).toBe(true);
    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
  });

  it('Ctrl+C does not copy on keyup', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('text');
    const result = terminal.simulateKey({ ctrlKey: true, key: 'c', type: 'keyup' });

    expect(result).toBe(false);
    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
  });

  it('Ctrl+V returns false and pastes clipboard text to PTY', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'pasted text', hasContent: true }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    expect(result).toBe(false);
    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('pasted text'));
  });

  it('Ctrl+V injects a clipboard image as an attachment path', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({
      imagePath: 'C:\\Users\\me\\AppData\\Local\\Temp\\vibeyard-paste\\paste-1.png',
      hasContent: true,
    }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith(
      '"C:\\Users\\me\\AppData\\Local\\Temp\\vibeyard-paste\\paste-1.png" ',
    ));
  });

  // A flavor neither side translates (a file copied in Explorer, a TIFF the
  // clipboard API hides) must reach the CLI: in a plain terminal it gets Ctrl+V
  // and reads the OS clipboard itself.
  it('Ctrl+V forwards the literal control char for an untranslated flavor', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ hasContent: true }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('\x16'));
  });

  it('Ctrl+V calls preventDefault to suppress native paste event', () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    const preventDefault = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'text', hasContent: true }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault });

    expect(preventDefault).toHaveBeenCalled();
  });

  it('Ctrl+V wraps text in bracketed paste escapes when mode is enabled', async () => {
    const terminal = new FakeTerminal();
    terminal.modes.bracketedPasteMode = true;
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'pasted', hasContent: true }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    await vi.waitFor(() => expect(writeToPty).toHaveBeenCalledWith('\x1b[200~pasted\x1b[201~'));
  });

  it('Ctrl+V does not paste empty clipboard', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown', preventDefault: vi.fn() });

    // A literal Ctrl+V in a shell means quoted-insert, so silence is the point.
    await vi.waitFor(() => expect(mockReadForPaste).toHaveBeenCalled());
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('Ctrl+V without writeToPty falls through to default', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    const result = terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keydown' });

    expect(result).toBe(true);
  });

  it('Ctrl+V does not call writeToPty on keyup', async () => {
    const terminal = new FakeTerminal();
    const writeToPty = vi.fn();
    mockReadForPaste.mockResolvedValue(pastePayload({ text: 'text', hasContent: true }));
    attachClipboardCopyHandler(terminal as any, undefined, writeToPty);

    terminal.simulateKey({ ctrlKey: true, key: 'v', type: 'keyup', preventDefault: vi.fn() });

    await Promise.resolve();
    expect(writeToPty).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+C still works for copy', () => {
    const terminal = new FakeTerminal();
    attachClipboardCopyHandler(terminal as any);

    terminal.setSelection('shift-copy');
    const result = terminal.simulateKey({ ctrlKey: true, shiftKey: true, key: 'C', type: 'keydown' });

    expect(result).toBe(false);
    expect(mockVibeyardClipboardWrite).toHaveBeenCalledWith('shift-copy', 'explicit');
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

    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
  });

  it('writes selection to clipboard when copyOnSelect is on and selection is non-empty', () => {
    mockPreferences.copyOnSelect = true;
    const terminal = new FakeTerminal();
    attachCopyOnSelect(terminal as any);

    terminal.setSelection('selected');
    terminal.fireSelectionChange();

    expect(mockVibeyardClipboardWrite).toHaveBeenCalledWith('selected', 'selection');
    expect(mockClipboardWrite).not.toHaveBeenCalled();
  });

  it('does not write to clipboard when copyOnSelect is on but selection is empty', () => {
    mockPreferences.copyOnSelect = true;
    const terminal = new FakeTerminal();
    attachCopyOnSelect(terminal as any);

    terminal.setSelection('');
    terminal.fireSelectionChange();

    expect(mockVibeyardClipboardWrite).not.toHaveBeenCalled();
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
    mockSaveImage.mockResolvedValue('/tmp/vibeyard-paste/paste-42.png');

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty, fakeDataTransfer([shot]));

    expect(outcome).toBe('files');
    expect(mockSaveImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/));
    expect(writeToPty).toHaveBeenCalledWith('/tmp/vibeyard-paste/paste-42.png ');
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
    mockReadForPaste.mockResolvedValue(pastePayload({ files: ['/tmp/note.md'], imagePath: '/tmp/vibeyard-paste/paste-9.png' }));

    const outcome = await pasteIntoTerminal(terminal as any, writeToPty);

    expect(outcome).toBe('files');
    expect(writeToPty).toHaveBeenCalledWith('/tmp/note.md /tmp/vibeyard-paste/paste-9.png ');
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
  });

  it('Windows: double-quotes spaces and escapes embedded double quotes', () => {
    mockPlatform.isWin = true;
    expect(quoteShellPath('C:\\My Docs\\a.txt')).toBe('"C:\\My Docs\\a.txt"');
    expect(quoteShellPath('C:\\a"b.txt')).toBe('"C:\\a\\"b.txt"');
    // A trailing backslash must not swallow the closing quote.
    expect(quoteShellPath('C:\\My Dir\\')).toBe('"C:\\My Dir\\\\"');
  });
});
