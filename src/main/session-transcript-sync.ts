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
 * Caching the resolved path matters: findTranscriptPathSync scans every
 * project dir under the sessions root, so re-resolving it per read — as the
 * old split title/status pollers each did — was O(#projects) per session
 * per tick, twice over for a provider that both self-titles and polls. The
 * path is stable for a session's life, so we resolve lazily and only
 * re-resolve if the cached file has vanished.
 *
 * Writes happen only on change: each write reaches the renderer as an IPC
 * ending in a persist() plus a full renderLayout().
 */

interface TranscriptSyncEntry {
  providerId: ProviderId;
  cliSessionId: string;
  cwd: string;
  configDir?: string;
  wantTitle: boolean;
  wantStatus: boolean;
  /** Resolved transcript path; null until first resolved. */
  transcriptPath: string | null;
  lastTitle: string | null;
  lastStatus: CliSessionStatus | null;
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

/**
 * Start mirroring a session's title/status. What to poll is derived from
 * the provider's capabilities (and the presence of the matching reader),
 * so callers just register a session and this decides. A no-op when the
 * provider offers neither.
 */
export function registerTranscriptSync(
  sessionId: string,
  providerId: ProviderId,
  cliSessionId: string,
  cwd: string,
  configDir?: string
): void {
  const provider = getProvider(providerId);
  const wantTitle = provider.meta.capabilities.selfTitles === true && !!provider.readSessionTitle;
  const wantStatus = provider.meta.capabilities.polledStatus === true && !!provider.readSessionStatus;
  if (!wantTitle && !wantStatus) return;
  entries.set(sessionId, {
    providerId,
    cliSessionId,
    cwd,
    configDir,
    wantTitle,
    wantStatus,
    transcriptPath: null,
    lastTitle: null,
    lastStatus: null,
    watcher: null,
    debounce: null,
  });
  if (!pollInterval) {
    pollInterval = setInterval(tick, 2000);
  }
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
    const watcher = fs.watch(e.transcriptPath, () => scheduleSync(sessionId, e));
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
  // Resolve the transcript path once and cache it. Re-resolve only when the
  // cached path is gone (transcript recreated) — a cheap existsSync beats
  // re-scanning every project dir every tick.
  if (e.transcriptPath === null || !fs.existsSync(e.transcriptPath)) {
    try {
      e.transcriptPath = provider.getTranscriptPath?.(e.cliSessionId, e.cwd, e.configDir) ?? null;
    } catch {
      e.transcriptPath = null;
    }
    // The path is new or moved — point the watch at the current file.
    rewatch(sessionId, e);
  }
  if (!e.transcriptPath) return;

  if (e.wantTitle && provider.readSessionTitle) {
    let title: string | null = null;
    try {
      title = provider.readSessionTitle(e.transcriptPath) ?? null;
    } catch {
      title = null; // transcript mid-write / permissions — retry next tick
    }
    if (title && title !== e.lastTitle) {
      try {
        writeCliSessionName(sessionId, title, e.cliSessionId);
        e.lastTitle = title;
      } catch {
        // A failed write is retried on the next tick (lastTitle not advanced).
      }
    }
  }

  if (e.wantStatus && provider.readSessionStatus) {
    let status: CliSessionStatus | null = null;
    try {
      status = provider.readSessionStatus(e.transcriptPath) ?? null;
    } catch {
      status = null;
    }
    if (status && status !== e.lastStatus) {
      try {
        writeStatus(sessionId, status);
        e.lastStatus = status;
      } catch {
        // A failed write is retried on the next tick (lastStatus not advanced).
      }
    }
  }
}

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
