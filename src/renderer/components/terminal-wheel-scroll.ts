import type { Terminal } from '@xterm/xterm';

// ConPTY (every local Windows PTY: node-pty's default backend) parses an app's
// `CSI ? 1000/1002/1006 h` into console mouse mode and re-emits only what a
// legacy console app would have requested. A VT-native TUI's own mouse modes
// never reach xterm.js — verified on the PTY byte stream of a pi-bolt session:
// `?1049h`, `?1004h`, `?2026h` arrive, `?1000h`/`?1002h`/`?1006h` do not. With
// no mouse reporting bound, xterm.js takes its alt-screen fallback and turns
// every wheel notch into an Up/Down arrow, which the TUI reads as prompt-history
// browsing: the input line cycles while the session log stays frozen.
// The renderer has the wheel event, so send the SGR wheel report the terminal
// would have sent. `ponytail:` the app's real mouse intent is invisible under
// ConPTY, so an alt-screen app that wants wheel-as-arrows (a bare `less`) loses
// it here; Shift+wheel keeps xterm's native scrollback as the escape hatch.

/** SGR mouse wheel: button 64 = up, 65 = down (modes 1000 + 1006 encoding). */
export function sgrWheel(col: number, row: number, down: boolean): string {
  return `\x1b[<${down ? 65 : 64};${col};${row}M`;
}

const DELTA_PIXEL = 2;
const DEFAULT_CELL_HEIGHT = 20;

/**
 * Wheel notches for one event. Pixel deltas (trackpads) accumulate in `carry`
 * across events until they cover a text cell. At most one notch per event: the
 * app applies its own lines-per-event acceleration on top of each report.
 */
export function wheelNotches(
  deltaY: number,
  deltaMode: number,
  cellHeight: number,
  carry: number
): { notches: 0 | 1; carry: number } {
  if (!deltaY) return { notches: 0, carry };
  if (deltaMode !== DELTA_PIXEL) return { notches: 1, carry: 0 };
  const height = cellHeight > 0 ? cellHeight : DEFAULT_CELL_HEIGHT;
  const next = carry + deltaY;
  if (Math.abs(next) < height) return { notches: 0, carry: next };
  return { notches: 1, carry: next - Math.sign(next) * height };
}

/** Cell under the pointer in 1-based SGR coordinates, clamped to the grid. */
export function wheelCell(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number,
  rows: number
): { col: number; row: number } {
  const col = rect.width > 0 && cols > 0 ? Math.ceil((clientX - rect.left) / (rect.width / cols)) : 1;
  const row = rect.height > 0 && rows > 0 ? Math.ceil((clientY - rect.top) / (rect.height / rows)) : 1;
  return {
    col: Math.min(Math.max(col, 1), cols),
    row: Math.min(Math.max(row, 1), rows),
  };
}

/**
 * Forward wheel as SGR wheel reports while an app owns the alt screen without
 * mouse reporting (the ConPTY-eaten-mouse case). Every other case is handed
 * back to xterm: normal-buffer scrollback, apps whose modes did arrive (no
 * ConPTY in the path — Linux/macOS local panes, SSH panes), and Ctrl/Cmd+wheel
 * (host zoom). Returns false only when the event was consumed.
 */
export function attachAltScreenWheelScroll(terminal: Terminal, write: (data: string) => void): void {
  let carry = 0;
  terminal.attachCustomWheelEventHandler((event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
    if (terminal.buffer.active.type !== 'alternate') return true;
    if (terminal.modes.mouseTrackingMode !== 'none') return true;
    const rect = terminal.element?.getBoundingClientRect();
    const cellHeight = rect && terminal.rows > 0 ? rect.height / terminal.rows : 0;
    const plan = wheelNotches(event.deltaY, event.deltaMode, cellHeight, carry);
    carry = plan.carry;
    if (!plan.notches) return event.deltaMode !== DELTA_PIXEL;
    const grid = rect ?? { left: 0, top: 0, width: 0, height: 0 };
    const { col, row } = wheelCell(event.clientX, event.clientY, grid, terminal.cols, terminal.rows);
    write(sgrWheel(col, row, event.deltaY > 0));
    return false;
  });
}
