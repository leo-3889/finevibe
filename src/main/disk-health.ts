import { promises as fsp } from 'fs';
import type { DiskHealth } from '../shared/types';

export type { DiskHealth };

/** Below this many free bytes on the userData volume, the disk is 'low'.
 * 200 MiB comfortably covers state.json atomics (tmp + fsync + rename) plus
 * a session export, while firing long before the volume itself hits ENOSPC. */
export const DEFAULT_LOW_WATER_BYTES = 200 * 1024 * 1024;

/** Disk fill is a minutes-scale event; a per-minute statfs is plenty. The
 * incident's lesson is that per-write probing is what floods — this tick
 * only classifies, it never emits repeats. */
const DEFAULT_CHECK_INTERVAL_MS = 60_000;

/** The most recent emitted status, served verbatim on `disk-health:get` so
 * a renderer that mounts mid-outage renders the banner without waiting for
 * the next transition. Null until the first check emits. */
let lastStatus: DiskHealth | null = null;

export function getLastDiskHealth(): DiskHealth | null {
  return lastStatus;
}

/** Node's StatsFs spells the fields `bavail`/`bsize`; the fake used in tests
 * (and the contract wording) use `availBlocks`/`blockSize`. Accept both. */
type StatfsLike = {
  availBlocks?: number;
  bavail?: number;
  blockSize?: number;
  bsize?: number;
};

/**
 * Periodic free-space check on the userData volume. `onStatus` fires on the
 * first check and on state TRANSITIONS only (ok↔low↔unknown) — never on
 * every tick, so a full disk yields one banner, not per-write noise.
 * Returns a stop() that clears the timer (call on app quit).
 */
export function startDiskHealthPreflight(opts: {
  getUserDataPath: () => string;
  onStatus: (status: DiskHealth) => void;
  checkIntervalMs?: number;
  lowWaterBytes?: number;
}): () => void {
  const lowWaterBytes = opts.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  let lastState: DiskHealth['state'] | null = null;
  let stopped = false;

  const emit = (status: DiskHealth): void => {
    if (stopped || status.state === lastState) return;
    lastState = status.state;
    lastStatus = status;
    opts.onStatus(status);
  };

  const check = async (): Promise<void> => {
    const checkedAt = new Date().toISOString();
    try {
      const stats = (await fsp.statfs(opts.getUserDataPath())) as StatfsLike;
      const availBlocks = stats.availBlocks ?? stats.bavail;
      const blockSize = stats.blockSize ?? stats.bsize;
      const availableBytes = availBlocks !== undefined && blockSize !== undefined
        ? availBlocks * blockSize
        : NaN;
      if (!Number.isFinite(availableBytes) || availableBytes < 0) {
        emit({ state: 'unknown', checkedAt });
        return;
      }
      emit({ state: availableBytes < lowWaterBytes ? 'low' : 'ok', availableBytes, checkedAt });
    } catch {
      // statfs failing (unmounted volume, permissions) is not a per-tick
      // story: 'unknown' is emitted once, repeats collapse.
      emit({ state: 'unknown', checkedAt });
    }
  };

  void check();
  const timer = setInterval(() => { void check(); }, checkIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
