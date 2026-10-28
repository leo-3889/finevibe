import type { PersistedState } from '../../shared/types.js';
import { serializeForSave } from './persistence.js';
import { rlog } from '../log.js';

/** Leading-edge persist throttle window. */
export const PERSIST_THROTTLE_MS = 200;

/**
 * Run `cb` on the coming frame. `requestAnimationFrame` in the renderer; a
 * 16 ms timer in hosts without a DOM (the node-env renderer tests), so the
 * coalescing semantics under test are the semantics shipped.
 */
function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, 16);
}

/**
 * The write path of the persisted-state store (extracted from `state.ts` in the
 * 2026-10-28 architecture audit; the semantics and their comments are the
 * original — five separate bug fixes live in here).
 *
 * The engine owns every timer, latch and timestamp the write path needs, so the
 * rules below are testable and reviewable in one file instead of spread through
 * a 1690-line class. AppState supplies the payload lazily (`getState`) and the
 * load gate (`isLoaded`); it keeps its public `persist/flushPersist/
 * flushPersistSync` surface, which delegates here.
 */
export class PersistEngine {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistAt = 0;
  private persistFrameScheduled = false;
  private persistFrameToken = 0;
  private costFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedPrematurePersist = false;

  constructor(
    private readonly getState: () => PersistedState,
    private readonly isLoaded: () => boolean,
  ) {}

  persist(): void {
    // Persisting before load() would write the default in-memory state over the
    // real state.json, which is how saved preferences silently vanish. Reads
    // before load are fine — components initialize pre-load and re-apply on
    // `state-loaded` (see docs/ui-conventions.md) — writes are not, so the
    // write itself is dropped, not just warned about.
    if (!this.isLoaded()) {
      if (!this.warnedPrematurePersist) {
        this.warnedPrematurePersist = true;
        rlog('warn', '[state] persist before appState.load() dropped; defaults would overwrite saved state');
      }
      return;
    }
    // PA-15: schedule the write on the coming frame instead of running it
    // inside the mutation that triggered it. Every persist serializes the
    // whole state and structured-clones it over IPC, and the old leading edge
    // paid that synchronously in the tab click / rename / cli-id adoption that
    // caused it — a burst cloned per mutation, and even ONE isolated mutation
    // cloned inside the interaction. Frame coalescing makes a burst (and an
    // isolated mutation) clone once per frame; `throttledWrite` keeps the
    // leading-edge 200 ms throttle, so a mutation lands at most one frame
    // after the action instead of a full throttle window (what a pure
    // trailing debounce would cost), and `flush` — the beforeunload hook in
    // index.ts — keeps the quit-path flush semantics.
    if (this.persistFrameScheduled) return;
    this.persistFrameScheduled = true;
    const token = this.persistFrameToken;
    const run = (): void => {
      // flush() bumped the token: this state is already on disk.
      if (token !== this.persistFrameToken) return;
      this.persistFrameScheduled = false;
      this.throttledWrite();
    };
    // S3-03: Chromium never runs animation-frame callbacks for a hidden
    // document — with the window minimized (the app's designed operating
    // mode for agent swarms: git-status and the discussions badge both
    // gate on document.hidden) the frame callback never fired, the latch
    // above never cleared, and ZERO state writes reached disk for the
    // whole hidden period; a crash then lost every session/rename/cost
    // change. Timers keep running while hidden: fall back to one on the
    // throttle window.
    if (typeof document !== 'undefined' && document.hidden) {
      setTimeout(run, PERSIST_THROTTLE_MS);
    } else {
      scheduleFrame(run);
    }
  }

  /**
   * The leading-edge 200 ms throttle, driven by the frame callback, by its own
   * trailing timer, and by nothing else: `persist()` is the only caller above
   * it, so the whole state is serialized at most once per frame.
   * Clamped at zero: a backwards wall-clock jump (resume-from-suspend NTP
   * correction, restored VM snapshot) makes `elapsed` negative, arming the
   * trailing save for `PERSIST_THROTTLE_MS - elapsed` — minutes/hours —
   * while the armed-timer guard below drops every write, so mutations stay
   * memory-only for that whole window. Clamping bounds the worst case to one
   * throttle window.
   */
  private throttledWrite(): void {
    const elapsed = Math.max(0, Date.now() - this.lastPersistAt);
    if (elapsed >= PERSIST_THROTTLE_MS && this.persistTimer === null) {
      this.writeStateNow();
      return;
    }
    if (this.persistTimer !== null) return; // trailing save already armed
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeStateNow();
    }, PERSIST_THROTTLE_MS - elapsed);
  }

  /** Serialize + ship right now; the only writer of the store. */
  private writeStateNow(): void {
    this.lastPersistAt = Date.now();
    window.finevibe.store.save(serializeForSave(this.getState()));
  }

  /**
   * Drop the pending frame and the armed trailing save, write immediately
   * (quit paths, tests). Cancelling the frame is what keeps the beforeunload
   * flush the LAST write: a frame callback that fired afterwards would arm a
   * trailing save for 200 ms past teardown.
   */
  flush(): void {
    this.persistFrameToken++;
    this.persistFrameScheduled = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.writeStateNow();
  }

  /**
   * S1-03: the beforeunload flush. store:save's async write can lose the
   * race with process exit; saveSync blocks this renderer until main has
   * written state.json synchronously (store.saveStateSync), so the window
   * can only tear down after the write is on disk.
   */
  flushSync(): void {
    this.persistFrameToken++;
    this.persistFrameScheduled = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.lastPersistAt = Date.now();
    window.finevibe.store.saveSync(serializeForSave(this.getState()));
  }

  /**
   * Coalesce high-frequency cost/context ticks into a single persist ~1s later.
   * Each tick costs a full serialize + structured clone over IPC; the 1s window
   * is short enough that a quit at any point loses at most ~1s of cost data
   * (the main-side store flushes on quit).
   */
  scheduleCostFlush(): void {
    if (this.costFlushTimer !== null) return;
    this.costFlushTimer = setTimeout(() => {
      this.costFlushTimer = null;
      this.persist();
    }, 1000);
  }

  /** Test teardown: drop armed timers and latches so cases cannot leak. */
  resetForTesting(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    if (this.costFlushTimer !== null) clearTimeout(this.costFlushTimer);
    this.persistTimer = null;
    this.costFlushTimer = null;
    this.lastPersistAt = 0;
    this.persistFrameToken++;
    this.persistFrameScheduled = false;
    this.warnedPrematurePersist = false;
  }
}
