import * as fs from 'fs';
import type { ProviderId, CliSessionStatus } from '../shared/types';
import { getProvider } from './providers/registry';
import { writeCliSessionName, writeStatus } from './hook-status';

/**
 * Provider-agnostic transcript sync — the single poller for CLIs that have
 * no hooks reporting their own title or status (today OMP and Pi).
 *
 * A provider declares `capabilities.selfTitles` (→ implements
 * `readSessionTitle(transcriptPath)`) and/or `capabilities.polledStatus`
 * (→ implements `readSessionStatus(transcriptPath)`); this module derives
 * what to poll from the capability **and** the reader's presence, so
 * callers just `registerTranscriptSync(id, providerId, cliSessionId, cwd,
 * configDir)` and it decides (no-op if neither). It resolves each live
 * session's transcript path ONCE and caches it, then reads the title (head)
 * and/or status (tail) from that one path and mirrors changes into the
 * `.name` / `.status` channels — the same channels Claude's statusLine and
 * hooks push to — so the renderer adopts them without knowing which CLI
 * produced them.
 *
 * Two mechanisms drive the reads:
 *   - a best-effort `fs.watch` on the resolved transcript file, so a change
 *     surfaces in well under a second (debounced to coalesce write bursts);
 *   - a 2s poll over all entries as the correctness backbone — it catches
 *     missed watch events, files whose watch couldn't be established, and
 *     re-resolves the path when the cached file has vanished (e.g. after a
 *     `/clear` re-adoption moves the session to a new file).
 *
 * Poll cost is bounded by a per-entry `(mtime,size)` gate (PA-02): the tick
 * stats the cached transcript and skips BOTH content reads when the tuple
 * matches the last completed read pair, so 200 idle tabs cost 200 statSync
 * calls per tick, not ~1000 open/read/close triples.
 *
 * Caching the resolved path matters: findTranscriptPathSync scans every
 * project dir under the sessions root, so re-resolving it per read — as the
 * old split title/status pollers each did — was O(#projects) per session
 * per tick, twice over for a provider that both self-titles and polls. The
 * path is stable for a session's life, so we resolve lazily and only
 * re-resolve if the cached file has vanished. A resolution that FAILS is
 * the exception to that rule and gets an exponential backoff (see
 * RESOLVE_BACKOFF_*): without one, a session whose transcript never shows
 * up re-scans the whole tree every 2s for the life of the app.
 *
 * Writes happen only on change: each write reaches the renderer as an IPC
 * ending in a persist() plus a full renderLayout().
 */

interface TranscriptSyncEntry {
  providerId: ProviderId;
  cliSessionId: string;
  cwd: string;
  configDir?: string;
  /**
   * Exclusive per-launch session dir (Pi/OMP): the CLI writes this
   * session's transcripts there, so path resolution checks it first.
   */
  sessionDir?: string;
  wantTitle: boolean;
  wantStatus: boolean;
  /**
   * True for a restored-but-not-yet-resumed session: mirror the CLI title only,
   * never resurrect a stale status onto a dead tab. A later resume re-registers
   * without this flag, which replaces the entry (see `isSameSync`).
   */
  titleOnly: boolean;
  /** Resolved transcript path; null until first resolved. */
  transcriptPath: string | null;
  lastTitle: string | null;
  lastStatus: CliSessionStatus | null;
  /** Consecutive failed path resolutions; drives the retry backoff. */
  resolveFailures: number;
  /** Timestamp before which a re-resolution is skipped (backoff window). */
  nextResolveAt: number;
  /** Backoff log is once-per-entry, not once-per-tick. */
  backoffLogged: boolean;
  /** C2M-05: consecutive READ-deferred rounds (resolve failures have their
   * own counter above). A transcript that is permanently unreadable (Codex
   * compaction renames .jsonl to .jsonl.zst under a live tab — every
   * provider reader throws) used to re-open/read/throw every 2 s tick for
   * the tab's lifetime: the (mtime,size) tuple is deliberately not recorded
   * on a deferred round, so nothing gated the retry. Same doubling as
   * RESOLVE_BACKOFF_*; reset by the first clean round. */
  readFailures: number;
  /** Timestamp before which the read block is skipped (C2M-05). */
  nextReadAt: number;
  /**
   * `(mtimeMs,size)` of the transcript as of the last successful read pair.
   * An unchanged tuple on the next tick means the CLI wrote nothing, so both
   * the 8 KiB head (title) and 16 KiB tail (status) reads are skipped (PA-02).
   */
  lastStatMtimeMs: number | null;
  lastStatSize: number | null;
  /** Best-effort watch on `transcriptPath`; null when not established. */
  watcher: fs.FSWatcher | null;
  /** Coalesces a burst of watch events into one re-sync. */
  debounce: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, TranscriptSyncEntry>();
let pollInterval: ReturnType<typeof setInterval> | null = null;

// Coalesce rapid transcript writes (a turn appends many lines) into a single
// re-read shortly after the burst settles.
const DEBOUNCE_MS = 150;

// A transcript that cannot be resolved must not re-scan every project dir
// every 2s forever. Each consecutive failure doubles the wait, capped at
// RESOLVE_BACKOFF_CAP_MS — still periodic, so a transcript that shows up
// late (slow first write, restored profile dir) is picked up eventually.
const RESOLVE_BACKOFF_BASE_MS = 2000;
const RESOLVE_BACKOFF_CAP_MS = 60000;

/**
 * Start mirroring a session's title/status. What to poll is derived from
 * the provider's capabilities (and the presence of the matching reader),
 * so callers just register a session and this decides. Returns true when a
 * sync entry now exists for the session, false when the provider offers
 * neither title nor status polling (a no-op).
 *
 * Re-registering is safe and is expected: the session-id watchers call this
 * again when they hand over a new `cliSessionId` (a `/clear` re-adoption).
 * The same conversation is left untouched; a changed id replaces the entry
 * AFTER closing the incumbent's watch, so the hand-off neither leaks the
 * old `fs.watch` nor re-emits the old title/status.
 *
 * `titleOnly` (used for restored-but-not-resumed sessions) mirrors the CLI
 * title without resurrecting a stale status onto a dead tab; a later resume
 * re-registers without it and replaces the entry.
 */
export function registerTranscriptSync(
  sessionId: string,
  providerId: ProviderId,
  cliSessionId: string,
  cwd: string,
  configDir?: string,
  opts?: { titleOnly?: boolean; sessionDir?: string }
): boolean {
  const provider = getProvider(providerId);
  const titleOnly = opts?.titleOnly === true;
  const sessionDir = opts?.sessionDir;
  const wantTitle = provider.meta.capabilities.selfTitles === true && !!provider.readSessionTitle;
  const wantStatus = !titleOnly && provider.meta.capabilities.polledStatus === true && !!provider.readSessionStatus;
  if (!wantTitle && !wantStatus) return false;
  const prev = entries.get(sessionId);
  if (prev && isSameSync(prev, providerId, cliSessionId, cwd, configDir, titleOnly, sessionDir)) {
    // Same conversation re-registered (e.g. a re-spawn of the same
    // session): the incumbent's cached path, last-written title/status and
    // live watch are all still valid. Replacing it would drop the watch and
    // re-emit an unchanged name as a fresh write.
    ensurePolling();
    return true;
  }
  // A `/clear` re-adoption hands us a new cliSessionId for the same UI
  // session. The incumbent owns an OPEN fs.watch on the old transcript;
  // overwriting the map slot without closing it leaks one OS handle plus a
  // pending debounce timer per /clear, forever.
  if (prev) teardownWatch(prev);
  entries.set(sessionId, {
    providerId,
    cliSessionId,
    cwd,
    configDir,
    sessionDir,
    wantTitle,
    wantStatus,
    titleOnly,
    transcriptPath: null,
    lastTitle: null,
    lastStatus: null,
    resolveFailures: 0,
    nextResolveAt: 0,
    backoffLogged: false,
    readFailures: 0,
    nextReadAt: 0,
    lastStatMtimeMs: null,
    lastStatSize: null,
    watcher: null,
    debounce: null,
  });
  ensurePolling();
  return true;
}

export function unregisterTranscriptSync(sessionId: string): void {
  const e = entries.get(sessionId);
  if (e) teardownWatch(e);
  entries.delete(sessionId);
  if (entries.size === 0 && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/** The entry's resolved transcript path, or null until first resolved. */
export function getSyncedTranscriptPath(sessionId: string): string | null {
  return entries.get(sessionId)?.transcriptPath ?? null;
}

function ensurePolling(): void {
  if (!pollInterval) {
    pollInterval = setInterval(tick, 2000);
  }
}

/** True when an existing entry already mirrors exactly this conversation. */
function isSameSync(
  e: TranscriptSyncEntry,
  providerId: ProviderId,
  cliSessionId: string,
  cwd: string,
  configDir: string | undefined,
  titleOnly: boolean,
  sessionDir: string | undefined
): boolean {
  return (
    e.providerId === providerId &&
    e.cliSessionId === cliSessionId &&
    e.cwd === cwd &&
    e.configDir === configDir &&
    e.sessionDir === sessionDir &&
    e.titleOnly === titleOnly
  );
}

/** Close a session's watcher and cancel any pending debounced re-sync. */
function teardownWatch(e: TranscriptSyncEntry): void {
  if (e.debounce) {
    clearTimeout(e.debounce);
    e.debounce = null;
  }
  if (e.watcher) {
    try { e.watcher.close(); } catch { /* already closed */ }
    e.watcher = null;
  }
}

/**
 * (Re)establish the best-effort watch on the entry's resolved path. Called
 * whenever the path is newly resolved or has moved (a `/clear` re-adoption).
 * A watch failure is non-fatal — the 2s poll still covers this entry.
 */
function rewatch(sessionId: string, e: TranscriptSyncEntry): void {
  if (e.watcher) {
    try { e.watcher.close(); } catch { /* already closed */ }
    e.watcher = null;
  }
  if (!e.transcriptPath) return;
  try {
    const watcher = fs.watch(e.transcriptPath, () => {
      // C3R-03: a watch event is positive liveness evidence — the file
      // exists, is written, and the watch works. Lift the C2M-05 read-backoff
      // window so the gate only paces pure-tick retries.
      e.nextReadAt = 0;
      e.readFailures = 0;
      scheduleSync(sessionId, e);
    });
    watcher.on('error', () => {
      // The file vanished / watch broke — drop it; the poll re-resolves.
      try { watcher.close(); } catch { /* already closed */ }
      if (e.watcher === watcher) e.watcher = null;
    });
    e.watcher = watcher;
  } catch {
    e.watcher = null;
  }
}

/**
 * Record a failed transcript-path resolution and schedule the next attempt:
 * the wait doubles per consecutive failure up to RESOLVE_BACKOFF_CAP_MS.
 * Logs once per entry when the cap is hit, so a permanently unresolvable
 * session is visible without spamming the console every tick.
 */
function noteResolveFailure(sessionId: string, e: TranscriptSyncEntry): void {
  e.resolveFailures += 1;
  const delay = Math.min(
    RESOLVE_BACKOFF_BASE_MS * 2 ** (e.resolveFailures - 1),
    RESOLVE_BACKOFF_CAP_MS
  );
  e.nextResolveAt = Date.now() + delay;
  if (delay >= RESOLVE_BACKOFF_CAP_MS && !e.backoffLogged) {
    e.backoffLogged = true;
    console.warn(
      `[session-transcript-sync] no transcript found for session ${sessionId} ` +
      `(provider ${e.providerId}, cli id ${e.cliSessionId}) after ` +
      `${e.resolveFailures} attempts; retrying every ${RESOLVE_BACKOFF_CAP_MS / 1000}s`
    );
  }
}

/** Coalesce a burst of watch events into one re-sync shortly after settling. */
function scheduleSync(sessionId: string, e: TranscriptSyncEntry): void {
  if (e.debounce) return;
  e.debounce = setTimeout(() => {
    e.debounce = null;
    // The entry may have been unregistered or replaced while the timer ran.
    if (entries.get(sessionId) === e) syncEntry(sessionId, e);
  }, DEBOUNCE_MS);
}

/** Resolve the path (cached) and mirror title/status for one session. */
function syncEntry(sessionId: string, e: TranscriptSyncEntry): void {
  const provider = getProvider(e.providerId);
  // Resolve the transcript path once and cache it. The per-tick probe is a
  // single statSync (PA-02): it replaces the old `existsSync` at the same
  // cost, and its `(mtimeMs,size)` tuple gates BOTH reads below, so an
  // untouched transcript costs one syscall per tick instead of the 5 (Pi) /
  // 8 (OMP) open+read+close fd ops it used to. A failed stat means the file
  // is gone (transcript recreated, or a `/clear` re-adoption moved the
  // session to a new file) — re-resolve, which beats re-scanning every
  // project dir every tick. A failed resolution backs off instead, so an
  // unresolvable session stops hammering the filesystem.
  let stat = e.transcriptPath === null ? null : statOrNull(e.transcriptPath);
  if (stat === null) {
    if (e.nextResolveAt > Date.now()) return;
    try {
      e.transcriptPath = provider.getTranscriptPath?.(e.cliSessionId, e.cwd, e.configDir, e.sessionDir) ?? null;
    } catch {
      e.transcriptPath = null;
    }
    if (e.transcriptPath === null) {
      noteResolveFailure(sessionId, e);
      return;
    }
    e.resolveFailures = 0;
    e.nextResolveAt = 0;
    // The path is new or moved — point the watch at the current file.
    rewatch(sessionId, e);
    // The tuple of a fresh path is unknown; stat it once so this tick's reads
    // are recorded against a tuple the later ticks can compare.
    stat = statOrNull(e.transcriptPath);
    if (stat === null) return; // vanished between resolve and stat — next tick
  }
  if (!e.transcriptPath) return;
  // C2M-05: a failed read round arms the same doubling backoff the
  // resolution path uses. The stat above is the only per-tick cost inside
  // the window; a file that becomes readable AND changes re-arms the
  // (mtime,size) gate, so the clean path pays nothing.
  if (e.nextReadAt > Date.now()) return;

  // Unchanged `(mtimeMs,size)` means the CLI appended nothing since the last
  // completed read pair: the 8 KiB title head and the 16 KiB status tail
  // would return exactly what is already mirrored. `fs.watch` drives a
  // re-sync the moment a write lands, so the gate costs no latency.
  const unchanged = e.lastStatMtimeMs === stat.mtimeMs && e.lastStatSize === stat.size;
  // The tuple is recorded only once every applicable read ran cleanly: a
  // mid-write read error, or a failed `.name`/`.status` write (lastTitle /
  // lastStatus not advanced), leaves the entry due so the next tick re-reads.
  let deferred = false;

  if (!unchanged) {
    if (e.wantTitle && provider.readSessionTitle) {
      let title: string | null = null;
      try {
        title = provider.readSessionTitle(e.transcriptPath) ?? null;
      } catch {
        title = null; // transcript mid-write / permissions — retry next tick
        deferred = true;
      }
      if (title && title !== e.lastTitle) {
        try {
          writeCliSessionName(sessionId, title, e.cliSessionId);
          e.lastTitle = title;
        } catch {
          // A failed write is retried on the next tick (lastTitle not advanced).
          deferred = true;
        }
      }
    }

    if (e.wantStatus && provider.readSessionStatus) {
      let status: CliSessionStatus | null = null;
      try {
        status = provider.readSessionStatus(e.transcriptPath) ?? null;
      } catch {
        status = null;
        deferred = true;
      }
      if (status && status !== e.lastStatus) {
        try {
          writeStatus(sessionId, status);
          e.lastStatus = status;
        } catch {
          // A failed write is retried on the next tick (lastStatus not advanced).
          deferred = true;
        }
      }
    }
  }

  if (!deferred) {
    e.lastStatMtimeMs = stat.mtimeMs;
    e.lastStatSize = stat.size;
    e.readFailures = 0;
    e.nextReadAt = 0;
  } else if (e.nextReadAt <= Date.now()) {
    e.readFailures += 1;
    e.nextReadAt = Date.now() + Math.min(
      RESOLVE_BACKOFF_BASE_MS * 2 ** (e.readFailures - 1),
      RESOLVE_BACKOFF_CAP_MS
    );
  }
}

/** `statSync` without the throw: null means the path is not readable right now. */
function statOrNull(p: string): { mtimeMs: number; size: number } | null {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** One pass per 2s; an idle entry costs exactly one statSync (PA-02). */
function tick(): void {
  for (const [sessionId, e] of entries) {
    syncEntry(sessionId, e);
  }
}

/** @internal Test-only: stop the poller and drop all entries. */
export function _resetTranscriptSyncForTesting(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  for (const e of entries.values()) teardownWatch(e);
  entries.clear();
}
