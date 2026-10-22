# Plan: refresh folder listing on click (sidebar file tree)

Date: 2026-10-20 · Status: code shipped 5a4b9bd (items 41-42); §Docs rows remain → see
[`../PENDING.md`](../PENDING.md) §3. Archived 2026-10-22. · Owner: TBD

## Request

When clicking a folder in the sidebar file tree, the folder's contents should be
refreshed (re-read from disk), not served from stale cache.

## Current behavior (investigated)

Click chain: sidebar `buildProjectRow` opens the files panel →
`renderFileTree(project, container)` (`sidebar.ts:363`) → `renderChildren` →
`loadEntries` (`src/renderer/components/file-tree.ts:183-200`).

Folder row click handler (`file-tree.ts:257-267`) toggles expansion via
`toggleFolder` and, on expand, calls `renderChildren` → `loadEntries`.
`loadEntries` returns `entryCache.get(folderPath)` whenever a cached listing
exists — **no disk read on expand**.

Automatic refresh exists via watchers: expanded folders are watched
(`watchFolder`), fs-change events batch through `pendingDirs` →
`flushPendingDirs` → `reconcileChildren`, which evicts that dir's cache and
patches the DOM. So the gap is every case where no fs event arrives.

### Staleness gaps

1. **Root listing never collapses/evicts.** `entryCache.get(project.path)` is
   served by every `renderFileTree` call (panel reopen, project switch,
   `preferences-changed` re-render, sidebar.ts:358-372). Root has no collapse,
   so its cache survives the whole session; a missed watcher event at the
   project root is never manually recoverable.
2. **Missed/absent fs events.** `fs.watch` gaps (network drives, atomic
   replacement, Linux inotify limits, watcher failures in
   `src/main/file-watcher.ts`) leave expanded folders stale; the only manual
   refresh gesture is collapse→expand, which exists only for non-root folders.
3. **Inflight race.** `loadEntries` writes `entryCache` unconditionally when
   the `listDir` promise resolves (file-tree.ts:191). A read that resolves
   after a collapse (`unwatchSubtree` evicted the subtree in the meantime)
   repopulates stale entries; the next expand serves them.

Collapse already evicts its subtree (`unwatchSubtree`, file-tree.ts:55-57,
`isPathUnder` = self + descendants), so the fix targets expand/render and the
race.

## Change

All in `src/renderer/components/file-tree.ts`.

1. Add `refreshFolderCache(folderPath: string): void` — delete `entryCache`
   and `inflight` entries for `folderPath` and everything under it
   (`isPathUnder`), mirroring `unwatchSubtree`'s eviction without touching
   watchers.
2. In the folder-row click handler expand branch (before `renderChildren`),
   call `refreshFolderCache(entry.path)`: every user-initiated expand is a
   disk read; expanded descendants re-read too (their listings are inside the
   evicted subtree).
3. In `renderFileTree`, call `refreshFolderCache(project.path)` before the
   root `renderChildren` — closing gap 1.
4. Close the race (gap 3): in `loadEntries`, set `entryCache` only when the
   resolving promise is still the registered inflight
   (`if (inflight.get(folderPath) === promise) entryCache.set(...)`), so an
   eviction during flight is not overwritten by the stale result.
5. Drive-by: remove the duplicated `activeTrees.set(...)` line in
   `renderFileTree` (lines 517 and 519 are identical).

Cost: one extra `listDir` IPC per expand / panel open. Cache keeps serving
reconcile passes and repeated sidebar re-renders within one open panel.

Explicit non-goals: no changes to `src/main/file-watcher.ts` (watcher
reliability is a separate concern, tracked in docs/performance.md), no
collapse-time refresh (contents are hidden then), no UI spinner — listing
swaps in as it does today.

## Tests (`file-tree-reconcile.test.ts`, existing fake-fs harness)

- Root re-render is fresh: `renderFileTree`, mutate `dirContents` with **no**
  fs event, `renderFileTree` again → new entry present. Fails before (gap 1),
  passes after.
- Expand re-reads from disk: expand a folder, collapse it, mutate its dir,
  expand again → `listDir` called a second time for that path and new child
  row appears.
- Existing tests must stay green: `file-tree.test.ts`,
  `file-tree-reconcile.test.ts` (watcher reconcile paths must be untouched by
  eviction-on-expand).

## Docs

- `docs/FEATURES.md` file-tree row (~line 36): expand/re-open re-reads from
  disk; watcher events reconcile while expanded.
- `docs/performance.md` entry-cache row (line 85): note eviction on expand and
  panel re-open.

## Verification

```bash
npx tsc -p tsconfig.renderer.json --noEmit
npm test -- src/renderer/components/file-tree
git diff --check
```
