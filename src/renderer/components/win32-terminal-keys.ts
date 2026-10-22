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

/** ConPTY swallows ordinary VT keys while mode 9001 (win32-input-mode) is on: cursor sequences split into text and a bare ESC vanishes. Encode these keys as INPUT_RECORD sequences instead. */
export function attachWin32TerminalKeys(terminal: Terminal, write: (data: string) => void): (event: KeyboardEvent) => boolean | undefined {
  let enabled = false;
  for (const [final, value] of [['h', true], ['l', false]] as const) {
    terminal.parser?.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(9001)) enabled = value;
      return false; // Preserve xterm's handling of other DEC private modes.
    });
  }
  return event => {
    const key = win32Keys[event.key];
    if (!enabled || !key || event.metaKey || event.isComposing) return undefined;
    if (event.type === 'keydown') {
      const modifiers = key[3] | (event.shiftKey ? 16 : 0) | (event.ctrlKey ? 8 : 0) | (event.altKey ? 2 : 0);
      write(`\x1b[${key[0]};${key[1]};${key[2]};1;${modifiers};1_`);
    }
    event.preventDefault();
    return false;
  };
}
