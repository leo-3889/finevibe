import type { Terminal } from '@xterm/xterm';

// Win32-input-mode (spec #4999) key encodes: [Vk, Sc, Uc, base ControlKeyState].
const win32Keys: Record<string, [number, number, number, number]> = {
  ArrowUp: [38, 72, 0, 256], ArrowDown: [40, 80, 0, 256],
  ArrowLeft: [37, 75, 0, 256], ArrowRight: [39, 77, 0, 256],
  Home: [36, 71, 0, 256], End: [35, 79, 0, 256],
  PageUp: [33, 73, 0, 256], PageDown: [34, 81, 0, 256],
  Insert: [45, 82, 0, 256], Delete: [46, 83, 0, 256],
  // Escape is not an enhanced key, and its KEY_EVENT carries UnicodeChar 0x1b —
  // a bare ESC under mode 9001 is swallowed by ConPTY's win32-input parser,
  // so TUI menus (model pickers, permission prompts) never see it.
  Escape: [27, 1, 27, 0],
};

// Mode 9001 is monotonic per PTY and the latch must match: once ANY win32-input
// record has been written to a ConPTY-backed PTY, ConPTY's input parser is armed
// for the lifetime of that PTY and silently discards every later bare ESC byte
// (records and plain CSI keep flowing). A per-attach flag resets whenever the
// Terminal is re-created/re-attached (pane re-render, app reload), the renderer's
// own `\x1b` for Escape then dies in the armed ConPTY, and the pane shows the
// exact symptom "arrows work, Escape dead". ConPTY advertises `?9001h` as the
// first output bytes of every fresh PTY, so a `?9001l` sighting is never a
// licence to write bare ESC again: the latch is keyed per PTY (`latchKey`) and
// survives every attach.
const latchedKeys = new Set<string>();

// C2R-13: the key is a session id (`remote:`-prefixed for shared panes), so the
// entry has to die with its PTY — a pane that is closed and re-created every
// cycle used to grow the set for the renderer's whole lifetime. Call this from
// the destroy path that kills the PTY; a fresh PTY gets a fresh id, so a stale
// latch can never be re-read by a live pane.
export function unlatchWin32Key(key: string): void {
  latchedKeys.delete(key);
}

/** ConPTY swallows ordinary VT keys while mode 9001 (win32-input-mode) is on: cursor sequences split into text and a bare ESC vanishes. Encode these keys as INPUT_RECORD sequences instead. `opts.latchKey` ties the mode-9001 sighting to the PTY, so a fresh handler attached to an already-armed PTY starts encoded; `opts.latched` pre-arms a pane that owns a local Windows PTY, whose ConPTY advertised the mode at spawn — before any parser existed. */
export function attachWin32TerminalKeys(
  terminal: Terminal,
  write: (data: string) => void,
  opts?: { latchKey?: string; latched?: boolean },
): (event: KeyboardEvent) => boolean | undefined {
  let enabled = opts?.latched === true || (opts?.latchKey ? latchedKeys.has(opts.latchKey) : false);
  terminal.parser?.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
    if (params.includes(9001)) {
      enabled = true;
      if (opts?.latchKey) latchedKeys.add(opts.latchKey);
    }
    return false; // Preserve xterm's handling of other DEC private modes.
  });
  // Mode-off is never honoured: ConPTY's arming is monotonic, so un-latching
  // here would re-open the fatal bare-ESC path on this and every later attach.
  terminal.parser?.registerCsiHandler({ prefix: '?', final: 'l' }, () => false);
  return event => {
    const key = win32Keys[event.key];
    if (!enabled || !key || event.metaKey || event.isComposing) return undefined;
    if (event.type === 'keydown') {
      // C5R-08: ControlKeyState is the Win32 key-event mask, not the DOM
      // flags. AltGr sets RIGHT_ALT_PRESSED (0x4) on Windows (the DOM
      // `altKey` alone encodes the left Alt, 0x2); Caps Lock is CAPS_LOCK
      // (0x80). NUM_LOCK (0x20) is omitted: KeyboardEvent exposes no
      // num-lock signal for the renderer to read.
      // `?.` keeps synthetic KeyboardEvent-like objects (tests) working.
      const altState = event.getModifierState?.('AltGraph') ? 4 : 0;
      const leftAlt = altState === 0 && event.altKey ? 2 : 0;
      const modifiers = key[3] | (event.shiftKey ? 16 : 0) | (event.ctrlKey ? 8 : 0) | altState | leftAlt | (event.getModifierState?.('CapsLock') ? 128 : 0);
      write(`\x1b[${key[0]};${key[1]};${key[2]};1;${modifiers};1_`);
    }
    event.preventDefault();
    return false;
  };
}
