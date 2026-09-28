import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockGetProvider = vi.hoisted(() => vi.fn());
const mockWriteName = vi.hoisted(() => vi.fn());
const mockWriteStatus = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
// Captures each fs.watch registration so a test can fire the change callback.
const watchRecs = vi.hoisted(() => [] as Array<{ fire: () => void; closed: boolean }>);

vi.mock('./providers/registry', () => ({ getProvider: mockGetProvider }));
vi.mock('./hook-status', () => ({
  STATUS_DIR: '/tmp/vibeyard',
  writeCliSessionName: mockWriteName,
  writeStatus: mockWriteStatus,
}));
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  watch: (_p: string, cb: () => void) => {
    const rec = { fire: cb, closed: false };
    watchRecs.push(rec);
    return { on: () => {}, close: () => { rec.closed = true; } };
  },
}));

import {
  registerTranscriptSync,
  unregisterTranscriptSync,
  _resetTranscriptSyncForTesting,
} from './session-transcript-sync';
import type { CliProvider } from './providers/provider';
import type { CliSessionStatus } from '../shared/types';

interface ProviderOpts {
  selfTitles?: boolean;
  polledStatus?: boolean;
  title?: { value: string | null };
  status?: { value: CliSessionStatus | null };
  path?: string | null;
}

function makeProvider(opts: ProviderOpts): CliProvider {
  return {
    meta: {
      capabilities: {
        selfTitles: !!opts.selfTitles,
        polledStatus: !!opts.polledStatus,
      },
    },
    getTranscriptPath: vi.fn(() => opts.path ?? null),
    readSessionTitle: opts.title ? vi.fn(() => opts.title!.value) : undefined,
    readSessionStatus: opts.status ? vi.fn(() => opts.status!.value) : undefined,
  } as unknown as CliProvider;
}

let provider: CliProvider;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetTranscriptSyncForTesting();
  mockGetProvider.mockImplementation(() => provider);
  mockExistsSync.mockReturnValue(true); // cached path exists by default
  watchRecs.length = 0;
});

afterEach(() => {
  _resetTranscriptSyncForTesting();
  vi.useRealTimers();
});

describe('title mirroring', () => {
  it('mirrors the title into the .name channel on the first tick', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Fix the bug' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).toHaveBeenCalledWith('ui-1', 'Fix the bug', 'cli-1');
  });

  it('does not re-write an unchanged title', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Stable' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).toHaveBeenCalledTimes(1);
  });

  it('writes again when the title changes', () => {
    const title = { value: 'One' };
    provider = makeProvider({ selfTitles: true, title, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    title.value = 'Two';
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).toHaveBeenLastCalledWith('ui-1', 'Two', 'cli-1');
    expect(mockWriteName).toHaveBeenCalledTimes(2);
  });

  it('writes nothing while the provider has no title yet', () => {
    provider = makeProvider({ selfTitles: true, title: { value: null }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).not.toHaveBeenCalled();
  });

  it('retries after a failed title write (lastTitle not advanced)', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'T' }, path: '/t.jsonl' });
    mockWriteName.mockImplementationOnce(() => { throw new Error('disk'); });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // throws, swallowed
    vi.advanceTimersByTime(2000); // retried
    expect(mockWriteName).toHaveBeenCalledTimes(2);
    expect(mockWriteName).toHaveBeenLastCalledWith('ui-1', 'T', 'cli-1');
  });
});

describe('status mirroring', () => {
  it('mirrors the status into the .status channel on the first tick', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledWith('ui-1', 'working');
  });

  it('does not re-write an unchanged status', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);
  });

  it('writes again when the status changes', () => {
    const status = { value: 'working' as CliSessionStatus };
    provider = makeProvider({ polledStatus: true, status, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    status.value = 'completed';
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenLastCalledWith('ui-1', 'completed');
    expect(mockWriteStatus).toHaveBeenCalledTimes(2);
  });

  it('writes nothing while the provider has no status yet', () => {
    provider = makeProvider({ polledStatus: true, status: { value: null }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).not.toHaveBeenCalled();
  });
});

describe('transcript path caching', () => {
  it('resolves the transcript path once and reuses it across ticks', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    // Resolved on the first tick only; later ticks hit the cache (existsSync true).
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the cached transcript path disappears', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    mockExistsSync.mockReturnValue(true);
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // resolve
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
    mockExistsSync.mockReturnValue(false); // transcript recreated / moved
    vi.advanceTimersByTime(2000); // cache miss → re-resolve
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(2);
  });

  it('reads title and status from the one resolved path (OMP both)', () => {
    provider = makeProvider({
      selfTitles: true,
      polledStatus: true,
      title: { value: 'Title' },
      status: { value: 'working' },
      path: '/resolved.jsonl',
    });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
    expect(provider.readSessionTitle).toHaveBeenCalledWith('/resolved.jsonl');
    expect(provider.readSessionStatus).toHaveBeenCalledWith('/resolved.jsonl');
    expect(mockWriteName).toHaveBeenCalledWith('ui-1', 'Title', 'cli-1');
    expect(mockWriteStatus).toHaveBeenCalledWith('ui-1', 'working');
  });

  it('passes cwd and configDir to getTranscriptPath', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj', '/profiles/work');
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).toHaveBeenCalledWith('cli-1', '/proj', '/profiles/work');
  });

  it('does nothing when the transcript cannot be resolved', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: null });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionStatus).not.toHaveBeenCalled();
    expect(mockWriteStatus).not.toHaveBeenCalled();
  });
});

describe('capability gating', () => {
  it('skips a provider with neither capability', () => {
    provider = makeProvider({ title: { value: 'x' }, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'claude', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
    expect(mockWriteName).not.toHaveBeenCalled();
    expect(mockWriteStatus).not.toHaveBeenCalled();
  });

  it('skips a selfTitles provider that has no readSessionTitle reader', () => {
    provider = makeProvider({ selfTitles: true, path: '/t.jsonl' }); // no title reader
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    // No reader and no status → nothing to poll → no entry, no timer work.
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('stops writing after unregister', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);
    unregisterTranscriptSync('ui-1');
    vi.advanceTimersByTime(4000);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);
  });
});

describe('fs.watch fast path', () => {
  it('establishes a watch on the resolved transcript path', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // first sync resolves the path + starts the watch
    expect(watchRecs.length).toBe(1);
    expect(watchRecs[0].closed).toBe(false);
  });

  it('re-syncs on a watch event before the next 2s poll', () => {
    const status = { value: 'working' as CliSessionStatus };
    provider = makeProvider({ polledStatus: true, status, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // sync #1 → write 'working'
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);

    // Transcript changes; the watch fires. The debounce re-syncs well before
    // the next poll tick (t=4000), proving the watch drives low latency.
    status.value = 'completed';
    watchRecs[0].fire();
    vi.advanceTimersByTime(150); // DEBOUNCE_MS
    expect(mockWriteStatus).toHaveBeenCalledTimes(2);
    expect(mockWriteStatus).toHaveBeenLastCalledWith('ui-1', 'completed');
  });

  it('coalesces a burst of watch events into one re-sync', () => {
    const status = { value: 'working' as CliSessionStatus };
    provider = makeProvider({ polledStatus: true, status, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);

    status.value = 'completed';
    watchRecs[0].fire();
    watchRecs[0].fire();
    watchRecs[0].fire(); // burst — only the first schedules the debounce
    vi.advanceTimersByTime(150);
    expect(mockWriteStatus).toHaveBeenCalledTimes(2);
  });

  it('closes the watch on unregister', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(watchRecs.length).toBe(1);
    unregisterTranscriptSync('ui-1');
    expect(watchRecs[0].closed).toBe(true);
  });
});
