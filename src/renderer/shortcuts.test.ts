// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// appState drags the whole renderer store graph; matchEvent only needs
// `preferences.keybindings`.
vi.mock('./state.js', () => ({
  appState: { preferences: { keybindings: {} } },
}));

import { ShortcutManager } from './shortcuts.js';

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
    manager.registerHandler('close-session', () => { closeCalls++; });
    manager.registerHandler('zoom-in', () => { zoomCalls++; });
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
