// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// appState drags the whole renderer store graph; matchEvent only needs
// `preferences.keybindings`.
vi.mock('./state.js', () => ({
  appState: { preferences: { keybindings: {} } },
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
