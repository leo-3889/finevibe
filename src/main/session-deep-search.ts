import * as fs from 'fs';
import type { DeepSearchResult } from '../shared/types';
import type { CliProvider, TranscriptDiscovery } from './providers/provider';
import { getAllProviders } from './providers/registry';
import { readSearchIndex, writeSearchIndex, pruneSearchIndex } from './session-search-index';
import { TRANSCRIPT_IO_CONCURRENCY, TRANSCRIPT_TEXT_SEPARATOR, mapWithConcurrency } from './providers/transcript-utils';

const MAX_DERIVED_NAME_LENGTH = 80;

const MAX_CACHE_ENTRIES = 500;
// Counts both original and lowercased text. V8 string storage may use more
// bytes than this character count; this still bounds retained payload size.
const MAX_CACHE_CHARS = 8 * 1024 * 1024;

// UI2-8: a prune sweeps the provider's whole derived-index directory (one
// readdir plus an unlink per vanished source). Every search pass ends with
// one, so a query burst paid a full sweep per keystroke. The index only gains
// garbage when transcripts disappear, so one sweep per provider per interval
// is enough; the gate is claimed per provider, so a shared budget cannot let
// one chatty provider starve the others.
const PRUNE_MIN_INTERVAL_MS = 30_000;
const lastPruneAt = new Map<string, number>();

/** Claim this provider's prune slot; false while the last sweep is still fresh. */
function claimPruneSlot(providerId: string, now: number): boolean {
  const last = lastPruneAt.get(providerId);
  if (last !== undefined && now - last < PRUNE_MIN_INTERVAL_MS) return false;
  lastPruneAt.set(providerId, now);
  return true;
}

interface CacheEntry {
  text: string;
  textLower: string;
  cwd: string;
  mtime: number;
  size?: number;
  ctime?: number;
}

const textCache = new Map<string, CacheEntry>();
let cacheChars = 0;

function evictOldest(): void {
  const oldest = textCache.keys().next().value;
  if (oldest === undefined) return;
  const entry = textCache.get(oldest)!;
  cacheChars -= entry.text.length + entry.textLower.length;
  textCache.delete(oldest);
}

export function _resetForTesting(): void {
  textCache.clear();
  cacheChars = 0;
  activeReads = 0;
  drainReadQueue();
  inFlight.clear();
  lastPruneAt.clear();
}

let activeReads = 0;
/** Queued reads resolve true on a permit hand-off, false when an abort drains the queue. */
const readWaiters: Array<(granted: boolean) => void> = [];
const inFlight = new Map<string, Promise<CacheEntry>>();

/** A read whose caller aborted; rejects the queued item so its permit returns. */
class ReadAbortedError extends Error {
  constructor() { super('Transcript read aborted'); }
}

/**
 * Race `work` against `signal`. The fs promises have no deadline of their own
 * and cannot be cancelled: a stalled read (offline SMB/NFS home, a
 * filter-driver lock) never settles, and four of them pinned the whole gate
 * permanently. The raced-away promise keeps running in the background, but
 * its permit comes back to the pool (P2-71).
 */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new ReadAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new ReadAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    const clear = (): void => signal.removeEventListener('abort', onAbort);
    work.then(
      (value) => { clear(); resolve(value); },
      (err) => { clear(); reject(err); },
    );
  });
}

/** Take a permit, or queue. Resolves false only when a drain wakes the item. */
function acquirePermit(): Promise<boolean> {
  if (activeReads < TRANSCRIPT_IO_CONCURRENCY) {
    activeReads++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => { readWaiters.push(resolve); });
}

/** Hand the permit to the next item, or give it back to the pool. */
function releasePermit(): void {
  const next = readWaiters.shift();
  if (next) next(true);
  else activeReads--;
}

/**
 * Wake every queued item with no permit (P2-71): cancellation has to end the
 * whole queue, not just the items already in flight, or a search aborted
 * behind four stalled reads leaves items parked forever. A woken item that
 * is not itself aborted was drained by a *different* search's cancellation,
 * so it goes back to the queue; an aborted one rejects.
 */
function drainReadQueue(): void {
  while (readWaiters.length) readWaiters.shift()!(false);
}

/** Resolve holding exactly one permit; throw (holding none) on abort. */
async function acquireRead(signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (await acquirePermit()) return;
    if (signal?.aborted) throw new ReadAbortedError();
  }
}

async function getCachedIndex(provider: CliProvider, transcriptPath: string, signal?: AbortSignal, version?: StatVersion): Promise<CacheEntry> {
  const key = `${provider.meta.id}:${transcriptPath}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = (async () => {
    await acquireRead(signal);
    try { return await readIndex(provider, transcriptPath, signal, version); }
    finally { releasePermit(); }
  })();
  inFlight.set(key, work);
  try { return await work; } finally { if (inFlight.get(key) === work) inFlight.delete(key); }
}

/** The (mtime,size,ctime) tuple a CacheEntry validates against. */
interface StatVersion {
  mtime: number;
  size: number;
  ctime: number;
}

function statVersion(st: { mtimeMs: number; size: number; ctimeMs: number }): StatVersion {
  return { mtime: st.mtimeMs, size: st.size, ctime: st.ctimeMs };
}

async function readIndex(provider: CliProvider, transcriptPath: string, signal?: AbortSignal, version?: StatVersion): Promise<CacheEntry> {
  try {
    // PA-18: discovery's batched stat preflight carries the version tuple so
    // the per-transcript stat through the read gate is gone.
    const v = version ?? statVersion(await raceAbort(fs.promises.stat(transcriptPath), signal));
    const key = `${provider.meta.id}:${transcriptPath}`;
    const cached = textCache.get(key);
    if (cached && cached.mtime === v.mtime && cached.size === v.size && cached.ctime === v.ctime) {
      // Move-to-end for true LRU semantics on cache hits.
      textCache.delete(key);
      textCache.set(key, cached);
      return cached;
    }

    const saved = await raceAbort(readSearchIndex(provider.meta.id, transcriptPath, v), signal);
    const { text, cwd } = saved ?? await raceAbort(provider.indexTranscript!(transcriptPath), signal);
    if (!saved) await raceAbort(writeSearchIndex(provider.meta.id, transcriptPath, { text, cwd, ...v }), signal);
    const entry: CacheEntry = { text, textLower: text.toLowerCase(), cwd, ...v };
    const old = textCache.get(key);
    if (old) {
      cacheChars -= old.text.length + old.textLower.length;
      textCache.delete(key);
    }
    const size = entry.text.length + entry.textLower.length;
    if (size <= MAX_CACHE_CHARS) {
      while (textCache.size >= MAX_CACHE_ENTRIES || cacheChars + size > MAX_CACHE_CHARS) evictOldest();
      textCache.set(key, entry);
      cacheChars += size;
    }
    return entry;
  } catch (err) {
    // An abort is not a read failure: reject so the queued item ends now and
    // its permit returns to the pool. Every other failure keeps the empty
    // entry — one unreadable transcript must not fail the whole search.
    if (signal?.aborted) throw err;
    return { text: '', textLower: '', cwd: '', mtime: 0 };
  }
}

function scoreFuzzy(textLower: string, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (textLower.includes(q)) return 100;

  const words = q.split(/\s+/).filter(Boolean);
  const matched = words.filter(w => textLower.includes(w));
  if (matched.length === words.length) return 80;
  if (matched.length > 0) return Math.round((matched.length / words.length) * 50);
  return 0;
}

function deriveName(text: string): string | undefined {
  const separator = text.indexOf(TRANSCRIPT_TEXT_SEPARATOR);
  const first = (separator < 0 ? text : text.slice(0, separator)).trim();
  if (!first) return undefined;
  const oneLine = first.replace(/\s+/g, ' ');
  return oneLine.length > MAX_DERIVED_NAME_LENGTH
    ? `${Buffer.from(oneLine.slice(0, MAX_DERIVED_NAME_LENGTH - 1).trimEnd()).toString('utf8')}…`
    : Buffer.from(oneLine).toString('utf8');
}

function extractSnippet(text: string, textLower: string, query: string): string {
  const q = query.toLowerCase().trim();
  let idx = textLower.indexOf(q);
  if (idx === -1) {
    const firstWord = q.split(/\s+/)[0];
    idx = firstWord ? textLower.indexOf(firstWord) : -1;
  }
  if (idx === -1) idx = 0;

  const RADIUS = 60;
  const start = Math.max(0, idx - RADIUS);
  const end = Math.min(text.length, idx + Math.min(q.length, 120) + RADIUS);
  let snippet = text.slice(start, end).replace(/\n+/g, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  // Copy the short slice so it cannot retain the complete transcript backing string.
  return Buffer.from(snippet).toString('utf8');
}

const STAT_CHUNK = 64;

/**
 * PA-18: batched stat sweep over the discovered transcripts, run OUTSIDE the
 * read gate — stats are cheap metadata reads, and serializing a full corpus
 * through the 4-permit gate dominated the hot query. Resolves a per-path
 * preflight: the memory-cache entry on a version match (the hot keystroke
 * case — resolves without ever touching the gate), the fresh version tuple
 * on a miss, and NO entry for a path whose stat failed (unreadable this
 * pass, exactly as the old in-gate stat ENOENT produced an empty entry).
 */
async function preflightTranscripts(
  provider: CliProvider,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, { entry: CacheEntry } | { version: StatVersion }>> {
  const preflighted = new Map<string, { entry: CacheEntry } | { version: StatVersion }>();
  for (let i = 0; i < paths.length; i += STAT_CHUNK) {
    if (signal?.aborted) break;
    const chunk = paths.slice(i, i + STAT_CHUNK);
    const stats = await raceAbort(
      Promise.all(chunk.map(p => fs.promises.stat(p).then(statVersion, () => null))),
      signal,
    );
    for (let j = 0; j < chunk.length; j++) {
      const version = stats[j];
      if (!version) continue;
      const key = `${provider.meta.id}:${chunk[j]}`;
      const cached = textCache.get(key);
      if (cached && cached.mtime === version.mtime && cached.size === version.size && cached.ctime === version.ctime) {
        // Move-to-end for LRU, as readIndex did on in-gate hits.
        textCache.delete(key);
        textCache.set(key, cached);
        preflighted.set(chunk[j], { entry: cached });
      } else {
        preflighted.set(chunk[j], { version });
      }
    }
  }
  return preflighted;
}

async function searchOneProvider(provider: CliProvider, query: string, signal?: AbortSignal): Promise<DeepSearchResult[]> {
  if (!provider.discoverTranscripts || !provider.indexTranscript || signal?.aborted) return [];
  let discovery: TranscriptDiscovery;
  try { discovery = await provider.discoverTranscripts(signal); } catch { return []; }
  if (signal?.aborted) return [];
  const descriptors = discovery.descriptors;
  let preflighted: Map<string, { entry: CacheEntry } | { version: StatVersion }>;
  try {
    preflighted = await preflightTranscripts(provider, descriptors.map(d => d.transcriptPath), signal);
  } catch {
    // Aborted mid-sweep: this provider contributes nothing, like a failed discovery.
    return [];
  }
  if (signal?.aborted) return [];
  // Only compact results escape each worker; evicted transcript text can be collected immediately.
  // The same CLI session id can legitimately appear under two profiles (copied
  // history), so the dedup key is profile + cliSessionId; provider is already
  // scoped to this call.
  const best = new Map<string, DeepSearchResult>();
  await mapWithConcurrency(descriptors, TRANSCRIPT_IO_CONCURRENCY, async (desc) => {
    if (signal?.aborted) return;
    const pre = preflighted.get(desc.transcriptPath);
    if (!pre) return; // stat failed: not searchable in this pass
    let entry: CacheEntry;
    if ('entry' in pre) {
      entry = pre.entry;
    } else {
      try {
        entry = await getCachedIndex(provider, desc.transcriptPath, signal, pre.version);
      } catch {
        // Aborted, or a read that failed even after the abort race ended it:
        // this transcript is simply not searchable in this pass.
        return;
      }
    }
    if (signal?.aborted || !entry.textLower) return;
    const score = scoreFuzzy(entry.textLower, query);
    const identity = `${desc.profileId ?? ''}\u0000${desc.cliSessionId}`;
    const previous = best.get(identity);
    if (!score || (previous && previous.score >= score)) return;
    best.set(identity, {
      providerId: provider.meta.id, cliSessionId: desc.cliSessionId,
      projectSlug: desc.projectSlug ?? '', projectCwd: desc.projectCwd || entry.cwd,
      snippet: extractSnippet(entry.text, entry.textLower, query), score,
      derivedName: deriveName(entry.text), profileId: desc.profileId,
    });
  });
  // A root whose scan threw is not evidence its transcripts are gone: pruning
  // off a partial list unlinks the provider's whole derived index, and every
  // later search then re-reads the entire corpus. Keep the index and say so —
  // one warn per failed root (P2-70).
  for (const root of discovery.incompleteRoots) {
    console.warn(`[session-search] transcript discovery incomplete for ${provider.meta.id} (${root}); keeping the derived index`);
  }
  if (!signal?.aborted && discovery.complete && claimPruneSlot(provider.meta.id, Date.now())) {
    await pruneSearchIndex(provider.meta.id, descriptors.map(d => d.transcriptPath));
  }
  return [...best.values()];
}

export async function searchSessions(query: string, signal?: AbortSignal): Promise<DeepSearchResult[]> {
  if (!query.trim() || signal?.aborted) return [];
  // Cancellation has to reach the items queued behind the read gate, not
  // only the ones in flight (P2-71).
  const onAbort = signal && (() => drainReadQueue());
  if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
  try {
    // PA-18: provider discovery runs concurrently; the module-global read
    // gate is the shared permit pool, so aggregate transcript reads stay
    // capped at TRANSCRIPT_IO_CONCURRENCY — the old serial loop just
    // serialized six discovery sweeps on top of that cap.
    const perProvider = await Promise.all(
      getAllProviders().map(provider => searchOneProvider(provider, query, signal)),
    );
    const results = perProvider.flat();
    results.sort((a, b) => b.score - a.score);
    return signal?.aborted ? [] : results.slice(0, 20);
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
