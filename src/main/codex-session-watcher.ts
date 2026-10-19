import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import type { BrowserWindow } from 'electron';
import { writeCliSessionId } from './hook-status';

/**
 * Codex CLI has no hook system that reliably reports session IDs back to the
 * host app. When hooks are incomplete, we attribute new rollout files
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst]`) to the
 * Vibeyard tabs that launched Codex.
 *
 * Attribution is per-cwd FIFO: a rollout's `session_meta` line carries the
 * cwd Codex ran in, and only tabs registered for that cwd are eligible.
 * Before this, attribution was a global FIFO over `~/.codex/history.jsonl`
 * — a shared, global file — so any external `codex` run (terminal, CI)
 * hijacked the oldest pending tab, giving it a foreign transcript and a
 * wrong resume target.
 */

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

interface PendingCodexSession {
  /** Normalized cwd of the launched session; only matching rollouts assign. */
  cwd: string;
  addedAt: number;
}

const pendingSessions = new Map<string, PendingCodexSession>();
const assignedCodexIds = new Set<string>();
// Bounded: the set exists to dedupe ids already handed out; evict oldest
// (Sets preserve insertion order) so it can't grow for the app's lifetime.
const MAX_ASSIGNED_IDS = 1000;

function rememberAssignedId(id: string): void {
  if (assignedCodexIds.size >= MAX_ASSIGNED_IDS) {
    const oldest = assignedCodexIds.values().next().value;
    if (oldest !== undefined) assignedCodexIds.delete(oldest);
  }
  assignedCodexIds.add(id);
}

/** Clock-skew tolerance: file mtimes vs Date.now() across FS boundaries. */
const MTIME_SKEW_MS = 60_000;
/** Rollout meta is the first line; 64 KB covers any realistic session_meta. */
const META_READ_BYTES = 64 * 1024;
/** Compressed rollouts are decompressed whole for the meta; skip huge ones.
 * The 8 MiB gate bounds the compressed read; the decompressed peak is bounded
 * in practice by `metaCache` below, which parses each file once per change. */
const MAX_COMPRESSED_META_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Parsed `session_meta` per rollout, keyed by path and invalidated by
 * (mtime, size). The first line never changes once written, so without this
 * cache every scan re-read - and for `.jsonl.zst` fully decompressed,
 * allocating roughly 10x the compressed size - every rollout in today's
 * directory, up to twice a second, for the whole life of a pending tab.
 */
const MAX_META_CACHE_ENTRIES = 256;
const metaCache = new Map<string, { mtimeMs: number; size: number; meta: { id?: string; cwd?: string } | null }>();

function readCachedMeta(filePath: string, mtimeMs: number, size: number): { id?: string; cwd?: string } | null {
  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.meta;
  const meta = readSessionMeta(filePath);
  if (metaCache.size >= MAX_META_CACHE_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(filePath, { mtimeMs, size, meta });
  return meta;
}

function normCwd(p: string): string {
  let s = path.resolve(p);
  if (process.platform === 'win32') s = s.toLowerCase();
  while (s.length > 1 && (s.endsWith(path.sep) || s.endsWith('/'))) s = s.slice(0, -1);
  return s;
}

/** Codex names rollouts `rollout-<YYYY-MM-DDTHH-MM-SS>-<id>.jsonl[.zst]`;
 * the id tail lets us attribute a rollout whose meta line hasn't landed. */
function idFromFilename(file: string): string | undefined {
  const base = file.endsWith('.zst') ? file.slice(0, -'.zst'.length) : file;
  if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return;
  const rest = base.slice('rollout-'.length, -'.jsonl'.length);
  const tsLen = '2026-01-01T00-00-00'.length; // fixed-width timestamp segment
  if (rest.length <= tsLen + 1 || rest[tsLen] !== '-') return;
  return rest.slice(tsLen + 1);
}

/** Newest-first: the historical tree is walked oldest-recent-last. */
function readdirSortedDesc(dir: string): string[] {
  try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
}

/** Oldest-first: rollouts inside one day pair with pending tabs FIFO. */
function readdirSortedAsc(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/**
 * Parse a rollout's first line (`session_meta`). Returns the CLI session id
 * and cwd, or null when the file is unreadable/not yet a valid rollout
 * (Codex creates the file before the meta line lands).
 */
function readSessionMeta(filePath: string): { id?: string; cwd?: string } | null {
  try {
    let head: string;
    if (filePath.endsWith('.zst')) {
      const size = fs.statSync(filePath).size;
      if (size > MAX_COMPRESSED_META_FILE_BYTES) return null;
      // A rollout being appended to can end mid-frame; decode what we can.
      const raw = fs.readFileSync(filePath);
      let text: Buffer;
      try {
        text = zlib.zstdDecompressSync(raw);
      } catch {
        text = Buffer.alloc(0);
      }
      head = text.subarray(0, META_READ_BYTES).toString('utf-8');
    } else {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(META_READ_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, n).toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    }
    const firstLine = head.split('\n', 1)[0];
    if (!firstLine.trim()) return null;
    const entry = JSON.parse(firstLine);
    if (entry.type !== 'session_meta' || !entry.payload) return null;
    return {
      id: typeof entry.payload.id === 'string' ? entry.payload.id : undefined,
      cwd: typeof entry.payload.cwd === 'string' ? entry.payload.cwd : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Publish an assignment. Returns false when the id could not be written, in
 * which case NOTHING is mutated: the tab stays pending and the id stays
 * unclaimed, so the next scan retries.
 *
 * The write must never escape: this runs inside the 2 s poll interval and the
 * watch-debounce timer, and `src/main` has no `uncaughtException` handler, so
 * an EMFILE/ENOSPC/EACCES here would kill the main process and every live PTY
 * in every provider with it. Same rule as the Pi/OMP watcher's `adopt()`.
 */
function assign(uiSessionId: string, codexSessionId: string): boolean {
  try {
    writeCliSessionId(uiSessionId, codexSessionId);
  } catch {
    // Disk full / permissions — keep prior state, retry on the next scan.
    return false;
  }
  rememberAssignedId(codexSessionId);
  pendingSessions.delete(uiSessionId);
  return true;
}

/** Pad a `YYYY/MM/DD` path segment so names compare lexicographically. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Scan rollout files newer than the oldest pending registration, per-cwd FIFO. */
function scanRollouts(): void {
  if (pendingSessions.size === 0) return;
  let oldestAdded = Infinity;
  for (const p of pendingSessions.values()) oldestAdded = Math.min(oldestAdded, p.addedAt);
  const minMtime = oldestAdded - MTIME_SKEW_MS;

  // The tree is zero-padded `YYYY/MM/DD` and the walk is newest-first, so the
  // registration date prunes it by NAME: a directory sorting below the oldest
  // registration can only hold older rollouts. Gating on names - instead of
  // stat'ing every day directory the user ever created - keeps a scan at
  // O(recent days) no matter how much Codex history exists.
  const minDate = new Date(minMtime);
  const minYear = String(minDate.getFullYear());
  const minMonth = pad2(minDate.getMonth() + 1);
  const minDay = pad2(minDate.getDate());

  for (const year of readdirSortedDesc(SESSIONS_ROOT)) {
    if (year < minYear) break;
    const yearDir = path.join(SESSIONS_ROOT, year);
    const atMinYear = year === minYear;
    for (const month of readdirSortedDesc(yearDir)) {
      if (atMinYear && month < minMonth) break;
      const monthDir = path.join(yearDir, month);
      const atMinMonth = atMinYear && month === minMonth;
      for (const day of readdirSortedDesc(monthDir)) {
        if (atMinMonth && day < minDay) break;
        const dayDir = path.join(monthDir, day);
        let dayFiles: string[];
        try {
          // Day directory mtime: a day with no new rollouts can't match.
          if (fs.statSync(dayDir).mtimeMs < minMtime) continue;
          // Oldest rollout first. Pending tabs are matched in registration
          // order, so descending files paired the OLDEST tab with the NEWEST
          // rollout: two Codex tabs in one repo (both rollouts created within
          // one scan window) swapped transcripts, titles and resume targets.
          dayFiles = readdirSortedAsc(dayDir);
        } catch {
          continue;
        }
        for (const file of dayFiles) {
          if (!file.startsWith('rollout-')) continue;
          if (!file.endsWith('.jsonl') && !file.endsWith('.jsonl.zst')) continue;
          // The id is in the FILENAME. Deduping on it before any I/O is what
          // keeps an already-assigned rollout from being re-read - and, for
          // `.zst`, fully decompressed - on every scan.
          const tailId = idFromFilename(file);
          if (tailId && assignedCodexIds.has(tailId)) continue;
          const filePath = path.join(dayDir, file);
          let mtimeMs: number;
          let size: number;
          try {
            const st = fs.statSync(filePath);
            mtimeMs = st.mtimeMs;
            size = st.size;
          } catch {
            continue;
          }
          if (mtimeMs < minMtime) continue;
          const meta = readCachedMeta(filePath, mtimeMs, size);
          const codexId = meta?.id ?? tailId;
          if (!codexId || assignedCodexIds.has(codexId)) continue;

          // Oldest pending whose cwd matches the rollout. Unmatched rollouts
          // (external runs, other cwds) are skipped and revisited: their id
          // stays unassigned so a later registration in that cwd can match.
          let match: string | null = null;
          if (meta?.cwd) {
            const rolloutCwd = normCwd(meta.cwd);
            for (const [uiId, p] of pendingSessions) {
              if (p.cwd === rolloutCwd) { match = uiId; break; }
            }
          } else if (pendingSessions.size === 1) {
            // Meta unreadable (file mid-creation, exotic format): with exactly
            // one pending tab the rollout is unambiguous. With several, stay
            // hands-off — guessing is what hijacked tabs before.
            match = pendingSessions.keys().next().value ?? null;
          }
          if (match) {
            // A failed id write leaves the tab pending; keep scanning so a
            // later registration in this cwd can still match this rollout.
            if (!assign(match, codexId)) continue;
            if (pendingSessions.size === 0) return;
          }
        }
      }
    }
  }
}

export function registerPendingCodexSession(sessionId: string, cwd: string): void {
  pendingSessions.set(sessionId, { cwd: normCwd(cwd), addedAt: Date.now() });
}

export function unregisterCodexSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
}

let watcher: fs.FSWatcher | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;

export function startCodexSessionWatcher(_win: BrowserWindow): void {
  if (watcher || pollInterval) return;

  try {
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
    watcher = fs.watch(SESSIONS_ROOT, { recursive: true }, () => {
      // Codex appends in bursts; coalesce watch events into one scan.
      if (scanTimer !== null) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scanRollouts();
      }, 500);
    });
  } catch {
    // Directory watch unavailable; fall through to polling only.
  }

  // Polling fallback — fs.watch can miss events on some systems.
  pollInterval = setInterval(() => {
    if (pendingSessions.size > 0) scanRollouts();
  }, 2000);
}

export function stopCodexSessionWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (scanTimer !== null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  pendingSessions.clear();
  metaCache.clear();
  assignedCodexIds.clear();
}
