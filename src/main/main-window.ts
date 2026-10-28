import { BrowserWindow } from 'electron';

/**
 * The single-window invariant (architecture audit 2026-10-28, P1).
 *
 * FineVibe is single-window by design: one renderer owns every tab, and every
 * main→renderer push in the codebase already targeted `getAllWindows()[0]`
 * — 25 sites, each re-implementing the same destroy guard. Centralized, the
 * invariant is one accessor plus one warning: the day multi-window becomes a
 * product decision, the warning below is the work list (per-session routing
 * replaces window[0] everywhere).
 */
let warned = false;

/** The live main window, or null when there is none (boot races, quit, destroyed). */
export function getMainWindow(): BrowserWindow | null {
  const live = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (live.length > 1 && !warned) {
    warned = true;
    console.warn(
      `[windows] ${live.length} live windows: FineVibe is single-window, so every push targets the first. ` +
        'See src/main/main-window.ts before adding a second window.',
    );
  }
  return live[0] ?? null;
}

/**
 * Push to the main window; a no-op when it is gone. Every main→renderer
 * channel is fire-and-forget by contract (see docs/FEATURES.md §29), so a
 * missing window is a normal drop, not an error.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args);
}
