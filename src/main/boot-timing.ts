import type { BrowserWindow } from 'electron';

/**
 * Boot and runtime measurement (architecture audit 2026-10-28, P1).
 *
 * The app bounded everything by code constants and measured nothing — the
 * contract docs said so out loud. This is the measurement leg: a boot timeline
 * printed to the console (the log tee puts it in `<logs>/finevibe.log`, which
 * is the only channel a packaged app has), and a periodic runtime sample
 * pushed to the renderer's debug ring (Ctrl+Shift+D) so RSS/heap/handle growth
 * is visible in the app instead of guessed at.
 *
 * `t0` is taken at module import. This module is imported by `main.ts`, whose
 * imports run before anything the app does, so `performance.now()` here is
 * "since process start" to within the module graph's load time.
 */

const t0 = performance.now();

/** Sampling cadence: RSS/handle trends are minutes-scale, so a minute is plenty. */
export const PERF_SAMPLE_INTERVAL_MS = 60_000;

/** Upper bound for a renderer-reported boot time (a clock skew must not print). */
const MAX_REPORTED_BOOT_MS = 10 * 60_000;

const steps: Array<{ step: string; ms: number }> = [];
let last = t0;
let finished = false;
let sampler: ReturnType<typeof setInterval> | null = null;

/** Close the previous step and start a new one. Cheap; safe on the boot path. */
export function markBoot(step: string): void {
  const now = performance.now();
  steps.push({ step, ms: Math.round(now - last) });
  last = now;
}

/** Format and clear the accumulated steps. */
function drainSteps(): string {
  const summary = steps.map((s) => `${s.step}=${s.ms}ms`).join(' ');
  steps.length = 0;
  last = performance.now();
  return summary;
}

/**
 * Print the boot summary — the moment the window is up is the number that
 * matters to a user. Later calls are ignored (one first-paint per process);
 * post-window phases report through `finishBootPhase`.
 */
export function finishBoot(note = ''): void {
  if (finished) return;
  finished = true;
  const summary = drainSteps();
  console.log(`[boot] ${summary} total=${bootElapsedMs()}ms${note ? ` ${note}` : ''}`);
}

/** A post-window phase (provider probes, python probe): its own line, same clock. */
export function finishBootPhase(label: string): void {
  console.log(`[boot] ${label} ${drainSteps()} total=${bootElapsedMs()}ms`);
}

/** Milliseconds since process start (rounded). */
export function bootElapsedMs(): number {
  return Math.round(performance.now() - t0);
}

/** The renderer's own parse+first-paint time, echoed into the boot log. */
export function reportRendererBoot(ms: unknown): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_REPORTED_BOOT_MS) return;
  console.log(`[boot] renderer firstPaint=${Math.round(ms)}ms`);
}

/**
 * Start pushing a runtime sample to the renderer. `getWindow` is a getter (the
 * window is recreated by the macOS activate path); a dead/absent window is
 * skipped, never touched. One sampler per process; calls after the first are
 * ignored (a restart path calls `stopPerfSampler` first).
 */
export function startPerfSampler(getWindow: () => BrowserWindow | null | undefined): void {
  stopPerfSampler();
  sampler = setInterval(() => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const mem = process.memoryUsage();
    win.webContents.send('perf:stats', {
      ms: bootElapsedMs(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      external: mem.external,
      // Public API (Node 16.4+): the live libuv/handle count — the number
      // "watcher-handle counts have never been measured" asked for.
      resources: process.getActiveResourcesInfo().length,
      windows: 1,
    });
  }, PERF_SAMPLE_INTERVAL_MS);
}

export function stopPerfSampler(): void {
  if (sampler !== null) {
    clearInterval(sampler);
    sampler = null;
  }
}
