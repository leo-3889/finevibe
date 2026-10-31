import { BrowserWindow, screen } from 'electron';
import type { WindowBounds } from '../shared/types';
import { loadState, saveStateSync } from './store';

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
 * Bring `win` back in front: un-minimize, un-hide, focus.
 *
 * Audit row 91: the macOS dock 'activate' lane only resynced session status, so
 * a dock click on a minimized window painted status changes behind a window
 * that never came back. The restore body existed once, in the `app:focus` IPC
 * handler; both lanes (plus the second-instance focus) call this instead.
 * `show()` is gated on visibility so a visible window sees no extra event.
 */
export function showAndFocusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Window geometry persistence (audit row 79).
 *
 * Bounds live in the existing state store (`state.json.windowBounds`, written
 * by main like the main-owned consent keys) — no second state file, and no
 * `resize`/`move` listener: close-time is the laziest write that survives a
 * restart, and the most a crash can lose is the last drag.
 */

/** Least window area that must overlap some display's work area for stored
 * bounds to be restored. A window remembered on a monitor that is no longer
 * attached is invisible rather than merely off-center, and a hidden window has
 * no gesture back — so the restore falls back to the built-in default size,
 * which Electron centers. */
const MIN_ON_SCREEN_OVERLAP_PX = 100;

/** Shape gate: state.json is a file a peer, a sync tool or a hand edit can
 * write, and these numbers become constructor coordinates. */
function isWindowBounds(value: unknown): value is WindowBounds {
  const b = value as Partial<WindowBounds> | undefined;
  return !!b
    && Number.isFinite(b.x) && Number.isFinite(b.y)
    && Number.isFinite(b.width) && (b.width as number) > 0
    && Number.isFinite(b.height) && (b.height as number) > 0;
}

/** Pure (displays injected, no Electron) so the off-screen fallback is testable. */
function boundsAreOnScreen(
  bounds: WindowBounds,
  displays: ReadonlyArray<{ workArea: { x: number; y: number; width: number; height: number } }>,
): boolean {
  return displays.some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_ON_SCREEN_OVERLAP_PX && overlapY >= MIN_ON_SCREEN_OVERLAP_PX;
  });
}

/** Constructor geometry: the persisted bounds when they are reachable on the
 * current screens, else null (the caller keeps its default size, and Electron
 * centers a sized window with no x/y). */
export function restoredWindowBounds(): WindowBounds | null {
  const stored = loadState().windowBounds;
  return isWindowBounds(stored) && boundsAreOnScreen(stored, screen.getAllDisplays()) ? stored : null;
}

/**
 * Persist the window's current bounds, at window close. `saveStateSync` rather
 * than `saveState` — a debounced timer would fire after teardown, the failure
 * flushState() clears its own timer for.
 *
 * The bounds survive the renderer's `beforeunload` whole-state flush because
 * `windowBounds` is a main-owned store key (store.ts graftMainOwnedState, the
 * S1-02/SA-P2-2 idiom): every renderer write is re-grafted with the cache
 * value, so the close handler's call order versus `flushState()` is irrelevant.
 */
export function saveWindowBounds(win: BrowserWindow): void {
  const state = loadState();
  // Maximized/fullscreen are deliberately not persisted: getBounds() reports
  // the restored-size rectangle, so the next launch comes back windowed.
  state.windowBounds = win.getBounds();
  saveStateSync(state);
}

/**
 * Push to the main window; a no-op when it is gone. Every main→renderer
 * channel is fire-and-forget by contract (see docs/FEATURES.md §29), so a
 * missing window is a normal drop, not an error.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args);
}
