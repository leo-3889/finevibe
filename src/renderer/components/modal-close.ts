// PA-34: the app's modal dialogs (board-help, whats-new, star-prompt,
// preferences, agentmemory-console) each carried the same module-level
// `let cleanupFn` ritual — a close() that hid the overlay and ran the open
// dialog's cleanup exactly once — and, for the info dialogs, an Enter-closes
// keydown handler.

/**
 * Per-dialog close state. One instance per dialog module: pushModal is a
 * stack, so dialogs can overlap and module-global cleanup state would be
 * wrong.
 */
export class ModalCloser {
  private cleanup: (() => void) | null = null;

  /** Run and drop the current cleanup; call at the top of show() to reset a previous open. */
  reset(): void {
    this.cleanup?.();
    this.cleanup = null;
  }

  setCleanup(fn: () => void): void {
    this.cleanup = fn;
  }

  /** Shared close() body: hide the overlay, then run the cleanup exactly once. */
  close(overlay: HTMLElement): void {
    overlay.style.display = 'none';
    this.reset();
  }
}

/** Shared dialog keydown: Enter confirms/closes. */
export function enterCloseKeydown(close: () => void): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      close();
    }
  };
}
