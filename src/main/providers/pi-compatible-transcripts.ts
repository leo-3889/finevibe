import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptDescriptor } from './provider';
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

function firstLineOf(text: string): string {
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/** Read only the first line of a file (bounded, never the whole transcript). */
export function readFirstLineSync(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return firstLineOf(buf.toString('utf-8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Async twin of readFirstLineSync. Per-call buffer: safe under Promise.all. */
export async function readFirstLineAsync(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return firstLineOf(buf.toString('utf-8', 0, bytesRead));
  } catch {
    return null;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* already closed */ }
    }
  }
}

/** First line of a Pi/OMP transcript: {"type":"session","version":3,"id","timestamp","cwd"}. */
export interface CompatibleSessionHeader {
  type: string;
  id: string;
  cwd?: string;
}

export function parseSessionHeader(firstLine: string | null): CompatibleSessionHeader | null {
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine);
    if (entry?.type === 'session' && typeof entry.id === 'string') return entry;
    return null;
  } catch {
    return null;
  }
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
        const header = parseSessionHeader(readFirstLineSync(full));
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
        const header = parseSessionHeader(await readFirstLineAsync(transcriptPath));
        return header
          ? { cliSessionId: header.id, transcriptPath, projectCwd: header.cwd ?? '', profileId }
          : null;
      })
    );
    for (const d of descriptors) if (d) out.push(d);
  }
  return out;
}

/**
 * Index a Pi/OMP transcript for global search: user-typed text only,
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
