/**
 * Row 26 slice 5: the two project-root gates the fs and git IPC domains share.
 *
 * Verbatim move out of ipc-handlers.ts. They live here because the fs domain
 * (ipc/fs-domains.ts) and the git/pty gates that stay in ipc-handlers.ts both
 * need them, and a domain module must never import back into ipc-handlers.ts
 * (the slice-1 seam contract): a shared gate needs a shared home.
 *
 *  - `isWithinKnownProject`: canonical membership in the store's project root
 *    set (P1-12 `deriveGateRoots` output).
 *  - `remoteProjectOwnerOf`: the Phase 3 belt, "this path belongs to a project
 *    on a remote host" — compared on the raw posix string, never canonicalized.
 */
import * as path from 'path';
import { getKnownProjectPaths, getRemoteProjectRoots } from './store';
import { canonicalPath, canonicalRoot, isWithin } from './fs-utils';

/**
 * Check if a resolved path is within one of the known project directories.
 */
export function isWithinKnownProject(resolvedPath: string): boolean {
  const target = canonicalPath(resolvedPath);
  const paths = getKnownProjectPaths();
  return paths.some(p => isWithin(canonicalRoot(p), target));
}

/**
 * Coherence Phase 3 belt (docs/hosts.md "never silently lie"): a path that
 * belongs to a REMOTE project must never be served by the local sinks. On a
 * Linux controller whose local paths mirror the host's, local canonicalization
 * happily resolves the remote string to a real local directory - the gate
 * above passes and git/fs read the WRONG machine. Compare the raw string
 * (posix-normalized) against the remote project roots; no canonicalization.
 */
export function remoteProjectOwnerOf(resolvedPath: string): string | undefined {
  const posix = resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const root of getRemoteProjectRoots()) {
    const r = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (posix === r || posix.startsWith(`${r}/`)) return root.hostId;
  }
  return undefined;
}
