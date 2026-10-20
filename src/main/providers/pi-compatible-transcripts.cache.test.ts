import { describe, it, expect, vi } from 'vitest';

// PO-04/PO-07 fallback-cache behavior is pure Map logic keyed by file size;
// the 512-entry LRU tests must not depend on real temp-file I/O speed — with
// 513 files a disk-backed run sits right on vitest's 5s default timeout on a
// loaded Windows machine and flips red under contention. A minimal in-memory
// fs stub keeps the same semantics (open/fstat/read/stat sizes drive cache
// invalidation) deterministically. `vi.mock` is hoisted above the import of
// the module under test, so the module captures the mock.
const files = new Map<string, string>();
const handles = new Map<number, { path: string }>();
let nextFd = 100;

const bytesOf = (filePath: string): Buffer => {
  const content = files.get(filePath);
  if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return Buffer.from(content, 'utf-8');
};

vi.mock('fs', () => ({
  openSync: (filePath: string) => {
    const fd = nextFd++;
    handles.set(fd, { path: filePath });
    return fd;
  },
  fstatSync: (fd: number) => ({ size: bytesOf(handles.get(fd)!.path).length }),
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    const data = bytesOf(handles.get(fd)!.path);
    const start = position === null ? 0 : position;
    const slice = data.subarray(start, start + length);
    slice.copy(buffer, offset);
    return slice.length;
  },
  closeSync: (fd: number) => {
    handles.delete(fd);
  },
  statSync: (filePath: string) => ({ size: bytesOf(filePath).length }),
}));

const {
  readTranscriptStatusSync,
  TAIL_READ_BYTES,
  MAX_STATUS_TAIL_CACHE,
  _resetStatusTailCacheForTesting,
  _statusTailCacheSnapshotForTesting,
} = await import('./pi-compatible-transcripts');

const header = (id: string, cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: 't', cwd });

const assistant = (stopReason: string) =>
  JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason } });

const hugeAssistantEntry = (stopReason: string) =>
  JSON.stringify({
    type: 'message',
    message: { role: 'assistant', stopReason, content: 'x'.repeat(TAIL_READ_BYTES + 4096) },
  });

/** Register an in-memory transcript; returns its (fake) path. */
const put = (filePath: string, content: string): string => {
  files.set(filePath, content);
  return filePath;
};

describe('readTranscriptStatusSync fallback cache (PO-04/PO-07)', () => {
  it('maps a huge cancelled final entry to waiting on the cached fallback path', () => {
    _resetStatusTailCacheForTesting();
    const file = put('/vb/cancelled.jsonl', `${[header('s1', '/proj'), hugeAssistantEntry('aborted')].join('\n')}\n`);
    // The 16KB window lands inside the huge entry; the bounded fallback
    // must surface `waiting` for the cancelled turn, then serve it cached.
    expect(readTranscriptStatusSync(file)).toBe('waiting');
    expect(readTranscriptStatusSync(file)).toBe('waiting');
    expect(_statusTailCacheSnapshotForTesting()).toEqual([
      { filePath: file, size: files.get(file)!.length, status: 'waiting' },
    ]);
  });

  it('re-reads when the file size changes instead of serving the stale cached status', () => {
    _resetStatusTailCacheForTesting();
    const file = put('/vb/grow.jsonl', `${header('s1', '/proj')}\n`);
    // Header only: no meaningful entry, so the fallback caches a null status.
    expect(readTranscriptStatusSync(file)).toBeNull();
    expect(_statusTailCacheSnapshotForTesting()).toHaveLength(1);
    files.set(file, `${files.get(file)}${hugeAssistantEntry('stop')}\n`);
    expect(readTranscriptStatusSync(file)).toBe('completed');
    expect(_statusTailCacheSnapshotForTesting()[0].status).toBe('completed');
  });

  it('drops the cache entry once the small window yields a status again', () => {
    _resetStatusTailCacheForTesting();
    const file = put('/vb/recover.jsonl', `${[header('s1', '/proj'), hugeAssistantEntry('stop')].join('\n')}\n`);
    expect(readTranscriptStatusSync(file)).toBe('completed');
    expect(_statusTailCacheSnapshotForTesting()).toHaveLength(1);
    // A small trailing entry the 16KB window can parse again — the cached
    // fallback is dropped, bounding memory for closed sessions.
    files.set(file, `${files.get(file)}${assistant('stop')}\n`);
    expect(readTranscriptStatusSync(file)).toBe('completed');
    expect(_statusTailCacheSnapshotForTesting()).toHaveLength(0);
  });

  it('evicts the oldest path past MAX_STATUS_TAIL_CACHE entries', () => {
    _resetStatusTailCacheForTesting();
    // Header-only transcripts yield no status, so every read goes through
    // (and populates) the fallback cache.
    const paths: string[] = [];
    for (let i = 0; i <= MAX_STATUS_TAIL_CACHE; i++) {
      paths.push(put(`/vb/lru/s${i}.jsonl`, `${header(`s${i}`, '/proj')}\n`));
    }
    for (const file of paths.slice(0, MAX_STATUS_TAIL_CACHE)) {
      expect(readTranscriptStatusSync(file)).toBeNull();
    }
    expect(_statusTailCacheSnapshotForTesting().map((e) => e.filePath)).toEqual(
      paths.slice(0, MAX_STATUS_TAIL_CACHE),
    );
    // One path past capacity evicts the oldest key, keeping the cap.
    readTranscriptStatusSync(paths[MAX_STATUS_TAIL_CACHE]);
    const snap = _statusTailCacheSnapshotForTesting();
    expect(snap).toHaveLength(MAX_STATUS_TAIL_CACHE);
    expect(snap.map((e) => e.filePath)).not.toContain(paths[0]);
    expect(snap[snap.length - 1].filePath).toBe(paths[MAX_STATUS_TAIL_CACHE]);
  });

  it('moves a cache hit to the newest position (LRU recency refresh)', () => {
    _resetStatusTailCacheForTesting();
    const paths: string[] = [];
    for (let i = 0; i < MAX_STATUS_TAIL_CACHE; i++) {
      paths.push(put(`/vb/lru2/s${i}.jsonl`, `${header(`s${i}`, '/proj')}\n`));
    }
    for (const file of paths) {
      expect(readTranscriptStatusSync(file)).toBeNull();
    }
    // Refresh the oldest key, then exceed capacity: the refreshed key
    // survives and the next-oldest one is evicted instead.
    expect(readTranscriptStatusSync(paths[0])).toBeNull();
    const extra = put('/vb/lru2/extra.jsonl', `${header('extra', '/proj')}\n`);
    readTranscriptStatusSync(extra);
    const cachedPaths = _statusTailCacheSnapshotForTesting().map((e) => e.filePath);
    expect(cachedPaths).toHaveLength(MAX_STATUS_TAIL_CACHE);
    expect(cachedPaths).not.toContain(paths[1]);
    expect(cachedPaths).toContain(paths[0]);
    expect(cachedPaths[cachedPaths.length - 2]).toBe(paths[0]);
    expect(cachedPaths[cachedPaths.length - 1]).toBe(extra);
  });
});
