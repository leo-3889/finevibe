import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Boot/runtime measurement (audit P1). Each test re-imports the module: the
 * timeline and the sampler are module-scoped (one boot per process), so state
 * must not leak across cases.
 */
async function fresh() {
  vi.resetModules();
  return await import('./boot-timing');
}

const winStub = (send = vi.fn(), destroyed = false) =>
  ({ isDestroyed: () => destroyed, webContents: { send } }) as never;

describe('boot timeline', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('prints one summary line naming every step and the total', async () => {
    const { markBoot, finishBoot, bootElapsedMs } = await fresh();
    markBoot('sweeps');
    markBoot('ipc');
    markBoot('window');
    finishBoot('providers=7');
    finishBoot('ignored');

    const logs = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const lines = logs.filter((l) => l.startsWith('[boot] '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('sweeps=');
    expect(lines[0]).toContain('ipc=');
    expect(lines[0]).toContain('window=');
    expect(lines[0]).toContain('total=');
    expect(lines[0]).toContain('providers=7');
    expect(bootElapsedMs()).toBeGreaterThanOrEqual(0);
  });
});

describe('renderer boot echo', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('accepts a sane ms and rejects junk, negatives and clock skew', async () => {
    const { reportRendererBoot } = await fresh();
    reportRendererBoot(412.6);
    reportRendererBoot('412' as never);
    reportRendererBoot(-5);
    reportRendererBoot(10 * 60_000 + 1);
    reportRendererBoot(Number.NaN);

    const lines = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[boot] renderer'));
    expect(lines).toEqual(['[boot] renderer init=413ms']);
  });
});

describe('runtime sampler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('samples RSS/heap/handles on the cadence, skips a dead window, stops on stop', async () => {
    const { startPerfSampler, stopPerfSampler, PERF_SAMPLE_INTERVAL_MS } = await fresh();
    const send = vi.fn();
    let destroyed = false;
    startPerfSampler(() => winStub(send, destroyed));

    vi.advanceTimersByTime(PERF_SAMPLE_INTERVAL_MS + 1);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, sample] = send.mock.calls[0] as [string, Record<string, number>];
    expect(channel).toBe('perf:stats');
    expect(sample.rss).toBeGreaterThan(0);
    expect(sample.heapUsed).toBeGreaterThan(0);
    expect(sample.resources).toBeGreaterThanOrEqual(0);
    expect(sample.ms).toBeGreaterThanOrEqual(0);

    destroyed = true;
    vi.advanceTimersByTime(PERF_SAMPLE_INTERVAL_MS + 1);
    expect(send).toHaveBeenCalledTimes(1);

    destroyed = false;
    stopPerfSampler();
    vi.advanceTimersByTime(PERF_SAMPLE_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('re-arming replaces the old sampler (one sample per cadence, not two)', async () => {
    const { startPerfSampler, stopPerfSampler, PERF_SAMPLE_INTERVAL_MS } = await fresh();
    const first = vi.fn();
    const second = vi.fn();
    startPerfSampler(() => winStub(first));
    startPerfSampler(() => winStub(second));
    vi.advanceTimersByTime(PERF_SAMPLE_INTERVAL_MS + 1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopPerfSampler();
  });
});
