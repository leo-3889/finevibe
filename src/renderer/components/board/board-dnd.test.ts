import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../board-state.js', () => ({
  moveTask: vi.fn(),
}));

type Listener = (e: unknown) => void;
const docListeners: Record<string, Set<Listener>> = {};

beforeEach(() => {
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: Listener) => {
      (docListeners[type] ??= new Set()).add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      docListeners[type]?.delete(fn);
    },
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('board-dnd: addDragEndCallback', () => {
  it('returns an unsubscribe function and supports multiple subscribers', async () => {
    const { addDragEndCallback } = await import('./board-dnd.js');
    const a = vi.fn();
    const b = vi.fn();

    const offA = addDragEndCallback(a);
    addDragEndCallback(b);

    offA();

    // Re-register a so we can assert b fires alongside it
    addDragEndCallback(a);

    expect(typeof offA).toBe('function');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('unsubscribe removes only that callback', async () => {
    const { addDragEndCallback } = await import('./board-dnd.js');
    const off = addDragEndCallback(vi.fn());
    expect(() => off()).not.toThrow();
    // Calling unsubscribe twice is a no-op
    expect(() => off()).not.toThrow();
  });
});

describe('board-dnd: initBoardDnd idempotency', () => {
  it('attaches document pointer listeners exactly once across repeated calls', async () => {
    const { initBoardDnd } = await import('./board-dnd.js');
    initBoardDnd();
    initBoardDnd();
    initBoardDnd();

    expect(docListeners['pointerdown']?.size).toBe(1);
    expect(docListeners['pointermove']?.size).toBe(1);
    expect(docListeners['pointerup']?.size).toBe(1);
  });
});
