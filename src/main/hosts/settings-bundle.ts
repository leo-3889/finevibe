// Settings-sync bundle builder (per-host providers plan §4, UR-5).
//
// Pure: given the provider selection and a read-only source view of the
// LOCAL provider trees (the provider-fs seam's local lane, hostId undefined),
// build the exact `{relPath, content}` list that will be pushed to a host.
// The builder IS the allowlist (§7: sync writes are confined to the §4 file
// sets — nothing outside these paths is ever read into a bundle, and the
// never-synced names are dropped from every directory walk).
//
// The two council rules live here:
//  - dedupe-by-path (R-4): pi and pi-bolt share the `~/.pi/agent` tree
//    (pi-bolt-provider.ts:25,151) — one selection entry per path, built once.
//  - hook-block strip (O-1): settings.json is pushed with the FineVibe hook
//    marker block removed (the block embeds machine-specific paths and would
//    clobber the host's own T2 block; hooks live on the host via enrollment,
//    not in the bundle).

import type { ProviderId } from '../../shared/types';
import { stripHookBlock } from './host-hooks';

/** Read-only view of the source tree: readText resolves null for a missing
 * file AND for a directory; listDir resolves null for anything that is not a
 * directory (the provider-fs seam's exact local-lane semantics). */
export interface BundleSourceFs {
  readText(relPath: string): Promise<string | null>;
  listDir(relDir: string): Promise<string[] | null>;
}

/** The providers settings sync supports (UR-5 scope). */
export const SYNCABLE_PROVIDER_IDS: ProviderId[] = ['pi', 'pi-bolt', 'omp'];

/** The pi tree — shared by pi and pi-bolt (pi-bolt-provider.ts:25,151).
 * Per-provider synced file sets (§4 table — THE contract). Paths are
 * home-relative posix with the `~/` spelling the seam accepts; a trailing
 * `/` walks the directory recursively. Everything not reachable from these
 * sets is out of scope by construction. */
const PI_FILE_SET = ['~/.pi/agent/settings.json', '~/.pi/agent/AGENTS.md', '~/.pi/agent/mcp.json', '~/.pi/agent/skills/'];

export const PROVIDER_FILE_SETS: Record<'pi' | 'pi-bolt' | 'omp', string[]> = {
  pi: PI_FILE_SET,
  'pi-bolt': [
    // Shares the whole pi tree (R-4 dedupe composes this with `pi`). The
    // extension tree syncs as MANIFESTS ONLY (§4): package.json + lockfile,
    // and `npm install` on the host materializes node_modules (R2).
    ...PI_FILE_SET,
    '~/.pi/agent/npm/package.json',
    '~/.pi/agent/npm/package-lock.json',
  ],
  omp: [
    '~/.omp/agent/settings.json',
    '~/.omp/agent/keybindings.yml',
    // Plugin manifests only — bun.lock is the local runtime's lockfile, not
    // in the §4 set; the host installs from package.json + omp-plugins.lock.
    '~/.omp/plugins/package.json',
    '~/.omp/plugins/omp-plugins.lock.json',
  ],
};

/** §4 "Never synced", enforced in every directory walk (the top-level sets
 * are an allowlist, so these names only matter inside `skills/`). */
export function neverSyncPath(relPath: string): boolean {
  const base = relPath.replace(/\/+$/, '').split('/').pop() ?? '';
  return base === 'sessions' || base === 'cache' || base === 'node_modules' || base === 'ssh-remote-config.json';
}

/** Bound for a runaway skills tree: a bundle is a config set, not a corpus
 * (walk stops growing past this many files). */
export const MAX_BUNDLE_FILES = 500;

/** One file destined for the host. relPath is the `~/`-anchored posix path
 * (the key drift hashes are stored under); content is LF-normalized. */
export interface BundleEntry {
  relPath: string;
  content: string;
}

/** R3: local source on Windows may carry CRLF; every host is POSIX. */
function normalizeLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/** The settings.json paths of the file sets — the O-1 hook-strip targets. */
const SETTINGS_BASENAME = 'settings.json';

async function walkInto(
  source: BundleSourceFs,
  relDir: string,
  depth: number,
  out: Map<string, string>,
): Promise<void> {
  if (out.size >= MAX_BUNDLE_FILES) return;
  const entries = await source.listDir(relDir);
  if (entries === null) return; // vanished mid-walk
  for (const name of [...entries].sort()) {
    if (out.size >= MAX_BUNDLE_FILES) return;
    const child = `${relDir}${name}`;
    if (neverSyncPath(child)) continue;
    const content = await source.readText(child);
    if (content !== null) {
      out.set(child, content);
      continue;
    }
    if (depth > 0) await walkInto(source, `${child}/`, depth - 1, out);
  }
}

/**
 * Build the push bundle: §4 file sets ∩ source tree, deduped by path (R-4),
 * settings.json hook-stripped (O-1), every file LF-normalized (R3).
 * Missing source files are simply absent from the bundle (nothing to push).
 * A corrupt settings.json throws — a bundle built from a config FineVibe
 * cannot parse must never reach a host.
 *
 * ponytail: machine-specific absolute paths inside mcp.json et al. push
 * verbatim (path templating deferred per §4); the file set is JSON/markdown/
 * YAML text only, so the LF pass treats every synced file as text.
 */
export async function buildSettingsBundle(
  providerIds: ProviderId[],
  source: BundleSourceFs,
): Promise<BundleEntry[]> {
  const byPath = new Map<string, string>();
  for (const providerId of providerIds) {
    const set = PROVIDER_FILE_SETS[providerId as keyof typeof PROVIDER_FILE_SETS];
    if (!set) continue; // non-syncable provider ids contribute nothing
    for (const entry of set) {
      if (entry.endsWith('/')) {
        await walkInto(source, entry, 4, byPath);
        continue;
      }
      if (byPath.has(entry)) continue; // R-4: pi/pi-bolt share the tree
      const raw = await source.readText(entry);
      if (raw === null) continue;
      const stripped = entry.endsWith(SETTINGS_BASENAME) ? stripHookBlock(raw).json : raw;
      byPath.set(entry, stripped);
    }
  }
  return [...byPath].map(([relPath, content]) => ({ relPath, content: normalizeLf(content) }));
}
