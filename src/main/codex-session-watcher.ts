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
/** Compressed rollouts are decompressed whole for the meta; skip huge ones. */
const MAX_COMPRESSED_META_FILE_BYTES = 8 * 1024 * 1024;

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

function readdirSortedDesc(dir: string): string[] {
  try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
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

function assign(uiSessionId: string, codexSessionId: string): void {
  rememberAssignedId(codexSessionId);
  pendingSessions.delete(uiSessionId);
  writeCliSessionId(uiSessionId, codexSessionId);
}

/** Scan rollout files newer than the oldest pending registration, per-cwd FIFO. */
function scanRollouts(): void {
  if (pendingSessions.size === 0) return;
  let oldestAdded = Infinity;
  for (const p of pendingSessions.values()) oldestAdded = Math.min(oldestAdded, p.addedAt);
  const minMtime = oldestAdded - MTIME_SKEW_MS;

  for (const year of readdirSortedDesc(SESSIONS_ROOT)) {
    const yearDir = path.join(SESSIONS_ROOT, year);
    for (const month of readdirSortedDesc(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of readdirSortedDesc(monthDir)) {
        const dayDir = path.join(monthDir, day);
        let dayFiles: string[];
        try {
          // Day directory mtime: a day with no new rollouts can't match.
          if (fs.statSync(dayDir).mtimeMs < minMtime) continue;
          dayFiles = readdirSortedDesc(dayDir);
        } catch {
          continue;
        }
        for (const file of dayFiles) {
          if (!file.startsWith('rollout-')) continue;
          if (!file.endsWith('.jsonl') && !file.endsWith('.jsonl.zst')) continue;
          const filePath = path.join(dayDir, file);
          let mtimeMs: number;
          try {
            mtimeMs = fs.statSync(filePath).mtimeMs;
          } catch {
            continue;
          }
          if (mtimeMs < minMtime) continue;
          const meta = readSessionMeta(filePath);
          const codexId = meta?.id ?? idFromFilename(file);
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
            assign(match, codexId);
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
  assignedCodexIds.clear();
}
