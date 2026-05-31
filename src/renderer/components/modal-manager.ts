// Centralized ESC-to-close manager for modals.
//
// Problem: xterm.js intercepts ESC on its helper <textarea> and calls
// stopPropagation() for keys it consumes, then writes \x1b to the PTY. Modal
// ESC handlers registered in the bubble phase therefore never run while a
// terminal pane has focus — the modal stays open AND the session is
// interrupted.
//
// Fix: a single capture-phase keydown listener on document. Capture flows
// window -> document -> ... -> textarea, so it runs BEFORE xterm. It dismisses
// the top-most modal and stops the event, so ESC never reaches the PTY.

export interface ModalEscapeEntry {
  /** Called when ESC dismisses this modal. */
  onEscape: () => void;
  /**
   * Optional guard. Return false to decline dismissal for this keypress (e.g.
   * a shortcut recorder is active). ESC is still consumed (never leaks to the
   * PTY) but onEscape is not called and the entry is not popped.
   */
  canEscape?: () => boolean;
}

const stack: ModalEscapeEntry[] = [];
let listenerInstalled = false;

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (stack.length === 0) return; // no modal open — let ESC flow to the app/terminal

  // A modal is open: ESC must never reach xterm/PTY.
  e.preventDefault();
  e.stopImmediatePropagation();

  const top = stack[stack.length - 1];
  if (top.canEscape && top.canEscape() === false) return; // consumed, but no dismissal

  // onEscape is responsible for closing the modal, whose close path calls the
  // unregister fn returned by pushModal — the single source of truth for
  // removing the entry from the stack.
  top.onEscape();
}

function ensureListener(): void {
  if (listenerInstalled) return;
  document.addEventListener('keydown', onKeydown, true);
  listenerInstalled = true;
}

/**
 * Push a modal onto the escape stack. Returns an idempotent unregister function
 * that MUST be called when the modal closes.
 */
export function pushModal(entry: ModalEscapeEntry): () => void {
  ensureListener();
  stack.push(entry);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Number of modals currently registered. Exposed for tests. */
export function modalStackDepth(): number {
  return stack.length;
}

export interface BindModalDismissOptions {
  overlay: HTMLElement;
  onClose: () => void;
  canEscape?: () => boolean;
  /** Close when the overlay background (not its content) is clicked. Default true. */
  closeOnOverlayClick?: boolean;
}

type DismissHolder = HTMLElement & { __modalDismissTeardown?: () => void };

/**
 * Opt-in helper for createModalShell-based modals: wires ESC dismissal (via the
 * manager) plus overlay background click-to-close. Returns a single teardown
 * that unregisters from the manager and removes the click listener — call it
 * from the modal's own close path.
 *
 * createModalShell caches its overlay by id, so re-opening a modal reuses the
 * same node. To prevent a re-open (before the previous close ran) from
 * orphaning a stack entry — which would make the manager swallow ESC forever —
 * any prior binding on the same overlay is torn down first.
 */
export function bindModalDismiss(opts: BindModalDismissOptions): () => void {
  const holder = opts.overlay as DismissHolder;
  holder.__modalDismissTeardown?.();

  const unregisterEsc = pushModal({ onEscape: opts.onClose, canEscape: opts.canEscape });

  let onOverlayClick: ((e: MouseEvent) => void) | null = null;
  if (opts.closeOnOverlayClick !== false) {
    onOverlayClick = (e: MouseEvent) => {
      if (e.target === opts.overlay) opts.onClose();
    };
    opts.overlay.addEventListener('click', onOverlayClick);
  }

  const teardown = () => {
    unregisterEsc();
    if (onOverlayClick) opts.overlay.removeEventListener('click', onOverlayClick);
    if (holder.__modalDismissTeardown === teardown) holder.__modalDismissTeardown = undefined;
  };
  holder.__modalDismissTeardown = teardown;
  return teardown;
}
