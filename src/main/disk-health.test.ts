import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { promises as fsp } from 'fs';
import { startDiskHealthPreflight, getLastDiskHealth, DEFAULT_LOW_WATER_BYTES } from './disk-health';

vi.mock('fs', () => ({
  promises: {
    statfs: vi.fn(),
  },
}));

const mockStatfs = vi.mocked(fsp.statfs);

/** Shape the preflight consumes (availBlocks/blockSize spelling). */
function space(availableBytes: number, blockSize = 4096): { availBlocks: number; blockSize: number } {
  return { availBlocks: Math.floor(availableBytes / blockSize), blockSize };
}

const LOW_BYTES = DEFAULT_LOW_WATER_BYTES - 1024;
const OK_BYTES = DEFAULT_LOW_WATER_BYTES * 4;

describe('startDiskHealthPreflight', () => {
  let onStatus: Mock;
  let isoSpy: MockInstance;
  let stop: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    isoSpy = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-23T00:00:00.000Z');
    onStatus = vi.fn();
    stop = null;
  });
  afterEach(() => {
    if (stop) stop();
    vi.useRealTimers();
    isoSpy.mockRestore();
    vi.clearAllMocks();
  });

  function start(opts?: { checkIntervalMs?: number; lowWaterBytes?: number }): void {
    stop = startDiskHealthPreflight({
      getUserDataPath: () => '/fake/userData',
      onStatus,
      checkIntervalMs: 60_000,
      ...opts,
    });
  }

  it('emits one "low" status once at startup when below the low-water mark', async () => {
    mockStatfs.mockResolvedValue(space(LOW_BYTES) as never);
    start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockStatfs).toHaveBeenCalledWith('/fake/userData');
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith({
      state: 'low',
      availableBytes: LOW_BYTES - (LOW_BYTES % 4096),
      checkedAt: '2026-10-23T00:00:00.000Z',
    });
  });

  it('does not repeat the "low" status while the disk stays low', async () => {
    mockStatfs.mockResolvedValue(space(LOW_BYTES) as never);
    start({ checkIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledTimes(1);

    // Five more ticks, disk still low — zero repeats.
    await vi.advanceTimersByTimeAsync(5 * 10_000);
    expect(mockStatfs).toHaveBeenCalledTimes(6);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it('emits exactly one "ok" on recovery, then goes quiet', async () => {
    mockStatfs.mockResolvedValue(space(LOW_BYTES) as never);
    start({ checkIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'low' }));

    mockStatfs.mockResolvedValue(space(OK_BYTES) as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ok', availableBytes: OK_BYTES }));

    // Steady ok: no further emissions.
    await vi.advanceTimersByTimeAsync(3 * 10_000);
    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it('emits one "unknown" when statfs rejects, and repeats nothing', async () => {
    mockStatfs.mockRejectedValue(new Error('EPERM: operation not permitted, statfs'));
    start({ checkIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith({ state: 'unknown', checkedAt: '2026-10-23T00:00:00.000Z' });

    await vi.advanceTimersByTimeAsync(3 * 10_000);
    expect(onStatus).toHaveBeenCalledTimes(1);

    // Recovery from unknown transitions to a real state exactly once.
    mockStatfs.mockResolvedValue(space(OK_BYTES) as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'ok' }));
  });

  it('emits "ok" once at startup and stays quiet while healthy', async () => {
    mockStatfs.mockResolvedValue(space(OK_BYTES) as never);
    start({ checkIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(5 * 10_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'ok' }));
  });

  it('stop() clears the interval; a late startup answer emits nothing', async () => {
    const gate = Promise.withResolvers<{ availBlocks: number; blockSize: number }>();
    mockStatfs.mockImplementation(() => gate.promise as never);
    start({ checkIntervalMs: 10_000 });
    stop!();
    gate.resolve(space(LOW_BYTES));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('serves the last emitted status via getLastDiskHealth', async () => {
    mockStatfs.mockResolvedValue(space(LOW_BYTES) as never);
    start({ checkIntervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getLastDiskHealth()).toEqual(expect.objectContaining({ state: 'low' }));
  });
});
