import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// The 2026-10-23 ENOSPC incident: every renderer save retried the state write
// and logged a full stack, ~400 identical stacks per minute. The throttle caps
// that at one line per window per level — while the incident report's own
// evidence (`[omp-session-exit]` JSON, `[copy-timing]` perf lines) must survive
// untouched, because each of those lines is byte-distinct.

type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error';

const native: Record<ConsoleMethodName, ConsoleMethod> = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

type ConsoleMethod = (...args: unknown[]) => void;

let spies: Record<ConsoleMethodName, Mock>;

function spy(method: ConsoleMethodName): Mock {
  return spies[method];
}

function callsOf(method: ConsoleMethodName): unknown[][] {
  return spy(method).mock.calls as unknown[][];
}

function summariesOf(method: ConsoleMethodName): unknown[][] {
  return callsOf(method).filter(call => call.length === 1 && String(call[0]).startsWith('last message repeated'));
}

beforeEach(() => {
  vi.useFakeTimers();
  spies = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  // Spies stand in for the underlying (pre-patch) console; the throttle must
  // capture and call these, never its own patched wrappers.
  for (const method of Object.keys(native) as ConsoleMethodName[]) {
    console[method] = spies[method] as ConsoleMethod;
  }
});

afterEach(() => {
  for (const method of Object.keys(native) as ConsoleMethodName[]) {
    console[method] = native[method];
  }
  vi.useRealTimers();
  vi.resetModules();
});

// `installConsoleThrottle` keeps its per-level state at module scope (that is
// what makes it idempotent and what bounds the flood across callers), so a
// static import would leak one test's throttle state into the next. Dynamic
// import after `vi.resetModules()` is the only way to get a pristine module
// per test — a module-loading-boundary need, not a runtime-selected specifier.
async function freshModule(): Promise<typeof import('./log-throttle')> {
  vi.resetModules();
  return import('./log-throttle');
}

async function installThrottle(windowMs?: number): Promise<void> {
  const mod = await freshModule();
  mod.installConsoleThrottle(windowMs);
}

function enospc(): Error {
  const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
  err.code = 'ENOSPC';
  return err;
}

describe('installConsoleThrottle', () => {
  it('collapses five identical warns to one line plus a single repeat summary', async () => {
    await installThrottle();

    for (let i = 0; i < 5; i++) console.warn('Failed to save state: ENOSPC: no space left on device, write');

    expect(callsOf('warn')).toEqual([['Failed to save state: ENOSPC: no space left on device, write']]);

    vi.advanceTimersByTime(1000);
    expect(callsOf('warn')).toEqual([
      ['Failed to save state: ENOSPC: no space left on device, write'],
      ['last message repeated 4 times'],
    ]);

    // The summary must not keep re-arming itself once the storm pauses.
    vi.advanceTimersByTime(60_000);
    expect(spy('warn')).toHaveBeenCalledTimes(2);
  });

  it('collapses distinct Error instances that share a stack', async () => {
    await installThrottle();

    for (let i = 0; i < 5; i++) console.error('Failed to save state:', enospc());
    vi.advanceTimersByTime(1000);

    expect(callsOf('error')).toEqual([
      ['Failed to save state:', expect.objectContaining({ code: 'ENOSPC' })],
      ['last message repeated 4 times'],
    ]);
  });

  it('passes distinct per-event lines through uncollapsed', async () => {
    await installThrottle();

    // `[omp-session-exit]` carries `at: <ISO>`, so no two lines are identical.
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      console.log(
        `[omp-session-exit] ${JSON.stringify({
          sessionId: 'sess-1',
          pid: 4242,
          exitCode: 0,
          at: new Date(base + i * 1000).toISOString(),
        })}`,
      );
    }
    // Same for `[copy-timing]` perf lines: the numbers are the payload.
    console.log('[copy-timing] bytes=4096 ms=1.4');
    console.log('[copy-timing] bytes=4096 ms=2.1');

    expect(spy('log')).toHaveBeenCalledTimes(7);
    expect(callsOf('log').some(call => String(call[0]).includes('at'))).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(spy('log')).toHaveBeenCalledTimes(7);
    expect(summariesOf('log')).toEqual([]);
  });

  it('does not count or collapse its own repeat summary', async () => {
    await installThrottle();

    for (let i = 0; i < 5; i++) console.error('Failed to save state:', enospc());
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 5; i++) console.error('Failed to save state:', enospc());
    vi.advanceTimersByTime(1000);

    // Two byte-identical summaries: the flush line is output, never state.
    expect(summariesOf('error')).toEqual([
      ['last message repeated 4 times'],
      ['last message repeated 4 times'],
    ]);
    expect(spy('error')).toHaveBeenCalledTimes(4);
  });

  it('flushes the pending summary when the key changes', async () => {
    await installThrottle();

    console.warn('disk full');
    console.warn('disk full');
    console.warn('disk recovering');

    expect(callsOf('warn')).toEqual([['disk full'], ['last message repeated 1 times'], ['disk recovering']]);

    // The window timer was cancelled by the inline flush: no second summary.
    vi.advanceTimersByTime(60_000);
    expect(spy('warn')).toHaveBeenCalledTimes(3);
  });

  it('keeps per-level state so the same text at two levels is not collapsed', async () => {
    await installThrottle();

    console.warn('disk full');
    console.error('disk full');
    console.warn('disk full');
    console.error('disk full');
    vi.advanceTimersByTime(1000);

    expect(callsOf('warn')).toEqual([['disk full'], ['last message repeated 1 times']]);
    expect(callsOf('error')).toEqual([['disk full'], ['last message repeated 1 times']]);
  });

  it('honors a custom window', async () => {
    await installThrottle(250);

    console.info('tick');
    console.info('tick');
    vi.advanceTimersByTime(249);
    expect(spy('info')).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(callsOf('info')).toEqual([['tick'], ['last message repeated 1 times']]);

    // Past the window the same line is a fresh first occurrence.
    console.info('tick');
    expect(spy('info')).toHaveBeenCalledTimes(3);
  });

  it('is idempotent: repeated installs never re-patch', async () => {
    const mod = await freshModule();
    mod.installConsoleThrottle();
    const patched = console.warn;
    expect(patched).not.toBe(native.warn);

    mod.installConsoleThrottle();
    mod.installConsoleThrottle(50);
    expect(console.warn).toBe(patched);

    // A nested patch would swallow the summary; exactly one reaches the spy.
    for (let i = 0; i < 5; i++) console.info('storm');
    vi.advanceTimersByTime(1000);
    expect(callsOf('info')).toEqual([['storm'], ['last message repeated 4 times']]);
  });
});
