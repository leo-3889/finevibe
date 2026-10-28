import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachAltScreenWheelScroll, sgrWheel, wheelCell, wheelNotches } from './terminal-wheel-scroll';

const CELL = 24;

function fixture(opts: { buffer?: 'normal' | 'alternate'; mouse?: 'none' | 'drag'; rows?: number }) {
  const write = vi.fn();
  const rows = opts.rows ?? 30;
  const handlers: Array<(e: WheelEvent) => boolean> = [];
  const terminal = {
    attachCustomWheelEventHandler: (h: (e: WheelEvent) => boolean) => handlers.push(h),
    buffer: { active: { type: opts.buffer ?? 'alternate' } },
    modes: { mouseTrackingMode: opts.mouse ?? 'none' },
    cols: 100,
    rows,
    element: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: rows * CELL }) },
  };
  attachAltScreenWheelScroll(terminal as unknown as Terminal, write);
  const wheel = (e: Record<string, unknown>) =>
    handlers[0]({ deltaY: 1, deltaMode: 0, clientX: 100, clientY: 100, ...e } as unknown as WheelEvent);
  return { write, wheel };
}

describe('alt-screen wheel scroll (ConPTY eats the app mouse modes)', () => {
  it('encodes the wheel report: 65 down, 64 up', () => {
    expect(sgrWheel(5, 9, true)).toBe('\x1b[<65;5;9M');
    expect(sgrWheel(5, 9, false)).toBe('\x1b[<64;5;9M');
  });

  it('writes one wheel report per notch at the pointer cell and cancels xterm', () => {
    const { write, wheel } = fixture({});
    // Pointer at (100,100) over a 8px-wide, 24px-tall cell → col 13, row 5.
    expect(wheel({ deltaY: 3 })).toBe(false);
    expect(write).toHaveBeenLastCalledWith('\x1b[<65;13;5M');
    expect(wheel({ deltaY: -2 })).toBe(false);
    expect(write).toHaveBeenLastCalledWith('\x1b[<64;13;5M');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('leaves the normal buffer, bound mouse reporting, and Ctrl/Cmd/Shift+wheel to xterm', () => {
    for (const f of [fixture({ buffer: 'normal' }), fixture({ mouse: 'drag' })]) {
      expect(f.wheel({ deltaY: 3 })).toBe(true);
      expect(f.write).not.toHaveBeenCalled();
    }
    const f = fixture({});
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(f.wheel({ deltaY: 3, ...mods })).toBe(true);
    }
    expect(f.write).not.toHaveBeenCalled();
  });

  it('accumulates sub-cell pixel deltas and emits at most one report per event', () => {
    const plan = wheelNotches(10, 2, CELL, 0);
    expect(plan).toEqual({ notches: 0, carry: 10 });
    expect(wheelNotches(20, 2, CELL, plan.carry)).toEqual({ notches: 1, carry: 6 });
    expect(wheelNotches(10, 0, CELL, 999)).toEqual({ notches: 1, carry: 0 }); // line mode ignores the pixel carry

    const { write, wheel } = fixture({});
    expect(wheel({ deltaY: 8, deltaMode: 2 })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(wheel({ deltaY: 20, deltaMode: 2 })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('hands a zero-delta event back to xterm', () => {
    const { write, wheel } = fixture({});
    expect(wheel({ deltaY: 0 })).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('clamps the pointer cell into the grid', () => {
    expect(wheelCell(-50, -50, { left: 0, top: 0, width: 800, height: 600 }, 100, 25)).toEqual({ col: 1, row: 1 });
    expect(wheelCell(9999, 9999, { left: 0, top: 0, width: 800, height: 600 }, 100, 25)).toEqual({ col: 100, row: 25 });
    expect(wheelCell(10, 10, { left: 0, top: 0, width: 0, height: 0 }, 100, 25)).toEqual({ col: 1, row: 1 });
  });
});
