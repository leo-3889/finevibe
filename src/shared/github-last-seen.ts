/**
 * Cap for ProjectRecord.githubLastSeen entries (docs/performance.md growth row).
 * Unbounded growth shipped in PA-31: every viewed PR/issue stamped an entry
 * that was never pruned, so state.json grew with browsing history.
 */
export const GITHUB_LAST_SEEN_MAX = 200;

/**
 * Prune a project's githubLastSeen record in place to the newest
 * GITHUB_LAST_SEEN_MAX entries (ISO timestamps sort lexically). Called at the
 * write sites in renderer/state.ts. Returns true when anything was removed.
 */
export function pruneGithubLastSeen(record: Record<string, string>): boolean {
  const ids = Object.keys(record);
  if (ids.length <= GITHUB_LAST_SEEN_MAX) return false;
  // Oldest first; drop from the front until the cap holds.
  ids.sort((a, b) => {
    if (record[a] !== record[b]) return record[a] < record[b] ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  const excess = ids.length - GITHUB_LAST_SEEN_MAX;
  for (let i = 0; i < excess; i++) delete record[ids[i]];
  return true;
}
