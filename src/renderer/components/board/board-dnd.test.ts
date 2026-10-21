// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the mock factory hands out the SAME fn across module resets —
// board-dnd is (re)imported per test below to get fresh module state.
const mockMoveTask = vi.hoisted(() => vi.fn());

vi.mock('../../board-state.js', () => ({
  moveTask: mockMoveTask,
}));

// P2-126: the old suite stubbed `document` to a bare listener registry and
// asserted `expect(cb).not.toHaveBeenCalled()` after registering/unsubscribing
// — no pointer event was ever dispatched, so every assertion passed
// vacuously (the promised "b fires alongside a" assertion did not exist).
// This suite runs on jsdom: real elements, the module's real capture-phase
// listeners, real event dispatch.

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="board">
      <div class="board-column">
        <div class="board-column-cards" data-column-id="col-a">
          <div class="board-card" data-task-id="t1"><span>One</span></div>
          <div class="board-card" data-task-id="t2"><span>Two</span></div>
        </div>
      </div>
      <div class="board-column">
        <div class="board-column-cards" data-column-id="col-b">
          <div class="board-card" data-task-id="t3"><span>Three</span></div>
        </div>
      </div>
    </div>`;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function fire(type: string, target: Element, x: number, y: number): void {
  target.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

/** Card → past the 5 px threshold → release. Returns after the drop commit. */
function dragCard(taskId: string): void {
  const card = document.querySelector(`.board-card[data-task-id="${taskId}"]`)!;
  fire('pointerdown', card, 10, 10);
  fire('pointermove', card, 100, 100);
  fire('pointerup', card, 50, 10);
}

describe('board-dnd: addDragEndCallback', () => {
  it('notifies every live subscriber on drag end; unsubscribe detaches only its own callback', async () => {
    const { addDragEndCallback, initBoardDnd } = await import('./board-dnd.js');
    initBoardDnd();
    const a = vi.fn();
    const b = vi.fn();

    const offA = addDragEndCallback(a);
    addDragEndCallback(b);
    expect(typeof offA).toBe('function');

    offA();

    // A real drag: only b is subscribed — b must fire for real, and the
    // unsubscribed a must stay silent.
    dragCard('t1');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);

    // Re-register a: the next real drag fires b alongside it.
    addDragEndCallback(a);
    dragCard('t2');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    // The drag really happened: drop committed through moveTask for t1
    // (all jsdom rects are 0×0 at origin; x=50 sits inside the ±60 px band
    // of the first injected target — col-a order 0).
    expect(mockMoveTask).toHaveBeenCalledWith('t1', 'col-a', 0);
    expect(mockMoveTask).toHaveBeenCalledWith('t2', 'col-a', 0);
  });

  it('drag lifecycle is real: ghost + active flag mid-drag, cleaned up on release', async () => {
    const { initBoardDnd, isDragActive } = await import('./board-dnd.js');
    initBoardDnd();
    const card = document.querySelector('.board-card[data-task-id="t1"]')!;
    fire('pointerdown', card, 10, 10);
    fire('pointermove', card, 100, 100);

    expect(isDragActive()).toBe(true);
    expect(document.querySelector('.board-card-ghost')).not.toBeNull();
    expect(card.classList.contains('dragging')).toBe(true);

    fire('pointerup', card, 50, 10);
    expect(isDragActive()).toBe(false);
    expect(document.querySelector('.board-card-ghost')).toBeNull();
    expect(document.querySelectorAll('.board-drop-target')).toHaveLength(0);
  });

  it('unsubscribe removes only that callback and double-unsubscribe is a no-op', async () => {
    const { addDragEndCallback, initBoardDnd } = await import('./board-dnd.js');
    initBoardDnd();
    const gone = vi.fn();
    const kept = vi.fn();

    const off = addDragEndCallback(gone);
    addDragEndCallback(kept);
    expect(() => off()).not.toThrow();
    expect(() => off()).not.toThrow();

    dragCard('t3');
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });
});

describe('board-dnd: initBoardDnd idempotency', () => {
  it('attaches document pointer listeners exactly once across repeated calls', async () => {
    const { initBoardDnd } = await import('./board-dnd.js');
    const spy = vi.spyOn(document, 'addEventListener');
    initBoardDnd();
    initBoardDnd();
    initBoardDnd();

    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      const calls = spy.mock.calls.filter((c) => c[0] === type);
      expect(calls).toHaveLength(1);
      expect(calls[0][2]).toBe(true); // capture phase
    }
    spy.mockRestore();
  });
});
