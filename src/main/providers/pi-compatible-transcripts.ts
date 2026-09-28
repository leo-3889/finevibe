import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptDescriptor } from './provider';
import type { CliSessionStatus } from '../../shared/types';
import { MAX_INDEX_CHARS_PER_SESSION, TRANSCRIPT_TEXT_SEPARATOR } from './transcript-utils';

/**
 * Shared on-disk contract for Pi-compatible transcripts (Pi and OMP speak
 * the same format, including PI_CODING_AGENT_DIR as the agent-dir override),
 * used by both the providers (global search / resume) and the session
 * watchers (id discovery):
 *   <agentDir>/sessions/<cwd-as-dashes>/<ISO-timestamp>_<uuid>.jsonl
 * whose first line is a session header carrying id and cwd.
 */

/**
 * Transcript headers are short (id, timestamp, cwd). Header readers pull
 * only this many bytes — a first line longer than this (effectively
 * impossible) simply fails to parse and is skipped.
 */
export const HEADER_READ_BYTES = 8 * 1024;

/** Read the head of a file (bounded, never the whole transcript). */
export function readHeaderWindowSync(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Async twin of readHeaderWindowSync. Per-call buffer: safe under Promise.all. */
export async function readHeaderWindowAsync(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* already closed */ }
    }
  }
}

/**
 * Status is derived from the LAST few entries of a transcript, which live at
 * the end of the file. Pull only this many trailing bytes — a single entry
 * longer than this simply fails to parse and is skipped.
 */
export const TAIL_READ_BYTES = 16 * 1024;

/**
 * Fallback window for status derivation when the last entry is larger than
 * TAIL_READ_BYTES (a big tool output / message fills the whole window, so
 * no complete line is present to parse). Bounded so a pathological huge
 * transcript can't make the poller read unboundedly.
 */
export const MAX_STATUS_TAIL_BYTES = 1024 * 1024;

/** Read the tail of a file (bounded, never the whole transcript). */
export function readTranscriptTailSync(filePath: string, bytes = TAIL_READ_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const readLen = Math.min(bytes, size);
    const start = size - readLen;
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Derive a session's current status from the last entries of its transcript.
 *
 * Pi-compatible CLIs append one JSON line per event. The last *meaningful*
 * entry (a `message` or a `custom` lifecycle marker) tells us where the
 * conversation is, mirroring the hook convention the other tools use:
 *   - mid-turn (assistant `toolUse`, or a `user` / `toolResult` /
 *     `tool_execution_start` marker) → `working`
 *   - clean finish (assistant `stop`) → `completed`
 *   - failed turn (assistant `error`) → `waiting`
 * A trailing `session_exit` maps to null: the session is removed on PTY exit,
 * so there is nothing to report. Non-event lines (title, model_change, …) are
 * skipped.
 */
export function transcriptStatusFromTail(tail: string | null): CliSessionStatus | null {
  if (!tail) return null;
  const lines = tail.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, any>;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      // A mid-write tail line (the writer is mid-flush) — ignore and keep
      // scanning backwards for the last complete line.
      continue;
    }
    const status = statusFromEntry(entry);
    if (status) return status;
  }
  return null;
}

function statusFromEntry(entry: Record<string, any>): CliSessionStatus | null {
  if (entry.type === 'custom') {
    if (entry.customType === 'session_exit') return null; // session is removed on PTY exit; nothing to report
    if (entry.customType === 'tool_execution_start') return 'working';
    return null;
  }
  if (entry.type === 'message') {
    const role = entry.message?.role;
    if (role === 'assistant') {
      const stop = entry.message?.stopReason;
      // Mirrors the hook convention: a clean finish (stop) is `completed`, a
      // failed turn (error) is `waiting` — same as Claude's Stop/StopFailure.
      // Anything else (toolUse / mid-turn) is still `working`.
      if (stop === 'error') return 'waiting';
      return stop === 'stop' ? 'completed' : 'working';
    }
    if (role === 'user' || role === 'toolResult') return 'working';
    return null;
  }
  return null;
}

/**
 * Convenience: read a transcript's tail and derive its status in one call.
 * If the default 16KB window yields no complete meaningful entry — the last
 * entry is larger than the window — retry with a larger bounded window so a
 * big final entry (large tool output / message) doesn't leave the poller on
 * a stale status.
 */
export function readTranscriptStatusSync(filePath: string): CliSessionStatus | null {
  const status = transcriptStatusFromTail(readTranscriptTailSync(filePath));
  if (status !== null) return status;
  return transcriptStatusFromTail(readTranscriptTailSync(filePath, MAX_STATUS_TAIL_BYTES));
}

/**
 * OMP (18.4+) prepends a `{"type":"title",...}` line before the session
 * header and rewrites it in place when the title changes, so the header is
 * not always line 1. Parse the JSON entries of the first few lines.
 */
function headEntries(window: string | null): Array<Record<string, any>> {
  if (!window) return [];
  const out: Array<Record<string, any>> = [];
  const lines = window.split('\n');
  for (let i = 0; i < lines.length && out.length < 4; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object') out.push(entry);
    } catch { /* not JSON */ }
  }
  return out;
}

/** Session header from a transcript head: {"type":"session","version":3,"id","timestamp","cwd"}. */
export function sessionHeaderFromWindow(window: string | null): CompatibleSessionHeader | null {
  for (const entry of headEntries(window)) {
    if (entry.type === 'session' && typeof entry.id === 'string') return entry as CompatibleSessionHeader;
  }
  return null;
}

export function readSessionHeaderSync(filePath: string): CompatibleSessionHeader | null {
  return sessionHeaderFromWindow(readHeaderWindowSync(filePath));
}

export async function readSessionHeaderAsync(filePath: string): Promise<CompatibleSessionHeader | null> {
  return sessionHeaderFromWindow(await readHeaderWindowAsync(filePath));
}

/**
 * The CLI's own session title from a transcript head: the `type:"title"`
 * entry (OMP) wins, falling back to the header's `title` field (OMP mirrors
 * it there). Null when the session has no title (e.g. every Pi transcript).
 */
export function transcriptTitleFromWindow(window: string | null): string | null {
  let headerTitle: string | null = null;
  for (const entry of headEntries(window)) {
    if (typeof entry.title !== 'string' || !entry.title.trim()) continue;
    if (entry.type === 'title') return entry.title.trim();
    if (entry.type === 'session' && headerTitle === null) headerTitle = entry.title.trim();
  }
  return headerTitle;
}

export function readTranscriptTitleSync(filePath: string): string | null {
  return transcriptTitleFromWindow(readHeaderWindowSync(filePath));
}

/**
 * Session header entry: {"type":"session","version":3,"id","timestamp","cwd"}.
 * OMP also mirrors the current title into `title`/`titleSource`.
 */
export interface CompatibleSessionHeader {
  type: string;
  id: string;
  cwd?: string;
  title?: string;
}

/**
 * Parameterized agent-dir / sessions-root helpers. The default agent dir is
 * fixed at construction (e.g. ~/.pi/agent vs ~/.omp/agent); a configDir
 * argument (profiles) relocates the whole tree.
 */
export function createCompatibleTranscriptModule(defaultAgentDir: string): {
  agentDir: (configDir?: string) => string;
  sessionsRoot: (configDir?: string) => string;
} {
  const agentDir = (configDir?: string): string => configDir ?? defaultAgentDir;
  const sessionsRoot = (configDir?: string): string => path.join(agentDir(configDir), 'sessions');
  return { agentDir, sessionsRoot };
}

// --- Shared provider transcript helpers (parameterized by sessions root) ---

/**
 * Find one transcript by cli session id: match the id in the filename
 * first, then read only the header line to prefer an exact cwd match.
 */
export function findTranscriptPathSync(
  sessionsRootOf: (configDir?: string) => string,
  cliSessionId: string,
  projectPath: string,
  configDir?: string
): string | null {
  try {
    const sessionsRoot = sessionsRootOf(configDir);
    if (!fs.existsSync(sessionsRoot)) return null;

    // Filenames are <ISO-timestamp>_<uuid>.jsonl — match the id in the name
    // first, then read only the header line to prefer an exact cwd match.
    const suffix = `_${cliSessionId}.jsonl`;
    let fallback: string | null = null;
    for (const dir of fs.readdirSync(sessionsRoot)) {
      const dirPath = path.join(sessionsRoot, dir);
      let files: string[];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(suffix)) continue;
        const full = path.join(dirPath, f);
        const header = readSessionHeaderSync(full);
        if (!header || header.id !== cliSessionId) continue;
        if (header.cwd === projectPath) return full;
        fallback ??= full;
      }
    }
    return fallback;
  } catch {
    return null;
  }
}

/** Emit a descriptor per .jsonl in a sessions root, from the session header. */
export async function scanTranscriptSessionsRoot(
  sessionsRoot: string,
  profileId: string | undefined
): Promise<TranscriptDescriptor[]> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(sessionsRoot);
  } catch {
    return [];
  }
  const out: TranscriptDescriptor[] = [];
  for (const dir of dirs) {
    const dirPath = path.join(sessionsRoot, dir);
    let files: string[];
    try { files = await fs.promises.readdir(dirPath); } catch { continue; }
    // Header reads are independent — read them concurrently.
    const descriptors = await Promise.all(
      files.filter((f) => f.endsWith('.jsonl')).map(async (f) => {
        const transcriptPath = path.join(dirPath, f);
        const header = await readSessionHeaderAsync(transcriptPath);
        return header
          ? { cliSessionId: header.id, transcriptPath, projectCwd: header.cwd ?? '', profileId }
          : null;
      })
    );
    for (const d of descriptors) if (d) out.push(d);
  }
  return out;
}

/** Index a Pi/OMP transcript for global search: user-typed text only,
 * capped at the per-session char budget.
 */
export async function indexCompatibleTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, 'utf-8');
  } catch {
    return { text: '', cwd: '' };
  }
  let cwd = '';
  const texts: string[] = [];
  let totalChars = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; cwd?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session' && typeof entry.cwd === 'string') {
      cwd = entry.cwd;
      continue;
    }
    if (entry.type !== 'message') continue;
    if (totalChars >= MAX_INDEX_CHARS_PER_SESSION) break;
    if (entry.message?.role !== 'user') continue;
    let text = '';
    const c = entry.message.content;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string') {
          text += (block as { text: string }).text + '\n';
        }
      }
    }
    if (text) {
      texts.push(text.trim());
      totalChars += text.length;
    }
  }
  return { text: texts.join(TRANSCRIPT_TEXT_SEPARATOR), cwd };
}
