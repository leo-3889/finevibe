import * as fs from 'fs';
import * as path from 'path';
import type { ProviderId } from '../../shared/types';
import type { TranscriptDescriptor, TranscriptDiscovery } from './provider';
import { loadState } from '../store';

/** Per-session character cap when indexing transcript content for global search. */
const MAX_INDEX_CHARS_PER_SESSION = 50 * 1024;

/**
 * Accumulates user-message text under the per-session character budget,
 * charging the join separator at push time so the final
 * `join(TRANSCRIPT_TEXT_SEPARATOR)` is provably within
 * MAX_INDEX_CHARS_PER_SESSION. Without the separator charge, many short
 * messages join past the cap and the persisted index (which slices to it)
 * searches a different string than the first read.
 */
export class IndexTextBudget {
  private texts: string[] = [];
  /** Length of `join()` so far, separators included. */
  private used = 0;

  /** Push `text`, trimmed to the remaining budget including its separator. */
  push(text: string): void {
    const separator = this.texts.length ? TRANSCRIPT_TEXT_SEPARATOR.length : 0;
    const room = MAX_INDEX_CHARS_PER_SESSION - this.used - separator;
    if (room <= 0) return;
    const bounded = text.slice(0, room).trim();
    if (!bounded) return;
    this.texts.push(bounded);
    this.used += separator + bounded.length;
  }

  get full(): boolean {
    return this.used >= MAX_INDEX_CHARS_PER_SESSION;
  }

  join(): string {
    return this.texts.join(TRANSCRIPT_TEXT_SEPARATOR);
  }
}

/**
 * Byte ceilings that back the character cap above. A char cap alone does
 * not bound what a reader pulls off disk: the whole file has to be
 * resident before the budget can stop it.
 *  - MAX_INDEX_BYTES: the most any indexer reads from one transcript.
 *  - MAX_INDEX_FILE_BYTES: above this a transcript is not opened at all.
 */
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const MAX_INDEX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * How many transcript files one discovery/index pass may have open at
 * once. A sessions tree spans every project dir of every profile, so an
 * unbounded `Promise.all` there means hundreds of simultaneous opens.
 */
export const TRANSCRIPT_IO_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most `limit` calls in flight, results in
 * input order. Workers drain a shared cursor, so the whole batch finishes
 * before the first rejection surfaces — no orphaned work left running
 * behind a rejected `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  const workers: Array<Promise<void>> = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

/** UUID v4-shaped string used as a cliSessionId by Claude/Codex/Copilot. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Joins extracted user-message snippets with a clear separator the snippet extractor can land on. */
export const TRANSCRIPT_TEXT_SEPARATOR = '\n---\n';

/**
 * The default transcript root plus every profile's config dir for `providerId`,
 * deduped. Each root is paired with its profile id (undefined = default) so
 * resume can reopen against the right config dir.
 */
export function collectProfileRoots(providerId: ProviderId, defaultRoot: string, subDir: string): Map<string, string | undefined> {
  const roots = new Map<string, string | undefined>([[defaultRoot, undefined]]);
  try {
    for (const profile of loadState().profiles ?? []) {
      if (profile.providerId === providerId) {
        const root = path.join(profile.configDir, subDir);
        if (!roots.has(root)) roots.set(root, profile.id);
      }
    }
  } catch {
    // Profiles unavailable — fall back to the default root only.
  }
  return roots;
}

/**
 * The errors that mean "this root has no transcripts": a provider the user
 * never ran simply has no directory. Everything else (EIO, EPERM, EACCES on a
 * mounted tree) is a transient failure and must NOT read as an empty corpus.
 */
export function isMissingRootError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Directory listing for transcript discovery: a missing root is an empty
 * listing, every other failure propagates so the caller marks the pass
 * incomplete instead of pruning the derived index off a partial scan (P2-70).
 */
export function readdirForDiscovery(dir: string): Promise<string[]>;
export function readdirForDiscovery(dir: string, withFileTypes: true): Promise<fs.Dirent[]>;
export function readdirForDiscovery(dir: string, withFileTypes = false): Promise<string[] | fs.Dirent[]> {
  // Branched, not `{ withFileTypes }`: the option's literal type (`true` vs
  // `false`) is part of the Node overloads, and a widened `boolean` matches
  // neither. The branch keeps each call pinned to its overload.
  const listing = withFileTypes
    ? fs.promises.readdir(dir, { withFileTypes: true })
    : fs.promises.readdir(dir);
  return listing.catch((err) => {
    if (isMissingRootError(err)) return [];
    throw err;
  });
}

/**
 * Accumulates one provider's discovery pass and remembers every root whose
 * scan threw, so `result()` can tell the caller the corpus is partial.
 */
export class TranscriptDiscoveryScan {
  readonly descriptors: TranscriptDescriptor[] = [];
  readonly incompleteRoots: string[] = [];

  /** Run one root's scan; a throw on an existing root marks it incomplete. */
  async collect(root: string, scan: () => Promise<void>): Promise<void> {
    try {
      await scan();
    } catch (err) {
      if (!isMissingRootError(err)) this.incompleteRoots.push(root);
    }
  }

  result(): TranscriptDiscovery {
    return {
      descriptors: this.descriptors,
      complete: this.incompleteRoots.length === 0,
      incompleteRoots: this.incompleteRoots,
    };
  }
}
