import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Shared on-disk contract for Pi transcripts, used by both the provider
 * (global search / resume) and the session watcher (id discovery):
 *   <agentDir>/sessions/<cwd-as-dashes>/<ISO-timestamp>_<uuid>.jsonl
 * whose first line is a session header carrying id and cwd.
 */

/**
 * Pi transcript headers are short (id, timestamp, cwd). Header readers pull
 * only this many bytes — a first line longer than this (effectively
 * impossible) simply fails to parse and is skipped.
 */
export const HEADER_READ_BYTES = 8 * 1024;

/** Pi's agent dir: ~/.pi/agent by default, relocated via PI_CODING_AGENT_DIR (profiles). */
export function piAgentDir(configDir?: string): string {
  return configDir ?? path.join(os.homedir(), '.pi', 'agent');
}

export function piSessionsRoot(configDir?: string): string {
  return path.join(piAgentDir(configDir), 'sessions');
}

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

/** First line of a Pi transcript: {"type":"session","version":3,"id","timestamp","cwd"}. */
export interface PiSessionHeader {
  type: string;
  id: string;
  cwd?: string;
}

export function parseSessionHeader(firstLine: string | null): PiSessionHeader | null {
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine);
    if (entry?.type === 'session' && typeof entry.id === 'string') return entry;
    return null;
  } catch {
    return null;
  }
}
