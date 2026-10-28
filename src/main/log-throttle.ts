// Console flood limiter (2026-10-23 ENOSPC incident).
//
// On a full disk the state writer fails on every renderer save, and each
// failure logged a full stack via `console.error` — ~400 identical stacks per
// minute, journald- and rsyslog-mirrored. The log growth consumed the very
// space it complained about, so the loop amplified itself. This module caps the
// source: consecutive byte-identical lines at the same level collapse into one
// emission plus a single `last message repeated <n> times` summary.
//
// Deliberate properties:
// - Only exact repeats collapse. Lines that differ byte-for-byte — e.g. the
//   `[omp-session-exit]` JSON (it carries `at: <ISO>`) and `[copy-timing]` perf
//   lines — pass straight through, because the incident report needs every
//   per-event record.
// - Real output always goes to the console method captured at install time, so
//   the throttle can never recurse into itself and the summary line is never
//   throttled.
// - Pure Node (no `electron` import) so it unit-tests under vitest.

type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error';

const METHODS: ConsoleMethodName[] = ['log', 'info', 'warn', 'error'];

/** Prefix of the collapse summary; tests and log scrapers key on this text. */
const REPEATED_PREFIX = 'last message repeated';

/** Separators chosen to be absent from the serialized shapes we build. */
const ARG_SEPARATOR = '\u0001';
const TAG_SEPARATOR = '\u0000';
const MAX_STRINGIFY_DEPTH = 5;

type ConsoleMethod = Console[ConsoleMethodName];

interface LevelState {
  /** Serialized form of the last emitted line at this level. */
  lastKey: string | null;
  /** Lines suppressed since that emission. */
  suppressed: number;
  /** Timestamp of that emission; the collapse window is anchored here. */
  lastAt: number;
  /** Pending summary timer, armed on the first suppression of a window. */
  timer: NodeJS.Timeout | null;
}

const states = new Map<ConsoleMethodName, LevelState>();
/** Sentinel for idempotent installs: patched functions, never re-patched. */
const patchedMethods = new WeakSet<object>();

function stateFor(method: ConsoleMethodName): LevelState {
  let state = states.get(method);
  if (!state) {
    state = { lastKey: null, suppressed: 0, lastAt: 0, timer: null };
    states.set(method, state);
  }
  return state;
}

/**
 * Deterministic, allocation-light serialization used for the collapse key.
 * Sorted object keys keep it stable across insertion order; the cycle guard and
 * depth cap keep hostile payloads (watcher events, renderer state) cheap.
 */
function stableStringify(value: unknown, depth = 0, seen: Set<object> = new Set()): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean' || type === 'undefined') return String(value);
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol' || type === 'function') {
    return `[${type} ${String((value as { name?: unknown }).name ?? '')}]`;
  }
  if (value instanceof Error) return `${value.name}: ${value.stack ?? value.message}`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (depth >= MAX_STRINGIFY_DEPTH) return '[…]';
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableStringify(item, depth + 1, seen)).join(',')}]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(([key, item]) => `${stableStringify(key, depth + 1, seen)}=>${stableStringify(item, depth + 1, seen)}`)
        .sort();
      return `Map{${entries.join(',')}}`;
    }
    if (value instanceof Set) {
      return `Set{${[...value].map(item => stableStringify(item, depth + 1, seen)).sort().join(',')}}`;
    }
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1, seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

/**
 * Collapse key for one `console.*` call. Errors key on their stack so that many
 * ENOSPC instances with the same stack are one key; the type tag keeps a string
 * `'e:…'` from colliding with an Error whose stack is `…`.
 */
function keyForArgs(args: unknown[]): string {
  let key = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (i > 0) key += ARG_SEPARATOR;
    if (typeof arg === 'string') key += `s${TAG_SEPARATOR}${arg}`;
    else if (arg instanceof Error) key += `e${TAG_SEPARATOR}${arg.stack ?? arg.message}`;
    else key += `j${TAG_SEPARATOR}${stableStringify(arg)}`;
  }
  return key;
}

/**
 * Emit the pending collapse summary through the *original* method, so it
 * bypasses the throttle (it is the record of suppressed lines, never one of
 * them) and cannot re-enter the patched path.
 */
function clearSummaryTimer(state: LevelState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function makePatched(windowMs: number, original: ConsoleMethod, state: LevelState): ConsoleMethod {
  const flush = (): void => {
    clearSummaryTimer(state);
    const suppressed = state.suppressed;
    state.lastKey = null;
    state.suppressed = 0;
    if (suppressed > 0) original(`${REPEATED_PREFIX} ${suppressed} times`);
  };

  return function throttled(...args: unknown[]): void {
    const key = keyForArgs(args);
    const now = Date.now();
    if (state.lastKey === key && now - state.lastAt < windowMs) {
      state.suppressed += 1;
      // Anchor the window at the last emission: a continuing storm yields one
      // summary per window, which is what bounds the log rate.
      if (state.timer === null) {
        const remaining = Math.max(0, windowMs - (now - state.lastAt));
        const timer = setTimeout(flush, remaining);
        // Never keep the process (or a test runner) alive for a summary.
        (timer as { unref?: () => void }).unref?.();
        state.timer = timer;
      }
      return;
    }
    // Key changed (flush inline, per contract) or window elapsed.
    flush();
    state.lastKey = key;
    state.lastAt = now;
    original.apply(console, args);
  } as ConsoleMethod;
}

/**
 * Rate-limit the console: consecutive byte-identical lines at the same level
 * within `windowMs` collapse to the first line plus one
 * `last message repeated <n> times` summary emitted when the window elapses or
 * the line changes. Idempotent — repeated installs never double-patch.
 */
export function installConsoleThrottle(windowMs = 1000): void {
  for (const method of METHODS) {
    const current = console[method] as ConsoleMethod;
    if (patchedMethods.has(current)) continue;
    const patched = makePatched(windowMs, current, stateFor(method));
    patchedMethods.add(patched);
    console[method] = patched;
  }
}
