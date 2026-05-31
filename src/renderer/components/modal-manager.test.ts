import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the capture-phase keydown handler the module installs on document,
// so tests can synthesize ESC events and assert dismissal behavior.
let keydownHandler: ((e: any) => void) | null;

function makeEscEvent(key = 'Escape') {
  return {
    key,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

async function loadManager() {
  return await import('./modal-manager');
}

beforeEach(() => {
  vi.resetModules(); // fresh module-level stack + listener flag per test
  keydownHandler = null;
  vi.stubGlobal('document', {
    addEventListener: vi.fn((type: string, fn: (e: any) => void, capture?: boolean) => {
      if (type === 'keydown' && capture === true) keydownHandler = fn;
    }),
    removeEventListener: vi.fn(),
  });
});

describe('modal-manager', () => {
  it('closes a single modal on ESC and consumes the event', async () => {
    const { pushModal } = await loadManager();
    const onEscape = vi.fn();
    pushModal({ onEscape });

    const e = makeEscEvent();
    keydownHandler!(e);

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('peels only the top-most modal, then the next one', async () => {
    const { pushModal } = await loadManager();
    const onEscapeA = vi.fn();
    const onEscapeB = vi.fn();
    pushModal({ onEscape: onEscapeA });
    const unregisterB = pushModal({ onEscape: onEscapeB });

    keydownHandler!(makeEscEvent());
    expect(onEscapeB).toHaveBeenCalledTimes(1);
    expect(onEscapeA).not.toHaveBeenCalled();

    // B's close path unregisters it; next ESC reaches A.
    unregisterB();
    keydownHandler!(makeEscEvent());
    expect(onEscapeA).toHaveBeenCalledTimes(1);
  });

  it('consumes ESC but does not dismiss when canEscape returns false', async () => {
    const { pushModal } = await loadManager();
    const onEscape = vi.fn();
    pushModal({ onEscape, canEscape: () => false });

    const e = makeEscEvent();
    keydownHandler!(e);

    expect(onEscape).not.toHaveBeenCalled();
    // Still consumed so it never leaks to the PTY.
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('ignores ESC when no modal is open (lets the key flow through)', async () => {
    const { pushModal } = await loadManager();
    const unregister = pushModal({ onEscape: vi.fn() });
    unregister();

    const e = makeEscEvent();
    keydownHandler!(e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('ignores non-ESC keys while a modal is open', async () => {
    const { pushModal } = await loadManager();
    const onEscape = vi.fn();
    pushModal({ onEscape });

    const e = makeEscEvent('a');
    keydownHandler!(e);

    expect(onEscape).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('has an idempotent unregister function', async () => {
    const { pushModal, modalStackDepth } = await loadManager();
    const unregister = pushModal({ onEscape: vi.fn() });
    expect(modalStackDepth()).toBe(1);

    unregister();
    unregister();
    expect(modalStackDepth()).toBe(0);

    const e = makeEscEvent();
    keydownHandler!(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('bindModalDismiss closes on overlay background click and tears down', async () => {
    const { bindModalDismiss, modalStackDepth } = await loadManager();
    const onClose = vi.fn();
    const listeners: Array<(e: any) => void> = [];
    const overlay = {
      addEventListener: vi.fn((_type: string, fn: (e: any) => void) => listeners.push(fn)),
      removeEventListener: vi.fn(),
    } as any;

    const teardown = bindModalDismiss({ overlay, onClose });
    expect(modalStackDepth()).toBe(1);

    // Clicking the overlay background (target === overlay) closes.
    listeners[0]({ target: overlay });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Clicking inner content does not close.
    listeners[0]({ target: {} });
    expect(onClose).toHaveBeenCalledTimes(1);

    teardown();
    expect(modalStackDepth()).toBe(0);
    expect(overlay.removeEventListener).toHaveBeenCalled();
  });

  it('bindModalDismiss tears down a prior binding on the same overlay (no leaked stack entry)', async () => {
    const { bindModalDismiss, modalStackDepth } = await loadManager();
    const overlay = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as any;

    bindModalDismiss({ overlay, onClose: vi.fn() });
    expect(modalStackDepth()).toBe(1);

    // Re-binding the same cached overlay (e.g. re-opening before close ran)
    // must not accumulate a second entry.
    bindModalDismiss({ overlay, onClose: vi.fn() });
    expect(modalStackDepth()).toBe(1);
  });
});
