# Performance and resource limits

These behaviours apply to the current source working tree. They have build and automated-test coverage; packaged-app performance has not been measured.

## File previews and search

The file reader accepts text files up to 8 MiB. It displays a bounded page instead of building a document for every line at once. Use Previous, Next, or raw-view go-to-line to reach another part of the file.

| Surface | Limit | What the user sees |
| --- | --- | --- |
| Text and Markdown preview | Page budget of 2,000 lines or 128 Ki characters | A partial-preview notice and navigation controls. Long lines may be cut short. Rendered Markdown can end inside a block at a page boundary. |
| Find within a file preview | Displayed page only | Matches outside the current page are not searched. Change pages to search another section. |
| Untracked Git diff | 256 KiB and 5,000 split lines | An explanatory message instead of an oversized diff. Files containing NUL bytes receive a binary-file message. |
| Global session search | Best 20 results; indexed text capped at 50 Ki characters per transcript, join separators included | Results search extracted user text, not every byte of a conversation. |
| Pasted clipboard image | 25 MiB decoded; PNG, JPEG, GIF, WebP, BMP, TIFF | An oversized or unsupported image attaches nothing: the paste is silent. Saved images live in `os.tmpdir()/finevibe-paste` and files older than a day are pruned. |

`KiB` means 1,024 bytes. Character budgets use JavaScript string length (UTF-16 code units), not bytes or displayed symbols. These limits are code constants, not Preferences settings.

Sources: [file read and clipboard paste boundaries](../src/main/ipc-handlers.ts), [preview paging](../src/renderer/file-preview.ts), [file reader](../src/renderer/components/file-reader.ts), [Git diffs](../src/main/git-status.ts), and [transcript index limits](../src/main/providers/transcript-utils.ts).

## Session search work and storage

Editing the search query, closing the palette, starting a newer search in the same window, or destroying that window cancels obsolete work. Discovery checks the abort signal. Gemini discovery stats each transcript, skips files above the indexer's 64 MiB file limit, and extracts the session ID from a bounded 64 KiB header read instead of loading whole transcripts. Workers stop scheduling new indexing when cancelled; already-submitted reads can finish and populate the cache. Concurrent requests share in-flight reads and a four-operation indexing budget. This budget does not describe every filesystem operation in discovery or the rest of the app.

Workers score each transcript immediately and retain compact results. Result snippets and names are copied so short string slices cannot retain whole transcript strings. The text cache holds at most 500 entries and 8 Mi characters in total, counting original and lowercase forms together. These payload budgets are not a measurement of total application heap usage.

The derived disk index lives at:

```text
<Electron userData>/search-index-v3/<provider>/<SHA-256-of-source-path>.json
```

The index contains extracted user text, its working directory and source version metadata. It is local plaintext data; hashed filenames do not encrypt its contents. Source mtime, size and ctime determine reuse. Each record's text is capped at 50 Ki characters, and its serialized JSON must fit within 332 KiB. Records for sources absent from a completed, uncancelled provider discovery/index pass are pruned; the sweep is rate-limited per provider — `claimPruneSlot` grants each provider one prune pass per 30 s (`PRUNE_MIN_INTERVAL_MS`, `src/main/session-deep-search.ts:21-30,335`) — so repeat searches never re-walk the index per keystroke. A cancelled pass can leave them until a later completed pass. A pass whose discovery reported an incomplete scan root (`TranscriptDiscovery.complete` false, P2-70) counts as not-completed for pruning: its records survive untouched, because a root that failed to list is not evidence its transcripts are gone (see [provider contracts](provider-contracts.md)).

Disk usage scales with history; the Pi/OMP session bases are bounded by the 2 GiB per-base quota (`SESSIONS_QUOTA_BYTES`, `src/main/launch-session-dir.ts`, A4 — startup + 24 h sweeps), and Preferences → Storage (A5, `storage:scan`, `src/main/ipc-handlers.ts`) reports the userData subtree sizes with scan caps surfaced as a `truncated` note. Eviction from the in-memory cache does not require reparsing an unchanged transcript when its disk index remains valid. Search still performs discovery and reads index records, so it is not free of filesystem work.

To rebuild the index, close VibeYard and remove only `search-index-v3` from its Electron user-data directory. The next search rebuilds the required entries. This does not delete provider transcripts or the separate `~/.finevibe/state.json` file. Preferences → Storage (A5) adds an in-app cache-clear control (`storage:clear` in `src/main/ipc-handlers.ts`): Chromium caches (Cache/GPUCache/Code Cache/Dawn*Cache) plus Chrome-import temp dirs, sessions and browser profiles never touched — the search index is deliberately not in that cache set, so the directory removal above stays the rebuild path. Developers must change the index directory version when extraction semantics change; the v2→v3 bump (P2-69) invalidated every pre-fix record because the Codex cwd extraction fix changed the persisted working directory that search results carry.

Sources: [search coordinator](../src/main/session-deep-search.ts), [disk index](../src/main/session-search-index.ts), [IPC cancellation](../src/main/ipc-handlers.ts), and [palette](../src/renderer/components/session-search-palette.ts).

## Inspector event retention

Hook `.events` files are read in at most 64 KiB of new bytes per turn. Unfinished lines remain buffered, including partial UTF-8 sequences. Backlogs schedule further reads without requiring a new file notification. Individual JSONL records over 64 KiB are skipped through their next newline; malformed complete records are also skipped. The reader resets when the file becomes shorter than its current byte offset.

The renderer keeps the newest events within both a 2,000-event limit and a 2 Mi-character budget per session, measured using serialized JSON length. Individual renderer events over 64 Ki characters are skipped. Oldest events are removed first. Events carry a monotonic ingestion `seq` (C2R-02): the timeline's expandable-row keys are seq-prefixed and its append-guard compares the first event's identity, so the in-place rotation at the 2,000-event cap no longer moves row details onto other rows or collapses valid expansions (`src/renderer/components/session-inspector-timeline.ts:410`). The inspector is a bounded recent-history view, not a complete event archive. These retention limits do not rotate the source event file; session cleanup removes its hook files and pending continuation state.

Sources: [event reader](../src/main/bounded-event-reader.ts), [hook lifecycle](../src/main/hook-status.ts), and [inspector state](../src/renderer/session-inspector-state.ts).

## Pi/OMP discovery and remaining costs

Pi/OMP launches use an exclusive session directory for transcript ownership. Live registrations share one filename/generation history per watched directory. Each registration records its generation instead of retaining its own complete filename set. Registration still takes a fresh synchronous listing so pre-existing transcripts remain excluded even on filesystems with coarse timestamps.

During polling, unchanged directory listings are reused. Directory mtime changes and watched rename events invalidate listings; the next scan also refreshes a listing after its 30-second cache lifetime. The two-second poll remains in place. Polling still visits cached filenames and checks directory metadata. Root history is released when no registration uses it.

When a transcript's last meaningful entry does not fit the 16 Ki status window, a bounded 4 MiB fallback read parses it (a search dump larger than the old 1 MiB bound left tab status frozen on its last value, because the derived null suppressed writes); entries beyond the fallback yield no status and the status stays at the last value written. The derived status is cached with the file size and reused while the size is unchanged. That cache is an LRU capped at 512 paths (`MAX_STATUS_TAIL_CACHE`): reads and writes move a path to the newest position and writes past capacity evict the oldest, so a closed session whose oversized final entry never yields a status again cannot pin an entry for the process lifetime. `loadState()` likewise serves the parsed `state.json` from an in-memory cache, refreshed by every save path; anything that rewrites the state file behind `saveState()`/`saveStateSync()` must call `invalidateStateCache()` first.

This removes duplicate per-session snapshots and reduces idle directory enumeration. The per-launch directory and known resume ID address the earlier cross-tab attribution paths in code. Registration scans still run on the main thread, and watcher allocation and runtime resource use have not been measured at scale: real main-thread delay, RSS and watcher-handle counts in the running app have never been measured — every bound in this document is a code constant verified by unit tests on Windows, not a measured runtime cost. **PO-06 remains partially addressed.**

Sources: [Pi-compatible watcher](../src/main/pi-compatible-session-watcher.ts), [fallback status reader](../src/main/providers/pi-compatible-transcripts.ts), and [state store](../src/main/store.ts).

## Codex rollout attribution scan cost

For hookless Codex tabs, `src/main/codex-session-watcher.ts` scans `~/.codex/sessions/YYYY/MM/DD/` for rollouts to attribute to pending tabs: `fs.watch` events are coalesced into at most one scan per 500 ms, and a 2 s poll fallback keeps scanning while any tab is pending. Four bounds keep a scan cheap:

- Parsed `session_meta` is cached per path (`metaCache`, capped at `MAX_META_CACHE_ENTRIES = 256`, oldest evicted first, `src/main/codex-session-watcher.ts:69-70`) and invalidated by `(mtimeMs, size)`, so a rollout is read once per change, not once per scan. Before the cache, every scan re-read and re-decompressed every rollout in today's directory up to twice a second for the whole life of a pending tab.
- A `.jsonl.zst` meta read touches at most a 256 KiB compressed prefix (`META_PREFIX_BYTES`, `:56`) through a head-only read (`readHead`, `:117-125`) — the whole file is never materialized. `session_meta` is the FIRST line of the zstd frame, so the prefix decodes to it, and a rollout mid-append can end mid-frame: a cut frame decodes the blocks it already holds (Node's sync zstd returns the partial output).
- When the prefix yields no usable meta line, `scheduleFullDecode` (`:162-213`) streams the file through the zstd decoder off the pairing path, stops at the first newline or `META_READ_BYTES` (64 KiB, `:48`) of decompressed output, and publishes the result — nulls included — into `metaCache` for the file's `(mtime, size)`, so a rollout version decodes once, never once per scan. The scheduling scan returns null (the tab stays pending); the 500 ms/2 s cadence picks the cached meta up. `MAX_COMPRESSED_META_FILE_BYTES` (8 MiB compressed, `:60`) gates this fallback (`readSessionMeta` `:230`); the plain `.jsonl` path stays bounded to the 64 KiB head (`readSessionMeta` `:228`).
- The tree is zero-padded `YYYY/MM/DD` and the walk is newest-first, so year/month/day directories whose names sort below the oldest pending registration (minus the 60 s `MTIME_SKEW_MS` window) are pruned by name — no stat, no readdir. A day directory that survives name pruning and has an older mtime costs one stat. A scan is O(recent days) no matter how much Codex history exists on disk.
- Watcher shape (S2-05): Node’s Linux recursive `fs.watch` spends one inotify watch per subdirectory, so on Linux the rollout watcher is a non-recursive chain — `SESSIONS_ROOT` plus the current `YYYY`, `YYYY/MM`, `YYYY/MM/DD` dirs, armed and retired on every scan tick as the calendar rolls (`armCurrentDateDirs`, `:449`; dir watchers `armDirWatch`, `:424-437`); win/mac keep the single recursive handle (`fs.watch(SESSIONS_ROOT, { recursive: true })`, `:492`). The 2 s poll stays the correctness backbone on every platform.

Honest bound: these are structural removals of repeated I/O, verified by `src/main/codex-session-watcher.test.ts` (meta parsed once per change, bounded prefix reads counted inside the `fs` mock; day pruning by name). The measured cost in a running app — scan wall-time against years of history, decompression peaks, watcher handles — remains unmeasured, like the Pi/OMP numbers above.

Sources: [Codex session watcher](../src/main/codex-session-watcher.ts).

## Static footprint audit (2026-10-18): growth structures

A full static audit of main + renderer verified every bound above against source and found the registry/watcher/pane layers correctly bounded: no main-side PTY output buffering, streaming launcher download, and one-shot child processes reaped synchronously. The 2026-10-18 claims "no per-spawn listener accumulation", "no watcher or polling retention for closed sessions" and "singleton timers only (four 2-second pollers, each a no-op while its registry is empty)" were corrected by the 2026-10-21/22 Wave E audit: the idle main process runs ~14 timers (the 2 s Claude `cleanup()` sweep and the 2 s per-session `readStatus` poll were real; pi/OMP scanning is watcher-driven (250 ms debounce, 1 s floor) with a 2 s full-sweep poll backbone and a 30 s directory-listing cache, PA-01/02; git-watch cleanup covers all per-session state, PA-16; worktree polling is a 30 s cadence with an immediate kick on project switch, PA-17). Structures that grew without a code cap, with their Wave E disposition:

| Structure | Location | Growth | Planned fix |
| --- | --- | --- | --- |
| `PersistedState.projects[].sessionHistory` | `src/shared/types.ts`, rows created for every session at spawn | fixed (PA-06): soft cap 500, but bookmarked and `active` rows were exempt from pruning, so a crash-orphaned `active` row and bookmarks accumulated without limit; the dominant term in every full-state save | `enforceHistoryCap` exempts only the newest 50 bookmarks (`BOOKMARK_EXEMPT`) and `active` rows with a live tab |
| Renderer persist burst | `src/renderer/state.ts` `persist()` → `src/main/store.ts` `saveStateSync` | fixed `ffcd283`: each persist serializes the whole state and structured-clones it over IPC, and mutation bursts (kanban sync, session moves, title adoption) used to pay that per mutation | leading-edge 200 ms throttle coalesces a burst to one IPC, `beforeunload` flushes; the store's per-save transient (object graph + JSON string + Buffer, ~2–3× payload) remains, capped by the history fix |
| Zip export sidecars | `src/main/session-export.ts` `readSidecars` | fixed (PA-20): all sidecar files, `.events` included, were buffered whole; the source `.events` file has no size cap on disk (64 KiB is the read budget, not the file size) | each sidecar streams through the zip with `createReadStream`; a half-written zip is unlinked, never left as a backup |
| xterm scrollback | all three `new Terminal({...})` sites | fixed (PA-29): library default 1,000 lines/tab (~240 KB UTF-16 at 120 cols) was a bound by omission | `TERMINAL_SCROLLBACK = 5000` in `src/renderer/components/terminal-shared.ts:12`, set at all three sites |
| `hook-status` `lastMtimes` | `src/main/hook-status.ts` | fixed (PA-15): rows for one-shot files (e.g. `.toolfailure`) lingered after the file was unlinked, until session cleanup | a sweep at the poll cadence (15 s watchdog while the watcher lives, 2 s without) deletes every row whose file is gone, no exemptions; session cleanup prunes rows the last `readdir` lacked |
| Push-only listener arrays | `sharing/share-manager.ts`, `session-inspector-state.ts` | fixed (PA-32): no public unsubscribe (latent — today one module-scope caller each) | `onChange` returns unsubscribe closures; renderer init keeps one handle per feed and unsubscribes on re-init |
| File-tree directory cache | `src/renderer/components/file-tree.ts` `entryCache` | fixed (PA-30): one entry list per directory expanded during the session, freed only on collapse/project removal | LRU cap 2,000 directories (`ENTRY_CACHE_MAX_DIRS`), Map-insertion recency; every user-initiated expand and panel re-render evicts the subtree and re-reads from disk (`refreshFolderCache`, 5a4b9bd) |
| `ProjectRecord.githubLastSeen` | `src/shared/types.ts` | fixed (PA-31): one entry per viewed PR/issue, forever | `pruneGithubLastSeen` keeps the newest 200 entries (`src/shared/github-last-seen.ts`) at every write site |
| Per-launch session dirs | `src/main/launch-session-dir.ts` (`<userData>/pi-sessions`, `<userData>/omp-sessions`) | fixed: one directory per Pi/OMP start/resume, never removed — unbounded on disk, and `listLaunchSessionDirs()` cost one `stat` + one sidecar `readFile` per directory on EVERY global session search (~2,000 synchronous syscalls per search at 1,000 tabs) | 30-day retention window (`LAUNCH_SESSION_RETENTION_MS`), swept once per provider base per process, deferred off the spawn path to a `setImmediate` and capped at 200 directories per pass; the same age filter now gates the search listing |
| Per-launch session dirs — A4 sweeps/quota (2026-10-23) | `src/main/launch-session-dir.ts` (`startSessionRetentionSweeps`, `enforceLaunchSessionQuota`) | the row above's arming was launch-only: an install that never launches Pi/OMP grew the two bases forever, and a heavy user's bases had no disk bound inside the 30-day window | startup sweep on a `setImmediate` + unref'd 24 h re-arm (daily tick also runs `sweepEnumerationCaches()`), plus a 2 GiB per-base quota (`SESSIONS_QUOTA_BYTES`): over quota, expired dirs evict oldest-first (sidecar `createdAt` → newest transcript mtime → dir mtime) under the same all-timestamps-past-window predicate; young dirs survive; `PRUNE_SCAN_LIMIT` bound and P2-57 ordering reused |
| `enumerateCache` / `topFilesCache` | `src/main/ipc-handlers.ts` | fixed (B1): one entry per cwd enumerated/scanned in the session (Quick Open listings and token scans), freed only by the 30 s TTL / `git:changed` on the cwds someone revisited | LRU cap 64 cwds each (`ENUMERATE_CACHE_MAX`, `TOP_FILES_CACHE_MAX`), read-hit touch + oldest eviction; `sweepEnumerationCaches()` drops TTL-expired entries between invalidations |
| `outsideHomeConsent` | `src/main/ipc-handlers.ts` | fixed (B1): one consent answer per home-outside dir canonicalized in the session (every Add-Project keystroke prefix on a home-outside root) | FIFO cap 200 (`OUTSIDE_HOME_CONSENT_MAX`), oldest answer evicted first (mirrors `MAX_CONSENT_DIR_RECORDS`); an eviction costs a re-prompt, the safe direction |
| `rootCanonicalCache` | `src/main/fs-utils.ts` | fixed (B1): gate-root canonical forms live for the process, dropped only when the project/profile root set changes | LRU cap 1,024 (`ROOT_CANONICAL_CACHE_MAX`), read-hit touch + oldest eviction |
| `gateRootCanonicalByPath` | `src/main/store.ts` | fixed (B1/B2): per-path gate memo cleared only by the test-only `invalidateStateCache`, so production grew it per project path and could keep a stale realpath after project add/remove | FIFO cap 200 (`GATE_ROOT_CANONICAL_MAX`); `store:save`/`store:save-sync` now call `invalidateStateCache()` whenever `invalidateCanonicalPathIfRootsChanged` reports a root-set change |
| `foldsCaseByDir` | `src/main/settings-guard.ts` | fixed (B1): one case-fold probe result per dir probed in the session | FIFO cap 200 (`FOLDS_CASE_BY_DIR_MAX`), oldest evicted first; the eviction cost is one re-probe, never a policy change |
| Legacy `Vibeyard`/`vibeyard` userData tree | `src/main/userdata-migration.ts` | fixed (A3): the copy-only migration contract left the whole legacy Chromium tree (browser state, caches, cookies) on disk for the machine's life after every cutover install | ledger-driven retirement (`retireLegacyUserData`, run at startup after the migration): deletes a legacy appData tree only after a 30-day grace (`RETIRE_GRACE_MS`), a destination integrity check against the migration ledger's `fileCount` (`userData/.finevibe-migrations.json`) and with no `retire-legacy-user-data.off` opt-out; pre-ledger copies (`fileCount: -1`) are never auto-retired; the home tree (`~/.vibeyard`) is out of scope; outcomes land in `userData/legacy-retirement.json` (`getLegacyRetirementStatus()`) |

Sources: [state store](../src/main/store.ts), [session export](../src/main/session-export.ts), [hook status](../src/main/hook-status.ts), [terminal pane](../src/renderer/components/terminal-pane.ts), [file tree](../src/renderer/components/file-tree.ts).
Per-launch retention policy: a directory is expired only when every timestamp it exposes is older than 30 days — the `.finevibe.json` sidecar's `createdAt`, the newest `*.jsonl` mtime, and the directory's own mtime (the last-activity proxy for pre-sidecar dirs and launches that never wrote a transcript). A resumed tab rewrites a fresh transcript, so its old sidecar never gets it deleted; a directory whose age cannot be established is kept. The sweep is armed by `ensureLaunchSessionDir()` — which every Pi/OMP start/resume calls — on a `setImmediate`, so the scan never runs on the spawn path (scout-2 P2); it uses `lstat` only (symlinked directories are skipped, never followed) and removes paths built by joining the provider base with a single `readdir` name, so it cannot escape its own base directory. Search visibility follows the same rule: a directory with no activity inside the window can only contain transcripts retention is about to delete, so it is filtered out before its sidecar is read. Scan bound: at most `PRUNE_SCAN_LIMIT = 200` dirs are examined per pass (`src/main/launch-session-dir.ts`) — an examined candidate costs ~5–6 sync syscalls (lstat + sidecar read + transcript readdir + per-jsonl lstat), so the bound sizes a bounded sweep, not a whole-tree walk; expired dirs past the bound converge over consecutive launches. On an over-limit base the names are first ordered by dir mtime ascending (`oldestDirsFirst`, one extra `lstat` per name, over-limit only), so the examined prefix is the deletion-candidate set and expired dirs can no longer hide in the unexamined tail past the cap; symlinks, non-dirs and vanished entries are parked behind the real dirs and never displace an examination slot. The unexamined tail is safe by the AND rule above: a dir with an in-window mtime is undeletable.


Legacy userData retirement (A3, copy → verify → retire): the migration stays copy-first, and
`retireLegacyUserData()` — called at startup right after `migrateLegacyUserData()` — closes
the lifecycle from the ledger. Every clean copy pass records
`{id, from, to, completedAt, fileCount, copiedBytes}` in
`userData/.finevibe-migrations.json`. Gates per record: 30-day grace from `completedAt`
(`RETIRE_GRACE_MS`), destination integrity (dest subtree file count ≥ the recorded count),
no `retire-legacy-user-data.off` opt-out in userData, the source strictly under appData (the
home tree `~/.vibeyard`, still read by the project importer, is never deleted), and a
verified record — a pre-ledger copy (`fileCount: -1`) is only reported `unverified`.
Removal is `fs.rmSync` recursive; every outcome (`removed`/`kept`/`unverified`/`error`,
`bytesFreed`, `reason`) appends to `userData/legacy-retirement.json` (FIFO-capped at 50
entries), read back by `getLegacyRetirementStatus()`. Covered by
`src/main/userdata-migration.test.ts` (retirement suite).

A4 sweep arming details: `startSessionRetentionSweeps(onDaily)` sweeps both provider bases
mirroring the per-launch `setImmediate` arm, re-arms on an unref'd 24-hour `setInterval`
(stop handle returned; main.ts passes `sweepEnumerationCaches` as the daily co-task), and
each pass runs the window sweep before the quota. The quota's eviction scan is bounded by
the same `pruneScanLimit` as the window sweep — an in-window dir mtime already makes a dir
undeletable, so the unexamined tail cannot hold candidates — and over-quota bases past the
bound converge over consecutive daily passes. The per-launch `ensureLaunchSessionDir()` arm
is unchanged.

Covered by `src/main/launch-session-dir.test.ts`.

### Cache governance

Every module-level `Map`/`Set` in `src/main` is process-lifetime, so it MUST be
**capped** (exported cap constant + LRU/FIFO eviction, the `fs-utils.ts` idiom
used by the B1 rows above), **teardown-bound** (every key dropped on
exit/destroy/stop), **transient** (in-flight promise/marker maps the operation
itself clears), or **bounded-by-construction** (keys from a small fixed set).
`src/main/module-map-governance.test.ts` enforces this: it scans `src/main`
for zero-indent collection declarations and fails on any collection without a
bound-class allowlist entry, so a new module-level `Map`/`Set` cannot land
without a reviewer recording its bound.

## Measured runtime baseline (W2, 2026-10-19, Windows)

The only measured runtime numbers this machine has for the app's hot paths, from the
2026-10-19/20 audit fleet's performance audit (W2Perf). Baseline: the `rebuild` tree at
`858d97c`, Windows 10.0.26300 (NTFS, real-time AV active), Node v24.14.0. Every row
below drove the real modules — bundled with esbuild, `electron` stubbed — except the
startup row, which ran the real Electron app in the dev tree (not packaged); no gate ran
concurrently, so no vitest contention. **The W2 harnesses themselves no longer exist**
(the agent workspace holding them was dissolved on 2026-10-21). Their periodic
successors — `dev/perf/s3-idle-growth.js`, `po06-watcher-cost.js`, `f2-codex-spike.js`,
`f3-pi-tick.js` (see *Periodic perf harnesses* in [dev/perf/README.md](../dev/perf/README.md)),
driven by [`.github/workflows/perf.yml`](../.github/workflows/perf.yml) weekly + on
dispatch against a built tree, results uploaded as artifacts, non-gating — re-measure
the S3 / F2 / F3 / PO-06 scenarios in the running app, so these rows are a baseline
with a rerun path, not a one-off snapshot.

| Metric | Measured | Conditions |
| --- | --- | --- |
| Pi/OMP poll tick, 200 tabs | 521.0 ms p50 / 1095.8 ms max every 2 s tick — 26% main-thread duty; 526.0 ms of it is 200 × `readSessionHeaderSync` (~2.07 ms each) | 200 exclusive per-launch dirs, one post-registration transcript each (steady state of a fresh launch); W2-01 |
| Pi/OMP poll tick, 50 tabs | 201.4 ms p50 / 896.1 ms max ≈ 10% duty | same shape at 50 tabs; W2-01 |
| Pi/OMP event-driven tick | 613.3 ms p50 at 200 tabs | transcripts appending, so ≥1 event scan/s on top of the poll; W2-01 |
| Pi/OMP tick, header-cache shape | 67.7 ms p50 at 200 tabs, 0 header reads/tick | the resume shape the W2-01 header-id cache produces (adopted file inside the generation snapshot) — measured as a shape, not a shipped fix |
| Watcher handles | 1 / 10 / 50 / 200 `fs.watch` handles at 1 / 10 / 50 / 200 tabs; idle handle ≈ 0 CPU, RSS Δ ≤ +2 MB across the sweep | one non-recursive watcher per exclusive dir; W2-02 |
| Registration synchronous listing | p50 5.1–8.5 ms, max 25.4 ms per registration; 200 serial registrations sum 1.3–1.6 s | at the syscall floor (`statSync` 113.5 µs, `readdirSync` 1 file 192.6 µs, open + 8 KiB read + close 1994.8 µs, full header read 2074.6 µs/op, 2000-op medians); PO-06 no-action row |
| Codex `.zst` meta scan, adversarial | 176.3 ms p50 / 203.5 ms max per 2 s scan, 20 decompressions, 64.5 MB decompressed, 130.8 ms decompression CPU, +108 MB RSS over 10 scans | 20 growing external `.jsonl.zst` rollouts (~3 MB body, ~30 KB compressed) re-compressed between scans, one tab whose cwd never matches; W2-03 |
| Store persist burst | 49 `saveState` calls at 200 ms → 0 writes for the full 10 s, 1 write after the burst; `writeStateAtomically` p50 4.76 ms / max 6.68 ms at 75,072 B | 200 sessions / 50 projects, renderer cadence modeled on the leading-edge 200 ms throttle; W2-04 |
| Deep search, hot query | 1598 ms with all 500 hot texts cached — 777 ms discovery + 1002 `fs.promises.stat` version checks (~1.5 ms each under AV); cold 5513 ms, warm 2039 ms, cancellation returns 1 ms after abort | 1002-file fixture (200 project dirs × 5 transcripts, 93.6 MB indexed, one ~10 MB and one ~70 MB file); W2-05 |
| First window | 4.97–7.07 s from process start, with `app.whenReady` at ~2.3 s; the gap is 2354 ms of synchronous per-provider CLI probes (codex 1427 ms) serialized before the window | real Electron app, dev tree, NOT packaged, 3 runs, probe via `--require`; W2-06 |
| Renderer bundle | 2.05 MB single unminified chunk — `@xterm/*` 750 KB (37%), gridstack 231 KB, project code 937 KB | esbuild metafile under the same flags as the `build:renderer` script (no minify, no split); W2-07 |

Reading the rows: the figures **predate the Wave A–D fixes**, so they are the pre-fix
baseline for behavior that the sections above now contract — see *Pi/OMP discovery and
remaining costs*, *Codex rollout attribution scan cost*, *Session search work and
storage* and *Static footprint audit (2026-10-18)* — and they are harness measurements
against the real modules, not measurements in the running app. **PO-06 stays open for
exactly that reason**: watcher cost in the running app (main-thread delay, RSS and
handle counts under a live window) has never been measured. The same audit's measured
no-action rows are cited here for the same reason and with the same caveat: registration
delay, idle watcher (0 fs calls), watcher RSS ≤ 2 MB, Codex meta cache 91% steady-state
hits with 0 steady decompressions, date-dir name pruning (365 fresh-mtime day-dirs →
1.4 ms/scan, 4 readdir, 1 stat), quit flush (no late write), `loadState` cache 0.04 µs
per hot call, store write rate ~0.7 MB/min, search cancellation 1 ms, the disk-index
warm tier (0 transcript re-reads) and `statusTailCache` at 512 entries (≤ 51 KB). The
live work stays open in *Measurement protocol for the live run* and *Evidence and open
measurement* below.

Sources: [Pi-compatible watcher](../src/main/pi-compatible-session-watcher.ts), [Codex session watcher](../src/main/codex-session-watcher.ts), [state store](../src/main/store.ts), [deep-search coordinator](../src/main/session-deep-search.ts), [startup order](../src/main/main.ts).

## Clipboard and paste baseline (P0, 2026-10-21, Windows)

First measured numbers for the terminal copy/paste path, from the P0 harness in `dev/perf/` (`dev/perf/clipboard-bench.js` = Electron main + hidden window replaying the `clipboard:readForPaste` sub-op order per scenario; `clipbench.ps1` + `hold.ps1` = raw Win32 clipboard contention; `dev/perf/pty-paste-probe.js` = node-pty ConPTY paste drain). Box: Windows 10.0.26300, Node 24.14.0, Electron 41.1.0 (Chrome 146), node-pty 1.1.0. Clipboard scenarios are set from a child process via raw Win32 `SetClipboardData` (WinForms delayed-rendered writes die at setup-process exit — a harness lesson, not an app cost). All numbers p50/max ms over 11 back-to-back passes. The plan's §6 claim that the Windows clipboard is unreachable from the agent shell is **disproven on this box**: `OpenClipboard` succeeds, every leg ran from the agent shell.

### Per-op clipboard reads (main process, per paste keystroke)

| Sub-op (ipc-handlers order) | empty | text-40B | text-100KB | text-1MB | rich-html | file-list | image-1080p | image-1440p |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| availableFormats | 0.008/0.083 | 0.009/0.021 | 0.009/0.027 | 0.011/0.020 | 0.011/0.024 | 0.008/0.025 | 0.026/0.030 | 0.029/0.070 |
| readText | 0.002/0.010 | 0.034/0.714 | 0.151/0.912 | 2.108/2.891 | 0.003/0.023 | 0.002/0.006 | 0.005/0.007 | 0.006/0.009 |
| readBuffer:FileNameW | 0.043/0.463 | 0.036/0.117 | 0.039/0.079 | 0.219/0.292 | 0.052/0.106 | 0.041/0.111 | 0.087/0.123 | 0.096/7.669 |
| readBuffer:CF_HDROP | 0.047/0.075 | 0.036/0.049 | 0.037/0.061 | 0.046/0.064 | 0.052/0.065 | 0.045/0.081 | 0.073/0.101 | 0.086/0.213 |
| readBuffer:NSFilenamesPboardType | 0.043/0.052 | 0.035/0.043 | 0.036/0.039 | 0.040/0.052 | 0.051/0.081 | 0.040/0.054 | 0.067/0.094 | 0.076/0.254 |
| read:text/uri-list | 0.040/0.048 | 0.034/0.054 | 0.034/0.048 | 0.035/0.061 | 0.048/0.085 | 0.037/0.059 | 0.052/0.083 | 0.066/0.152 |
| readImage | — | — | — | — | — | — | 66.84/126.71 | 118.94/246.52 |
| toPNG | — | — | — | — | — | — | 192.01/352.91 | 306.58/476.95 |
| writePastedFile | — | — | — | — | — | — | 1.92/3.41 | 1.98/13.73 |
| readHTML (empty-text only) | 0.035/0.055 | 0.002/0.039 | 0.001/0.004 | 0.003/0.004 | 0.109/0.126 | 0.032/0.045 | 0.571/0.937 | 1.103/1.318 |
| **handler total** | **0.222/0.768** | **0.185/1.033** | **0.306/1.136** | **2.484/3.362** | **0.334/0.379** | **0.206/0.341** | **261.3/483.7** | **420.7/740.6** |

Findings: (1) the six-open-sessions text path is cheap in isolation — a plain-text paste costs ≤ 1.1 ms p50 (≤ 3.4 ms max), a 1 MB text copy 2.5 ms, so R1's per-read `OpenClipboard` cycle costs sub-millisecond on an uncontended clipboard; (2) the **image** paste is the real main-thread freeze: `readImage` + `toPNG` are 96 %+ of the handler, 259 ms p50 at 1080p and 426 ms at 1440p (max 484/741 ms) — confirming the plan's zlib proxy model (214/403 ms) and adding `writePastedFile` (≈2 ms, ≤14 ms max); (3) `clipboard.readBuffer('CF_HDROP')` returns **0 bytes** under Electron on Windows even with a real `CF_HDROP` on the clipboard — Chromium maps the drop list onto `text/uri-list`, so the app's FileNameW branch is the live file-list path and the CF_HDROP probe is dead weight on Windows.

### OpenClipboard contention (the R1 number)

Second process (`hold.ps1`) holds `OpenClipboard` for 2.5 s (models `rdpclip.exe`); the bench then replays Chromium's 5 × `Sleep(5)` acquisition pattern:

| Scenario | 5 × 5 ms pattern | last Win32 error | unbounded quantification |
| --- | --- | --- | --- |
| text | acquired in-window = true | 0 | time-to-acquire 1.6 ms, 1 attempt |
| files (CF_HDROP) | acquired in-window = true | 0 | time-to-acquire 0.1 ms, 1 attempt |

**R1's acquire-retry freeze does not reproduce on this Windows build.** `OpenClipboard(IntPtr.Zero)` is not cross-process exclusive: a second process acquires while the holder holds, in one attempt. The real contention is one layer down — while the holder holds, a second process's **data reads fail** (`Get-Clipboard` → `ExternalException`, i.e. `GetClipboardData` refuses). The 25 ms-sleep-per-failed-acquire model and its 6-reads-≈-150 ms bound stay a code fact, not a measured cost here; the measured failure surface is a refused read, which the app swallows per-format in `clipboardFilePaths` today.

### ConPTY paste drain (node-pty, byte-echo child)

Payload `\x1b[200~` + N bytes + `\x1b[201~` written once to the PTY; child echoes every byte back through ConPTY.

| N | `write()` returns | echo drain | chunks | chunk min/med/max B |
| --- | --- | --- | --- | --- |
| 1 KB | 0.07 ms | (partial — settle swallowed first chunk) | 1 | 1024/1024/1024 |
| 10 KB | 0.07 ms | 10.4 ms | 6 | 22/1768/4176 |
| 100 KB | 0.18 ms | 147.2 ms | 87 | 14/792/4176 |
| 1 MB | 0.76 ms | 1661.7 ms | 1383 | 14/396/4224 |

`pty.write()` is a sub-millisecond async handoff at every size — the paste write itself never stalls the main thread. Drain scales ~linearly at ConPTY's console read granularity (max chunk ≈ 4.2 KB), so a 1 MB paste arrives back as ~1,380 `pty:data` IPCs (R4's per-chunk fan-out, measured). With `omp` as the child (R3): paste response arrives 178–300 ms after write in 23–24 output chunks, and the pasted marker never re-appears intact inside a single chunk — output is ANSI re-rendered frames, consistent with the win32-input-mode per-record re-encode model; a hard keydown→rendered-frame number needs ANSI-strip accumulation, left to the in-app `[paste-timing]` flag below.

### Opt-in instrumentation

`FINEVIBE_CLIPBOARD_TIMING=1` prints `[paste-timing]` (main: one line per `readForPaste` with every sub-op above, plus `saveImage`; renderer: paste-request → `readForPaste` reply → `pty:write` sent → first parsed PTY output, with per-interaction clipboard-read/write counts) and `[copy-timing]` (selection-change → clipboard write resolved) lines. Off is the default and byte-identical. The renderer gate reads `globalThis.__FINEVIBE_CLIPBOARD_TIMING__` (the preload/devtools injection point — `preload.ts` does not forward the env var yet) or `process.env` under vitest.

**Coverage:** Windows rows are measured. macOS and Linux (X11 + Wayland) rows for all three tables: **harness ready, pending a machine of that OS** — the Electron bench and PTY probe are cross-platform by construction; the ps1 contention harness is Windows-specific by design, its macOS (`pbcopy` busy-owner) and Linux (`SIGSTOP` owner) counterparts are user-executed checks (the CI matrix has no OS clipboard, and this agent box is Windows-only). `readImage`/`toPNG`/`writePastedFile` on the text scenarios are the handler's real skips, not missing runs.

Sources: [clipboard bench](../dev/perf/clipboard-bench.js), [contention harness](../dev/perf/clipbench.ps1), [PTY probe](../dev/perf/pty-paste-probe.js), [clipboard handlers](../src/main/ipc-handlers.ts), [paste renderer path](../src/renderer/components/terminal-utils.ts).

### Copy/paste plan results (P1–P5, 2026-10-21)

All five phases shipped behind automated, mocked-clipboard coverage. Rows that need a real OS clipboard are marked pending; the CI matrix (`macos-latest`/`ubuntu-latest`/`windows-2022`) runs the mocked platform branches. The Windows file-list decoder rows (`FileNameW`/`CF_HDROP` layouts in `ipc-handlers.test.ts`) are `runIf(win32)`-gated: the handler validates decoded paths with the running OS's `path.isAbsolute`, so they only execute on the Windows lane. This section supersedes one note above: `preload.ts` now forwards `FINEVIBE_CLIPBOARD_TIMING` into the sandbox at startup (P1), so the renderer gate works in the packaged app, not only under vitest.

| Phase | Shipped behavior | Automated evidence |
| --- | --- | --- |
| P1 | Plain-text paste goes through the native paste event on all three platforms: Windows `Ctrl+V` is no longer `preventDefault()`-ed, Chromium's paste event fires, and xterm writes `text/plain` itself — a plain-text paste performs **0 clipboard IPCs**. `clipboard:readForPaste` stays as the per-platform fallback (file-only copies, context-menu Paste, no-DataTransfer keystrokes). Preload forwards the timing flag. | `terminal-utils.test.ts` (no `readForPaste` call for a native text paste) |
| P2 | File-list probes are format-gated: `FileNameW`/`CF_HDROP` (Windows), `NSFilenamesPboardType` (macOS), `text/uri-list` (Linux) are each probed only on their platform AND only when `availableFormats()` advertises the format — **6 → 2 clipboard opens per plain-text paste** (P0 recorded acquire counts; P0 also showed 1-attempt acquires, so contention is not the freeze factor). An empty format list (Wayland permission denial) passes through to the passthrough flavor untouched. | `ipc-handlers.test.ts` (open-count 6 → 2 on mocked clipboard; empty-list passthrough) |
| P3 | Copy is fire-and-forget (`clipboard:write` is `ipcRenderer.send` — no per-selection promise round trip); a byte-identical `(text, source)` pair is skipped; a selection-driven copy past 256 Ki chars is deferred (explicit copies are never dropped). X11 PRIMARY invariant: only `selection`-source copies set PRIMARY, and the skip compares the pair, so an explicit→selection sequence of the same string still reaches main. | `ipc-handlers.test.ts` (one write per selection, PRIMARY invariants), `terminal-utils.test.ts` (budget, skip, pair semantics) |
| P4 | Pasted text is capped at 8 Mi UTF-16 characters; `textTruncated: true` makes the renderer show a pane banner (visible cut, never silent loss). Images per the plan's per-OS flavor table: a clipboard advertising `PNG`/`image/png` is read as bytes (memcpy — Windows Snipping Tool/Win+Shift+S register a PNG flavor, macOS lists `png`, X11 publishes `image/png`); a raw-image-only clipboard (CF_DIB/TIFF/BMP) pays `readImage()`'s main-only decode and the PNG encode now runs in the `src/main/png-encode-worker.ts` utilityProcess (P0: `toPNG` p50 192/307 ms at 1080p/1440p was the dominant main-thread freeze of a screenshot paste); worker fork/encode/exit/timeout failure degrades to the pre-P4 main-thread `toPNG()`, never a crash; a clipboard with no image flavor skips every image read (the Wayland-portal degrade). | `png-encode-worker.test.ts` (encoder + protocol), `ipc-handlers.test.ts` (PNG-flavor hit skips `readImage`, worker path, main-thread degradation, Wayland skip, 8 Mi cap + flag), `terminal-utils.test.ts` (banner) |
| P5 | Main coalesces `pty:data` per session: one message per 4 ms window capped at 64 KiB; a chunk that alone fills the budget ships immediately (the window degrades to a no-op — bulk output never gains latency), and `pty:exit` flushes the buffer before sending so the renderer never tears a pane down before its last data (P0: a 1 MB paste echo arrives as 1,383 chunks, median 396 B). Renderer: the fallback cost scan runs leading-edge + one trailing scan of the newest chunk per 1 s per session (the structured `session:costData` channel is the primary source and disables the fallback); the `Interrupted` scan is leading + trailing per 200 ms (`notifyInterrupt` is idempotent). | `ipc-handlers.test.ts` (window join, budget immediate-ship, flush-before-exit, per-session isolation), `session-cost.test.ts` (throttle, structured-disable) |

**Pending runtime checks (not runnable on this box):** P4's < 50 ms main-thread freeze target for a real 1080p/1440p screenshot paste (`dev/perf/clipboard-bench.js`), P5's ≥ 5× messages/sec reduction on the echo (`dev/perf/pty-paste-probe.js`), and the plan's §3 interactive rows — Explorer/Finder/Nautilus file copies, Linux middle-click, Wayland permission denial — on macOS, X11, Wayland, and packaged Windows. Recorded as coverage gaps in [FEATURES](FEATURES.md) §24.

## Measurement protocol for the live run

The static audit defines what the numbers must confirm. Launch with `--js-flags="--expose-gc"`; sample `process.memoryUsage()` (main, via `--inspect`) and `Get-Process FineVibe` working set (PowerShell, 60 s cadence, per-process rows) plus heap snapshots. Scenarios: **S1** 10 idle tabs → expect ≈ +0.2–0.4 MB/tab renderer, flat main; **S2** a ~100 MB output burst → renderer plateaus at scrollback capacity, main heap must not scale with the burst; **S3** 1 h idle with 10 live PTYs → growth < 5 MB/h (a linear rise implicates the 2 s pollers' per-file maps, `lastMtimes` first); **S4** open 50 sessions and close all → retained `Terminal`/`TranscriptSyncEntry`/reader counts return to baseline; **S5** state seeded with 5,000 history rows → time one persist, < 250 ms; **S6** export a session with a ≥50 MB `.events` sidecar → the main heap transient equals the buffered sidecar bytes (and collapses to chunk size once streaming lands). Record CSVs and snapshots under `bench/memory/<date>/`. Pass criteria: S3 < 5 MB/h, S4 within 10% of baseline, per-tab renderer cost within 2× the 240 KB estimate, S5 < 250 ms.

## Evidence and open measurement

Automated tests cover repeated search beyond the memory-cache budget, shared indexing/cancellation, growing diff files, split UTF-8 event records, oversized events, navigation within a 200,000-line file, and directory-cache invalidation.

The persist throttle (`ffcd283`) is covered by `src/renderer/state.test.ts`. Measurement note: mutations inside one 200 ms window coalesce to a single serialize + IPC (leading edge fires the first mutation immediately), so S5-style persist timing counts one persist per burst, not per mutation; a lone mutation never waits behind the window.

Still needed: run the measurement protocol above (S1–S6) in a packaged app, plus packaged preview/navigation checks and sustained terminal-output profiling. Passing unit tests does not establish a speedup percentage or complete the broader Pi/OMP integration audit.
