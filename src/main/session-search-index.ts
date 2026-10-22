import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

// Derived local data, not conversation history. Bump the directory version when
// extraction semantics change. One capped record per source, never loaded as a corpus.
// v3 (P2-69): the Codex cwd extraction fix (f1dc98b) changed the semantics of the
// persisted `cwd` below — the ONLY project path a Codex search result carries
// (discovery emits no projectCwd, so session-deep-search falls back to it). Rollouts
// are immutable, so a pre-fix record's (mtime,size,ctime) tuple never invalidates it
// and the stale cwd survived the producer fix forever: the palette find-or-created
// the project at the wrong path and spawned Codex in the wrong repo. This directory
// version IS the persisted-cache schema field (session-transcript-sync's resolved-path
// cache is in-memory only); bumping it in lockstep makes every pre-fix record a read
// miss that rebuilds under v3. Records under search-index-v2 are now unreachable.
interface Version { mtime: number; size?: number; ctime?: number }
interface RecordData extends Version { text: string; cwd: string }
const MAX_TEXT = 50 * 1024;
const MAX_RECORD_BYTES = MAX_TEXT * 6 + 32 * 1024;
function directory(provider: string): string {
  if (!/^[a-z-]+$/.test(provider)) throw new Error('Invalid provider');
  return path.join(app.getPath('userData'), 'search-index-v3', provider);
}
function key(source: string): string { return createHash('sha256').update(source).digest('hex') + '.json'; }

export async function readSearchIndex(provider: string, source: string, version: Version): Promise<RecordData | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path.join(directory(provider), key(source)), 'r');
    const size = (await handle.stat()).size;
    if (size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > size) return null;
    const data = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as RecordData;
    if (data.mtime !== version.mtime || data.size !== version.size || data.ctime !== version.ctime ||
        typeof data.text !== 'string' || data.text.length > MAX_TEXT || typeof data.cwd !== 'string') return null;
    return data;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

export async function writeSearchIndex(provider: string, source: string, data: RecordData): Promise<void> {
  let temporary: string | undefined;
  try {
    const dir = directory(provider);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const output = JSON.stringify({ ...data, text: data.text.slice(0, MAX_TEXT) });
    if (Buffer.byteLength(output) > MAX_RECORD_BYTES) return;
    const target = path.join(dir, key(source));
    temporary = target + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, output, { mode: 0o600 });
    await fs.rename(temporary, target);
  } catch { /* Search remains available when the cache cannot be written. */ }
  finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
}

/**
 * Delete the provider's index records whose source transcript is no longer
 * listed. `sources` is an allow-list over the whole corpus, so a partial (or
 * empty) list deletes every other record: callers only reach this from a
 * discovery pass that reported `complete: true`, because a root whose readdir
 * threw reads as "no transcripts" and would wipe the derived index (P2-70).
 */
export async function pruneSearchIndex(provider: string, sources: string[]): Promise<void> {
  try {
    const dir = directory(provider);
    const live = new Set(sources.map(key));
    for (const name of await fs.readdir(dir)) {
      if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name)) await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  } catch { /* Missing cache or unavailable filesystem. */ }
}
