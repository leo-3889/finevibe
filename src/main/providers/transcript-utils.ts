import * as path from 'path';
import type { ProviderId } from '../../shared/types';
import { loadState } from '../store';

/** Per-session character cap when indexing transcript content for global search. */
export const MAX_INDEX_CHARS_PER_SESSION = 50 * 1024;

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
