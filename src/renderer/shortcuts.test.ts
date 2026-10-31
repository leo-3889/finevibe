// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RELOAD_MAIN_WINDOW_ACCELERATOR } from '../shared/constants';
import { isMac } from './platform.js';

// appState drags the whole renderer store graph; matchEvent only needs
// `preferences.keybindings` (setPreference is here for the setOverride cases).
vi.mock('./state.js', () => ({
  appState: { preferences: { keybindings: {} }, setPreference: vi.fn() },
}));

import { ShortcutManager } from './shortcuts.js';
import { appState } from './state.js';

function keyInit(partial: Partial<KeyboardEventInit>): KeyboardEventInit {
  return { key: 'w', code: 'KeyW', bubbles: true, cancelable: true, ...partial };
}

describe('shortcut focus/modal guard', () => {
  let manager: ShortcutManager;
  let closeCalls: number;
  let zoomCalls: number;

  beforeEach(() => {
    manager = new ShortcutManager();
    // appState is a module-level mock (file lifetime); the keybinding
    // rebind test sets a global 'close-session' override - every dispatch
    // describe must start from the empty default, not a shuffled neighbor.
    appState.preferences.keybindings = {};
    closeCalls = 0;
    zoomCalls = 0;
    manager.registerHandler('close-session', () => { closeCalls++; return true; });
    manager.registerHandler('zoom-in', () => { zoomCalls++; return true; });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('fires Ctrl+W on the body (no field, no modal)', () => {
    const fired = manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })));
    expect(fired).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('suppresses Ctrl+W while typing in an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', keyInit({ ctrlKey: true }));
    Object.defineProperty(e, 'target', { value: input });
    expect(manager.matchEvent(e)).toBe(false);
    expect(closeCalls).toBe(0);
  });

  it('suppresses contenteditable targets', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);
    const e = new KeyboardEvent('keydown', keyInit({ ctrlKey: true }));
    Object.defineProperty(e, 'target', { value: div });
    expect(manager.matchEvent(e)).toBe(false);
    expect(closeCalls).toBe(0);
  });

  it('keeps app shortcuts alive inside the xterm helper textarea', () => {
    // xterm forwards every keystroke through a hidden <textarea class=
    // "xterm-helper-textarea">; treating it as a typing target would strip
    // Ctrl+T/Ctrl+W/Ctrl+1-9 from every terminal pane.
    const term = document.createElement('div');
    term.className = 'xterm';
    const ta = document.createElement('textarea');
    ta.className = 'xterm-helper-textarea';
    term.appendChild(ta);
    document.body.appendChild(term);
    const e = new KeyboardEvent('keydown', keyInit({ ctrlKey: true }));
    Object.defineProperty(e, 'target', { value: ta });
    expect(manager.matchEvent(e)).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('keeps view-level toggles live while typing', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', keyInit({ key: '=', code: 'Equal', ctrlKey: true }));
    Object.defineProperty(e, 'target', { value: input });
    expect(manager.matchEvent(e)).toBe(true);
    expect(zoomCalls).toBe(1);
  });

  it('suppresses everything but zoom/help while a modal-overlay is visible', () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay); // visible: no .hidden, display not none
    const close = new KeyboardEvent('keydown', keyInit({ ctrlKey: true }));
    expect(manager.matchEvent(close)).toBe(false);
    expect(closeCalls).toBe(0);

    const zoom = new KeyboardEvent('keydown', keyInit({ key: '=', code: 'Equal', ctrlKey: true }));
    expect(manager.matchEvent(zoom)).toBe(true);
    expect(zoomCalls).toBe(1);
  });

  it('hidden modal-overlay does not suppress shortcuts', () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay hidden';
    document.body.appendChild(overlay);
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('modal-shell overlay with display:none does not suppress', () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });
});

describe('shortcut overlay guard (overlays outside modal-shell)', () => {
  // These full-screen overlays are created outside modal.ts/modal-shell.ts:
  // appended to body and removed on close, with focus on a div/button so
  // isTypingTarget never covers them. Before OVERLAY_SELECTOR, Ctrl+W behind
  // the team detail overlay ran close-session and killed the tab's PTY.
  const OVERLAY_CLASSES = [
    'share-overlay',              // share-dialog.ts / join-dialog.ts
    'team-picker-overlay',        // team/predefined-picker.ts
    'team-picker-detail-overlay', // team/predefined-picker.ts
    'quick-open-overlay',         // quick-open.ts
    'session-palette-overlay',    // session-search-palette.ts
    'flow-picker-overlay',        // browser-tab/pane.ts (display-toggled)
    'send-menu-overlay',          // browser-tab/pane.ts (display-toggled)
  ];

  let manager: ShortcutManager;
  let closeCalls: number;

  beforeEach(() => {
    manager = new ShortcutManager();
    appState.preferences.keybindings = {}; // module-level mock - see guard describe
    closeCalls = 0;
    manager.registerHandler('close-session', () => { closeCalls++; return true; });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(OVERLAY_CLASSES)('close-session does not run while .%s is mounted', (cls) => {
    const overlay = document.createElement('div');
    overlay.className = cls;
    document.body.appendChild(overlay);
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(false);
    expect(closeCalls).toBe(0);
  });

  it('close-session runs when no overlay is mounted', () => {
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('#modal-overlay without .hidden suppresses close-session', () => {
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    document.body.appendChild(overlay);
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(false);
    expect(closeCalls).toBe(0);
  });

  it('#modal-overlay with .hidden does not suppress', () => {
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'hidden';
    document.body.appendChild(overlay);
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('display:none flow-picker/send-menu overlays do not suppress', () => {
    // These two stay mounted for the pane's lifetime and toggle display —
    // a bare existence check would suppress every shortcut in a browser tab.
    for (const cls of ['flow-picker-overlay', 'send-menu-overlay']) {
      const overlay = document.createElement('div');
      overlay.className = cls;
      overlay.style.display = 'none';
      document.body.appendChild(overlay);
    }
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('non-interactive terminal-exit / browser-drag overlays do not suppress', () => {
    for (const cls of ['terminal-exit-overlay', 'browser-drag-overlay']) {
      const overlay = document.createElement('div');
      overlay.className = cls;
      document.body.appendChild(overlay);
    }
    expect(manager.matchEvent(new KeyboardEvent('keydown', keyInit({ ctrlKey: true })))).toBe(true);
    expect(closeCalls).toBe(1);
  });
});

describe('shortcut handler verdict', () => {
  // A handler returns true only when it acted. The dispatcher must consume
  // (preventDefault) only acted keys, so a declined accelerator keeps its
  // default behavior — the terminal bytes reach the PTY.
  let manager: ShortcutManager;
  let gotoLineCalls: number;
  let closeCalls: number;

  const ctrlL = () => new KeyboardEvent('keydown', keyInit({ key: 'l', code: 'KeyL', ctrlKey: true }));

  beforeEach(() => {
    manager = new ShortcutManager();
    appState.preferences.keybindings = {};
    gotoLineCalls = 0;
    closeCalls = 0;
    document.body.innerHTML = '';
  });

  it('a declining handler runs but does not consume the key', () => {
    // CLI terminal context: goto-line no-ops, Ctrl+L must survive for
    // readline clear-screen.
    manager.registerHandler('goto-line', () => { gotoLineCalls++; return false; });
    const e = ctrlL();
    expect(manager.matchEvent(e)).toBe(false);
    expect(gotoLineCalls).toBe(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('an acting handler consumes the key', () => {
    // file-reader session: goto-line opens the bar.
    manager.registerHandler('goto-line', () => { gotoLineCalls++; return true; });
    const e = ctrlL();
    expect(manager.matchEvent(e)).toBe(true);
    expect(gotoLineCalls).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('a declining handler lets a later shortcut sharing the key act', () => {
    appState.preferences.keybindings = { 'close-session': 'CmdOrCtrl+L' };
    manager.registerHandler('goto-line', () => false);
    manager.registerHandler('close-session', () => { closeCalls++; return true; });
    const e = ctrlL();
    expect(manager.matchEvent(e)).toBe(true);
    expect(closeCalls).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('physical-key matching (non-Latin layouts)', () => {
  // Letter/digit bindings resolve through e.code (layout-independent):
  // a Cyrillic keyboard reports key:'т' on the physical T, and Ctrl+Т
  // must still fire the Ctrl+T binding. Symbols/punctuation keep the
  // e.key comparison; the mac meta paths are covered by the suites above.
  let manager: ShortcutManager;
  let newSessionCalls: number;
  let goto1Calls: number;
  let backCalls: number;

  beforeEach(() => {
    manager = new ShortcutManager();
    appState.preferences.keybindings = {};
    newSessionCalls = 0;
    goto1Calls = 0;
    backCalls = 0;
    manager.registerHandler('new-session', () => { newSessionCalls++; return true; });
    manager.registerHandler('goto-session-1', () => { goto1Calls++; return true; });
    manager.registerHandler('tab-back', () => { backCalls++; return true; });
    document.body.innerHTML = '';
  });

  it('fires a letter binding from the physical key under a Cyrillic e.key', () => {
    const e = new KeyboardEvent('keydown', keyInit({ key: 'т', code: 'KeyT', ctrlKey: true }));
    expect(manager.matchEvent(e)).toBe(true);
    expect(newSessionCalls).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does not fire when the physical key differs from the binding', () => {
    // key 'т' arriving on the physical Y must not match Ctrl+T.
    const e = new KeyboardEvent('keydown', keyInit({ key: 'т', code: 'KeyY', ctrlKey: true }));
    expect(manager.matchEvent(e)).toBe(false);
    expect(newSessionCalls).toBe(0);
  });

  it('matches digit bindings through e.code', () => {
    const e = new KeyboardEvent('keydown', keyInit({ key: '1', code: 'Digit1', ctrlKey: true }));
    expect(manager.matchEvent(e)).toBe(true);
    expect(goto1Calls).toBe(1);
  });

  it('keeps symbol bindings on the e.key comparison', () => {
    // Ctrl+[ is a punctuation binding: it matches the typed '['
    // (Shift+4 on en-US produces e.key '[' with code 'Digit4'), and a
    // physical bracket key whose layout emits a different character
    // must not match.
    const typed = new KeyboardEvent('keydown', keyInit({ key: '[', code: 'Digit4', ctrlKey: true }));
    expect(manager.matchEvent(typed)).toBe(true);
    expect(backCalls).toBe(1);
    const physical = new KeyboardEvent('keydown', keyInit({ key: 'х', code: 'KeyL', ctrlKey: true }));
    expect(manager.matchEvent(physical)).toBe(false);
    expect(backCalls).toBe(1);
  });

  it('latin e.key + matching code keeps working (regression)', () => {
    const e = new KeyboardEvent('keydown', keyInit({ key: 't', code: 'KeyT', ctrlKey: true }));
    expect(manager.matchEvent(e)).toBe(true);
    expect(newSessionCalls).toBe(1);
  });
});

describe('reload-main-window chord (row 99)', () => {
  // The View → Reload Main Window item prints this chord with
  // registerAccelerator:false, so the menu claims nothing and this shortcut is
  // the only thing that can act on the key. Display and behavior share
  // `RELOAD_MAIN_WINDOW_ACCELERATOR`, so they cannot drift apart.
  it('binds the exact chord the menu prints', () => {
    const manager = new ShortcutManager();
    let reloads = 0;
    manager.registerHandler('reload-main-window', () => { reloads++; return true; });

    expect(manager.getKeys('reload-main-window')).toBe(RELOAD_MAIN_WINDOW_ACCELERATOR);
    const e = new KeyboardEvent('keydown', keyInit({
      key: 'F5',
      code: 'F5',
      shiftKey: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }));
    expect(manager.matchEvent(e)).toBe(true);
    expect(reloads).toBe(1);
  });

  it('leaves CmdOrCtrl+Shift+R to the browser-tab hard reload', () => {
    // Row 99's collision: the mac menu used to PRINT this chord on the
    // main-window item. The chord stays browser-tab-only (its handler declines
    // outside a browser tab); only the F5 chord reloads the window.
    const manager = new ShortcutManager();
    let reloads = 0;
    manager.registerHandler('reload-main-window', () => { reloads++; return true; });
    const e = new KeyboardEvent('keydown', keyInit({
      key: 'r',
      code: 'KeyR',
      shiftKey: true,
      ...(isMac ? { metaKey: true } : { ctrlKey: true }),
    }));
    expect(manager.matchEvent(e)).toBe(false);
    expect(reloads).toBe(0);
  });
});

describe('setOverride mac-menu collision warning (row 117)', () => {
  // The macOS application menu registers its own chords (src/main/menu.ts), and
  // a native menu accelerator is consumed before the renderer's keydown
  // listener sees the event — an override recorded onto one of them never
  // fires. isMac is a module-level const, so the mac path needs a fresh import
  // with the platform mocked (same resetModules idiom as menu.test.ts).
  async function macManager(): Promise<ShortcutManager> {
    vi.resetModules();
    vi.doMock('./platform.js', () => ({ isMac: true }));
    const { ShortcutManager: MacShortcutManager } = await import('./shortcuts.js');
    const { appState: macAppState } = await import('./state.js');
    (macAppState as { preferences: { keybindings: Record<string, string> } }).preferences.keybindings = {};
    return new MacShortcutManager();
  }

  it('warns when an override lands on a chord the mac menu owns', async () => {
    const manager = await macManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.setOverride('close-session', 'CmdOrCtrl+Shift+W');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Close Window');
    warn.mockRestore();
  });

  it('warns for the role-default chords the mac menu keeps (Quit/Redo/…)', async () => {
    const manager = await macManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const keys of ['CmdOrCtrl+Q', 'CmdOrCtrl+H', 'CmdOrCtrl+M', 'CmdOrCtrl+Shift+Z', 'CmdOrCtrl+Shift+V', 'CmdOrCtrl+Backspace']) {
      manager.setOverride('goto-line', keys);
    }
    expect(warn).toHaveBeenCalledTimes(6);
    warn.mockRestore();
  });

  // Row 77: Preferences… is the one non-role chord the mac menu registers, so
  // an override recorded onto it is dead in exactly the same way — the map in
  // shortcuts.ts mirrors src/main/menu.ts, and menu.test.ts pins that nothing
  // else claims a key.
  it('warns for the Preferences chord (CmdOrCtrl+,)', async () => {
    const manager = await macManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.setOverride('close-session', 'CmdOrCtrl+,');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('Preferences');
    warn.mockRestore();
  });

  it('stays silent on a chord the menu does not claim', async () => {
    const manager = await macManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // CmdOrCtrl+Shift+E is unclaimed on mac, and on win/linux menu.ts
    // registers no accelerators at all (their menu test pins that).
    manager.setOverride('close-session', 'CmdOrCtrl+Shift+E');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
