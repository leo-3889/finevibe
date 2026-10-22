// PA-34: discussions-badge.ts and git-status.ts carried identical
// stopInterval bodies over module-level `let pollTimer` variables.

// NodeJS.Timeout in the main process, number in the renderer DOM lib;
// ReturnType of the ambient setInterval is the only portable spelling.
export type IntervalId = ReturnType<typeof setInterval>;

/** Holder for a repeating interval so stopInterval can clear and idle it in place. */
export interface IntervalHandle {
  id: IntervalId | null;
}

/** Clear a running interval, if any, and mark the handle idle. Safe to call repeatedly. */
export function stopInterval(handle: IntervalHandle): void {
  if (handle.id) {
    clearInterval(handle.id);
    handle.id = null;
  }
}
