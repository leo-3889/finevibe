import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockGetProvider = vi.hoisted(() => vi.fn());
const mockWriteName = vi.hoisted(() => vi.fn());
const mockWriteStatus = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
// The 2s tick gates both content reads on the transcript's (mtime,size) tuple
// (PA-02), so the mock file has one shared identity a test can move.
const fileTuple = vi.hoisted(() => ({ mtimeMs: 1_000, size: 100 }));
// A transcript the poller has resolved; `false` = the path is gone.
const filePresent = vi.hoisted(() => ({ value: true }));
// Captures each fs.watch registration so a test can fire the change callback.
const watchRecs = vi.hoisted(() => [] as Array<{ fire: () => void; closed: boolean }>);

vi.mock('./providers/registry', () => ({ getProvider: mockGetProvider }));
vi.mock('./hook-status', () => ({
  STATUS_DIR: '/tmp/finevibe',
  writeCliSessionName: mockWriteName,
  writeStatus: mockWriteStatus,
}));
vi.mock('fs', () => ({
  statSync: mockStatSync,
  watch: (_p: string, cb: () => void) => {
    const rec = { fire: cb, closed: false };
    watchRecs.push(rec);
    return { on: () => {}, close: () => { rec.closed = true; } };
  },
}));

/** Simulate a write to the transcript: a real append moves (mtime,size). */
function writeTranscript(): void {
  fileTuple.mtimeMs += 1_000;
  fileTuple.size += 64;
}

/** Remove the cached transcript (recreated/moved path → forces a re-resolve). */
function removeTranscript(): void {
  filePresent.value = false;
}

function statImpl(): (p: string) => { mtimeMs: number; size: number } {
  return () => {
    if (!filePresent.value) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return fileTuple;
  };
}

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
  filePresent.value = true;
  fileTuple.mtimeMs = 1_000;
  fileTuple.size = 100;
  mockStatSync.mockImplementation(statImpl()); // cached path exists, unchanged
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
    writeTranscript(); // the title change is a real transcript write (PA-02)
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

describe('titleOnly (restored-session) mode', () => {
  it('mirrors the title but not the status', () => {
    provider = makeProvider({
      selfTitles: true,
      polledStatus: true,
      title: { value: 'Restored title' },
      status: { value: 'working' },
      path: '/t.jsonl',
    });
    expect(registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true })).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).toHaveBeenCalledWith('ui-1', 'Restored title', 'cli-1');
    expect(mockWriteStatus).not.toHaveBeenCalled();
  });

  it('a resume re-register (no flag) upgrades the entry to mirror status too', () => {
    provider = makeProvider({
      selfTitles: true,
      polledStatus: true,
      title: { value: 'T' },
      status: { value: 'working' },
      path: '/t.jsonl',
    });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true });
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).not.toHaveBeenCalled();
    // Resume re-registers the same conversation without the flag.
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledWith('ui-1', 'working');
  });

  it('re-registering with the same titleOnly flag keeps the entry (no re-emit)', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Stable' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true });
    vi.advanceTimersByTime(2000);
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true });
    vi.advanceTimersByTime(2000);
    expect(mockWriteName).toHaveBeenCalledTimes(1);
  });

  it('returns false when the provider polls neither title nor status', () => {
    provider = makeProvider({ path: '/t.jsonl' }); // no selfTitles, no polledStatus
    expect(registerTranscriptSync('ui-1', 'codex', 'cli-1', '/proj')).toBe(false);
  });

  it('a released title-only entry leaves no stale watch and re-registers clean on resume', () => {
    provider = makeProvider({
      selfTitles: true,
      polledStatus: true,
      title: { value: 'T' },
      status: { value: 'working' },
      path: '/t.jsonl',
    });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj', undefined, { titleOnly: true });
    vi.advanceTimersByTime(2000); // resolves the path, opens the watch, mirrors the title
    expect(watchRecs.length).toBe(1);
    expect(watchRecs[0].closed).toBe(false);
    // Release: the tab was closed without ever being resumed.
    unregisterTranscriptSync('ui-1');
    expect(watchRecs[0].closed).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(mockWriteName).toHaveBeenCalledTimes(1); // no writes after release
    expect(mockWriteStatus).not.toHaveBeenCalled();
    // Resume re-registers the same conversation without the flag.
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledWith('ui-1', 'working');
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
    writeTranscript(); // a status change is a real transcript write (PA-02)
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
    // Resolved on the first tick only; later ticks hit the cache (stat ok).
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when the cached transcript path disappears', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    filePresent.value = true;
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // resolve
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
    removeTranscript(); // transcript recreated / moved
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

  it('passes cwd, configDir and the launch session dir to getTranscriptPath', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj', '/profiles/work', { sessionDir: '/launch/ui-1' });
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).toHaveBeenCalledWith('cli-1', '/proj', '/profiles/work', '/launch/ui-1');
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
    writeTranscript(); // the watch event follows a real write (PA-02 gate)
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

    writeTranscript();
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

  // C3R-03: a watch event is positive liveness evidence — the file exists
  // and is being written. It must lift the C2M-05 read-backoff window, which
  // exists only to pace pure-tick retries.
  it('a watch event lifts the read-backoff window', () => {
    const status = { value: 'working' as CliSessionStatus | 'idle' };
    provider = {
      meta: { capabilities: { selfTitles: true, polledStatus: true } },
      getTranscriptPath: vi.fn(() => '/t.jsonl'),
      // Every title read throws: each clean tick arms/extends the backoff.
      readSessionTitle: vi.fn(() => {
        throw new Error('transcript mid-write');
      }),
      readSessionStatus: vi.fn(() => status.value),
    } as unknown as CliProvider;
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // t=2000: read fails → readFailures 1, gate 4000
    status.value = 'completed';
    vi.advanceTimersByTime(2000); // t=4000: gate open → status read, read fails → gate 8000
    expect(mockWriteStatus).toHaveBeenCalledTimes(2);
    status.value = 'idle';
    vi.advanceTimersByTime(2000); // t=6000: inside the window — tick is gated
    expect(mockWriteStatus).toHaveBeenCalledTimes(2); // no third read

    writeTranscript();
    watchRecs[0].fire();
    vi.advanceTimersByTime(150); // DEBOUNCE_MS
    expect(mockWriteStatus).toHaveBeenCalledTimes(3); // watch event read through
    expect(mockWriteStatus).toHaveBeenLastCalledWith('ui-1', 'idle');
  });
});

describe('/clear re-adoption (re-registering the same UI session)', () => {
  it('closes the incumbent watch when the cli session id changes', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Old topic' }, path: '/old.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // resolve + establish watch #1
    expect(watchRecs.length).toBe(1);
    expect(mockWriteName).toHaveBeenLastCalledWith('ui-1', 'Old topic', 'cli-1');

    // The session-id watcher hands over a new transcript for the same UI
    // session (what `/clear` does). The old fs.watch must be closed, not
    // silently dropped from the map while still open.
    const next = makeProvider({ selfTitles: true, title: { value: 'New topic' }, path: '/new.jsonl' });
    provider = next; // the registry mock resolves the live `provider` binding
    registerTranscriptSync('ui-1', 'omp', 'cli-2', '/proj');
    expect(watchRecs[0].closed).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(watchRecs.length).toBe(2);
    expect(watchRecs[1].closed).toBe(false);
    // The entry re-resolved against the NEW cli id and mirrors the new title.
    expect(next.getTranscriptPath).toHaveBeenCalledWith('cli-2', '/proj', undefined, undefined);
    expect(mockWriteName).toHaveBeenLastCalledWith('ui-1', 'New topic', 'cli-2');
  });

  it('a stale watch event from the replaced entry does not re-sync', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Old' }, path: '/old.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    const callsAfterHandover = mockWriteName.mock.calls.length;

    registerTranscriptSync('ui-1', 'omp', 'cli-2', '/proj');
    watchRecs[0].fire(); // a late event from the dead watcher
    vi.advanceTimersByTime(150); // DEBOUNCE_MS
    expect(mockWriteName).toHaveBeenCalledTimes(callsAfterHandover);
  });

  it('keeps the incumbent entry when re-registering the identical conversation', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1);

    // A re-spawn of the same session re-registers the same conversation:
    // the cached path, the written title/status and the live watch all stay.
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    expect(watchRecs.length).toBe(1);
    expect(watchRecs[0].closed).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(1);
    expect(mockWriteStatus).toHaveBeenCalledTimes(1); // no re-emit of an unchanged status
  });

  it('a changed configDir is treated as a different conversation', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/a.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj', '/profiles/a');
    vi.advanceTimersByTime(2000);
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj', '/profiles/b');
    expect(watchRecs[0].closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(provider.getTranscriptPath).toHaveBeenLastCalledWith('cli-1', '/proj', '/profiles/b', undefined);
  });
});

describe('unresolvable transcript backoff', () => {
  it('doubles the retry interval instead of scanning every 2s tick', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: null });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    // Attempts land at t=2s, 4s, 8s, 16s (2s, 4s, 8s, 16s waits) rather
    // than once per tick, which would be 8 by now.
    vi.advanceTimersByTime(16000);
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(4);
  });

  it('caps the backoff and logs once per entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: null });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(64000); // 6th failure reaches the 60s cap
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('retrying every 60s');
    vi.advanceTimersByTime(120000); // never spams again
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still picks up a transcript that appears late', () => {
    const opts = { polledStatus: true, status: { value: 'working' as CliSessionStatus }, path: null as string | null };
    provider = makeProvider(opts);
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(8000); // 3 failed attempts, now waiting 8s
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(3);

    opts.path = '/late.jsonl';
    vi.advanceTimersByTime(8000); // next backoff window resolves it
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(4);
    expect(mockWriteStatus).toHaveBeenCalledWith('ui-1', 'working');
    // And the cache resumes: no further re-resolution while the file exists.
    vi.advanceTimersByTime(10000);
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(4);
  });

  it('a throwing resolver is backed off the same way as a null one', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' } });
    provider.getTranscriptPath = vi.fn(() => { throw new Error('boom'); });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(8000);
    expect(provider.getTranscriptPath).toHaveBeenCalledTimes(3);
    expect(mockWriteStatus).not.toHaveBeenCalled();
  });
});

describe('per-tick read gating (PA-02)', () => {
  it('reads neither head nor tail while (mtime,size) is unchanged', () => {
    provider = makeProvider({
      selfTitles: true,
      polledStatus: true,
      title: { value: 'T' },
      status: { value: 'working' },
      path: '/t.jsonl',
    });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // resolve + the one read pair
    expect(provider.readSessionTitle).toHaveBeenCalledTimes(1);
    expect(provider.readSessionStatus).toHaveBeenCalledTimes(1);

    // Two idle ticks: one statSync each, zero open+read+close triples. This is
    // the 200-tab case — the old poll re-read the head and the tail every 2s.
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionTitle).toHaveBeenCalledTimes(1);
    expect(provider.readSessionStatus).toHaveBeenCalledTimes(1);
    expect(mockStatSync).toHaveBeenCalledTimes(3);

    // A write moves the tuple, so the very next tick reads again.
    writeTranscript();
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionTitle).toHaveBeenCalledTimes(2);
    expect(provider.readSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('re-reads on a size change with an unchanged mtime (tuple, not mtime alone)', () => {
    provider = makeProvider({ polledStatus: true, status: { value: 'working' }, path: '/t.jsonl' });
    registerTranscriptSync('ui-1', 'pi', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionStatus).toHaveBeenCalledTimes(1);

    fileTuple.size += 1; // a coarse-mtime filesystem can report the same mtime
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('leaves the entry due when a read throws (transcript mid-write)', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'T' }, path: '/t.jsonl' });
    const reader = vi.fn()
      .mockImplementationOnce(() => { throw new Error('EAGAIN'); })
      .mockImplementation(() => 'T');
    provider.readSessionTitle = reader as unknown as CliProvider['readSessionTitle'];
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000); // read throws → the tuple must NOT be recorded
    expect(reader).toHaveBeenCalledTimes(1);
    expect(mockWriteName).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000); // retried on the same (mtime,size)
    expect(reader).toHaveBeenCalledTimes(2);
    expect(mockWriteName).toHaveBeenCalledWith('ui-1', 'T', 'cli-1');
  });

  it('re-reads from scratch after a /clear re-adoption moves the file', () => {
    provider = makeProvider({ selfTitles: true, title: { value: 'Old' }, path: '/old.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-1', '/proj');
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionTitle).toHaveBeenCalledTimes(1); // gated idle tick

    provider = makeProvider({ selfTitles: true, title: { value: 'New' }, path: '/new.jsonl' });
    registerTranscriptSync('ui-1', 'omp', 'cli-2', '/proj');
    vi.advanceTimersByTime(2000);
    expect(provider.readSessionTitle).toHaveBeenCalledTimes(1);
    expect(mockWriteName).toHaveBeenLastCalledWith('ui-1', 'New', 'cli-2');
  });
});
