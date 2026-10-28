// Row 31 (code-cleanup audit 2026-10-28): the renderer's diagnostics must
// reach `finevibe.log`. Main's console is tee'd into the log file
// (`src/main/log-file.ts`); the renderer's console goes to devtools and is
// gone the moment the window closes, so 42 production `console.*` calls were
// writing to a place nobody (including support) can read.
//
// One funnel: keep the console call (devtools stays useful in development)
// and ship the same line to main over `log:write`, where it enters the
// existing tee as `[renderer] …`.
//
// Logging must never break the caller and never become the flood: every
// failure is swallowed, the message is capped, and a per-minute budget drops
// the tail — main's own console throttle (`installConsoleThrottle`, installed
// first in main.ts) is the backstop for the file side.
// ponytail: fixed 200 lines/min window, no per-source split. Upgrade path if a
// chatty component ever starves the budget: a per-tag budget map.

/** Longest single shipped line (main's log lines are already one-per-write). */
const MAX_MESSAGE_CHARS = 2000;
/** Renderer-side flood guard: lines admitted per rolling minute. */
const LINES_PER_MINUTE = 200;

type RendererLogLevel = 'log' | 'info' | 'warn' | 'error';

let budget = LINES_PER_MINUTE;
let windowEndsAt = 0;

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @internal Test seam: the flood budget is module state, so tests reset it. */
export function _resetBudgetForTesting(): void {
  budget = LINES_PER_MINUTE;
  windowEndsAt = 0;
}

/** Console + log-file sink for renderer diagnostics. Never throws. */
export function rlog(level: RendererLogLevel, ...args: unknown[]): void {
  try {
    (console[level] as (...a: unknown[]) => void)(...args);
  } catch {
    // A patched/stubbed console (tests, hardened webPreferences): the file
    // route below is the one that matters in production.
  }
  try {
    const now = Date.now();
    if (now >= windowEndsAt) {
      windowEndsAt = now + 60_000;
      budget = LINES_PER_MINUTE;
    }
    if (budget <= 0) return;
    budget -= 1;
    const bridge = (globalThis as { window?: { finevibe?: { log?: { write(level: RendererLogLevel, message: string): void } } } }).window?.finevibe?.log;
    bridge?.write(level, args.map(format).join(' ').slice(0, MAX_MESSAGE_CHARS));
  } catch {
    // The bridge is absent (plain-browser tests) or mid-teardown.
  }
}
