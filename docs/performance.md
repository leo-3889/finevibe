# Performance and resource limits

These behaviours apply to the current source working tree. They have build and automated-test coverage; packaged-app performance has not been measured. See [audit status](AUDIT_STATUS.md) for recorded validation and remaining work.

## File previews and search

The file reader accepts text files up to 8 MiB. It displays a bounded page instead of building a document for every line at once. Use Previous, Next, or raw-view go-to-line to reach another part of the file.

| Surface | Limit | What the user sees |
| --- | --- | --- |
| Text and Markdown preview | Page budget of 2,000 lines or 128 Ki characters | A partial-preview notice and navigation controls. Long lines may be cut short. Rendered Markdown can end inside a block at a page boundary. |
| Find within a file preview | Displayed page only | Matches outside the current page are not searched. Change pages to search another section. |
| Untracked Git diff | 256 KiB and 5,000 split lines | An explanatory message instead of an oversized diff. Files containing NUL bytes receive a binary-file message. |
| Global session search | Best 20 results; indexed text capped at 50 Ki characters per transcript, join separators included | Results search extracted user text, not every byte of a conversation. |
| Pasted clipboard image | 25 MiB decoded; PNG, JPEG, GIF, WebP, BMP, TIFF | An oversized or unsupported image attaches nothing: the paste is silent. Saved images live in `os.tmpdir()/vibeyard-paste` and files older than a day are pruned. |

`KiB` means 1,024 bytes. Character budgets use JavaScript string length (UTF-16 code units), not bytes or displayed symbols. These limits are code constants, not Preferences settings.

Sources: [file read and clipboard paste boundaries](../src/main/ipc-handlers.ts), [preview paging](../src/renderer/file-preview.ts), [file reader](../src/renderer/components/file-reader.ts), [Git diffs](../src/main/git-status.ts), and [transcript index limits](../src/main/providers/transcript-utils.ts).

## Session search work and storage

Editing the search query, closing the palette, starting a newer search in the same window, or destroying that window cancels obsolete work. Discovery checks the abort signal. Gemini discovery stats each transcript, skips files above the indexer's 64 MiB file limit, and extracts the session ID from a bounded 64 KiB header read instead of loading whole transcripts. Workers stop scheduling new indexing when cancelled; already-submitted reads can finish and populate the cache. Concurrent requests share in-flight reads and a four-operation indexing budget. This budget does not describe every filesystem operation in discovery or the rest of the app.

Workers score each transcript immediately and retain compact results. Result snippets and names are copied so short string slices cannot retain whole transcript strings. The text cache holds at most 500 entries and 8 Mi characters in total, counting original and lowercase forms together. These payload budgets are not a measurement of total application heap usage.

The derived disk index lives at:

```text
<Electron userData>/search-index-v2/<provider>/<SHA-256-of-source-path>.json
```

The index contains extracted user text, its working directory and source version metadata. It is local plaintext data; hashed filenames do not encrypt its contents. Source mtime, size and ctime determine reuse. Each record's text is capped at 50 Ki characters, and its serialized JSON must fit within 332 KiB. Records for sources absent from a completed, uncancelled provider discovery/index pass are pruned. A cancelled pass can leave them until a later completed pass. A pass whose discovery reported an incomplete scan root (`TranscriptDiscovery.complete` false, P2-70) counts as not-completed for pruning: its records survive untouched, because a root that failed to list is not evidence its transcripts are gone (see [provider contracts](provider-contracts.md)).

Disk usage scales with history; there is no fixed aggregate disk quota. Eviction from the in-memory cache does not require reparsing an unchanged transcript when its disk index remains valid. Search still performs discovery and reads index records, so it is not free of filesystem work.

To rebuild the index, close VibeYard and remove only `search-index-v2` from its Electron user-data directory. The next search rebuilds the required entries. This does not delete provider transcripts or the separate `~/.vibeyard/state.json` file. There is currently no in-app cache-clear control. Developers must change the index directory version when extraction semantics change.

Sources: [search coordinator](../src/main/session-deep-search.ts), [disk index](../src/main/session-search-index.ts), [IPC cancellation](../src/main/ipc-handlers.ts), and [palette](../src/renderer/components/session-search-palette.ts).

## Inspector event retention

Hook `.events` files are read in at most 64 KiB of new bytes per turn. Unfinished lines remain buffered, including partial UTF-8 sequences. Backlogs schedule further reads without requiring a new file notification. Individual JSONL records over 64 KiB are skipped through their next newline; malformed complete records are also skipped. The reader resets when the file becomes shorter than its current byte offset.

The renderer keeps the newest events within both a 2,000-event limit and a 2 Mi-character budget per session, measured using serialized JSON length. Individual renderer events over 64 Ki characters are skipped. Oldest events are removed first. The inspector is a bounded recent-history view, not a complete event archive. These retention limits do not rotate the source event file; session cleanup removes its hook files and pending continuation state.

Sources: [event reader](../src/main/bounded-event-reader.ts), [hook lifecycle](../src/main/hook-status.ts), and [inspector state](../src/renderer/session-inspector-state.ts).

## Pi/OMP discovery and remaining costs

Pi/OMP launches use an exclusive session directory for transcript ownership. Live registrations share one filename/generation history per watched directory. Each registration records its generation instead of retaining its own complete filename set. Registration still takes a fresh synchronous listing so pre-existing transcripts remain excluded even on filesystems with coarse timestamps.

During polling, unchanged directory listings are reused. Directory mtime changes and watched rename events invalidate listings; the next scan also refreshes a listing after its 30-second cache lifetime. The two-second poll remains in place. Polling still visits cached filenames and checks directory metadata. Root history is released when no registration uses it.

When a transcript's last meaningful entry does not fit the 16 Ki status window, a bounded 4 MiB fallback read parses it (a search dump larger than the old 1 MiB bound left tab status frozen on its last value, because the derived null suppressed writes); entries beyond the fallback yield no status and the status stays at the last value written. The derived status is cached with the file size and reused while the size is unchanged. That cache is an LRU capped at 512 paths (`MAX_STATUS_TAIL_CACHE`): reads and writes move a path to the newest position and writes past capacity evict the oldest, so a closed session whose oversized final entry never yields a status again cannot pin an entry for the process lifetime. `loadState()` likewise serves the parsed `state.json` from an in-memory cache, refreshed by every save path; anything that rewrites the state file behind `saveState()`/`saveStateSync()` must call `invalidateStateCache()` first.

This removes duplicate per-session snapshots and reduces idle directory enumeration. The per-launch directory and known resume ID address the earlier cross-tab attribution paths in code. Registration scans still run on the main thread, and watcher allocation and runtime resource use have not been measured at scale: real main-thread delay, RSS and watcher-handle counts in the running app have never been measured — every bound in this document is a code constant verified by unit tests on Windows, not a measured runtime cost. **PO-06 remains partially addressed.** See the [audit status](AUDIT_STATUS.md) for the next measurement and validation work.

Sources: [Pi-compatible watcher](../src/main/pi-compatible-session-watcher.ts), [fallback status reader](../src/main/providers/pi-compatible-transcripts.ts), and [state store](../src/main/store.ts).

## Codex rollout attribution scan cost

For hookless Codex tabs, `src/main/codex-session-watcher.ts` scans `~/.codex/sessions/YYYY/MM/DD/` for rollouts to attribute to pending tabs: `fs.watch` events are coalesced into at most one scan per 500 ms, and a 2 s poll fallback keeps scanning while any tab is pending. Four bounds keep a scan cheap:

- Parsed `session_meta` is cached per path (`metaCache`, capped at `MAX_META_CACHE_ENTRIES = 256`, oldest evicted first, `src/main/codex-session-watcher.ts:68-69`) and invalidated by `(mtimeMs, size)`, so a rollout is read once per change, not once per scan. Before the cache, every scan re-read and re-decompressed every rollout in today's directory up to twice a second for the whole life of a pending tab.
- A `.jsonl.zst` meta read touches at most a 256 KiB compressed prefix (`META_PREFIX_BYTES`, `:55`) through a head-only read (`readHead`, `:116-124`) — the whole file is never materialized. `session_meta` is the FIRST line of the zstd frame, so the prefix decodes to it, and a rollout mid-append can end mid-frame: a cut frame decodes the blocks it already holds (Node's sync zstd returns the partial output, `:225-229`).
- When the prefix yields no usable meta line, `scheduleFullDecode` (`:154-205`) streams the file through the zstd decoder off the pairing path, stops at the first newline or `META_READ_BYTES` (64 KiB, `:47`) of decompressed output (`:195-202`), and publishes the result — nulls included — into `metaCache` for the file's `(mtime, size)`, so a rollout version decodes once, never once per scan (`:158-168`, `:230-231`). The scheduling scan returns null (the tab stays pending); the 500 ms/2 s cadence picks the cached meta up. `MAX_COMPRESSED_META_FILE_BYTES` (8 MiB compressed, `:59`) gates this fallback (`:222`); the plain `.jsonl` path stays bounded to the 64 KiB head (`:220`).
- The tree is zero-padded `YYYY/MM/DD` and the walk is newest-first, so year/month/day directories whose names sort below the oldest pending registration (minus the 60 s `MTIME_SKEW_MS` window) are pruned by name — no stat, no readdir. A day directory that survives name pruning and has an older mtime costs one stat. A scan is O(recent days) no matter how much Codex history exists on disk.

Honest bound: these are structural removals of repeated I/O, verified by `src/main/codex-session-watcher.test.ts` (meta parsed once per change, bounded prefix reads counted inside the `fs` mock; day pruning by name). The measured cost in a running app — scan wall-time against years of history, decompression peaks, watcher handles — remains unmeasured, like the Pi/OMP numbers above.

Sources: [Codex session watcher](../src/main/codex-session-watcher.ts).

## Static footprint audit (2026-10-18): growth structures

A full static audit of main + renderer verified every bound above against source and found the registry/watcher/pane layers correctly bounded: no main-side PTY output buffering, no per-spawn listener accumulation, no watcher or polling retention for closed sessions, streaming launcher download, one-shot child processes reaped synchronously, and singleton timers only (four 2-second pollers, each a no-op while its registry is empty). The remaining structures that grow without a code cap:

| Structure | Location | Growth | Planned fix |
| --- | --- | --- | --- |
| `PersistedState.projects[].sessionHistory` | `src/shared/types.ts`, rows created for every session at spawn | soft cap 500, but bookmarked and `active` rows are exempt from pruning, so a crash orphaned `active` row and bookmarks accumulate without limit; the dominant term in every full-state save | retain-last-K bookmarks (~50) and expire stale `active` rows whose session no longer exists |
| Renderer persist burst | `src/renderer/state.ts` `persist()` → `src/main/store.ts` `saveStateSync` | fixed `ffcd283`: each persist serializes the whole state and structured-clones it over IPC, and mutation bursts (kanban sync, session moves, title adoption) used to pay that per mutation | leading-edge 200 ms throttle coalesces a burst to one IPC, `beforeunload` flushes; the store's per-save transient (object graph + JSON string + Buffer, ~2–3× payload) remains, capped by the history fix |
| Zip export sidecars | `src/main/session-export.ts` `readSidecars` | all sidecar files, `.events` included, buffered whole; the source `.events` file has no size cap on disk (64 KiB is the read budget, not the file size) | stream each sidecar with `createReadStream`, as the transcript already is |
| xterm scrollback | all three `new Terminal({...})` sites | library default 1,000 lines/tab (~240 KB UTF-16 at 120 cols) — a bound by omission | set `scrollback` explicitly as a documented constant |
| `hook-status` `lastMtimes` | `src/main/hook-status.ts` | rows for one-shot files (e.g. `.toolfailure`) linger after the file is unlinked, until session cleanup | delete the row when the file is unlinked; sweep names absent from `readdir` |
| Push-only listener arrays | `sharing/share-manager.ts`, `session-inspector-state.ts` | no public unsubscribe; latent (today one module-scope caller each) | return unsubscribe closures, the pattern `state.ts` already uses |
| File-tree directory cache | `src/renderer/components/file-tree.ts` `entryCache` | one entry list per directory expanded during the session, freed only on collapse/project removal | LRU cap (~2,000 directories) |
| `ProjectRecord.githubLastSeen` | `src/shared/types.ts` | one entry per viewed PR/issue, forever | age-prune |
| Per-launch session dirs | `src/main/launch-session-dir.ts` (`<userData>/pi-sessions`, `<userData>/omp-sessions`) | fixed: one directory per Pi/OMP start/resume, never removed — unbounded on disk, and `listLaunchSessionDirs()` cost one `stat` + one sidecar `readFile` per directory on EVERY global session search (~2,000 synchronous syscalls per search at 1,000 tabs) | 30-day retention window (`LAUNCH_SESSION_RETENTION_MS`), swept once per provider base per process at the first launch, capped at 2,000 directories per pass; the same age filter now gates the search listing |

Sources: [state store](../src/main/store.ts), [session export](../src/main/session-export.ts), [hook status](../src/main/hook-status.ts), [terminal pane](../src/renderer/components/terminal-pane.ts), [file tree](../src/renderer/components/file-tree.ts).

Per-launch retention policy: a directory is expired only when every timestamp it exposes is older than 30 days — the `.vibeyard.json` sidecar's `createdAt`, the newest `*.jsonl` mtime, and the directory's own mtime (the last-activity proxy for pre-sidecar dirs and launches that never wrote a transcript). A resumed tab rewrites a fresh transcript, so its old sidecar never gets it deleted; a directory whose age cannot be established is kept. The sweep runs inside `ensureLaunchSessionDir()`, which every Pi/OMP start/resume calls before spawning the CLI, uses `lstat` only (symlinked directories are skipped, never followed) and removes paths built by joining the provider base with a single `readdir` name, so it cannot escape its own base directory. Search visibility follows the same rule: a directory with no activity inside the window can only contain transcripts retention is about to delete, so it is filtered out before its sidecar is read. Scan bound: at most `PRUNE_SCAN_LIMIT = 2000` dirs are examined per pass (`src/main/launch-session-dir.ts:58,126`); on an over-limit base the names are first ordered by dir mtime ascending (`oldestDirsFirst`, `:157-171` — one extra `lstat` per name, over-limit only), so the examined prefix is the deletion-candidate set and expired dirs can no longer hide in the unexamined tail past the cap; symlinks, non-dirs and vanished entries are parked behind the real dirs and never displace an examination slot (`:164-170`). The unexamined tail is safe by the AND rule above: a dir with an in-window mtime is undeletable.

Covered by `src/main/launch-session-dir.test.ts`.

## Measurement protocol for the live run

The static audit defines what the numbers must confirm. Launch with `--js-flags="--expose-gc"`; sample `process.memoryUsage()` (main, via `--inspect`) and `Get-Process Vibeyard` working set (PowerShell, 60 s cadence, per-process rows) plus heap snapshots. Scenarios: **S1** 10 idle tabs → expect ≈ +0.2–0.4 MB/tab renderer, flat main; **S2** a ~100 MB output burst → renderer plateaus at scrollback capacity, main heap must not scale with the burst; **S3** 1 h idle with 10 live PTYs → growth < 5 MB/h (a linear rise implicates the 2 s pollers' per-file maps, `lastMtimes` first); **S4** open 50 sessions and close all → retained `Terminal`/`TranscriptSyncEntry`/reader counts return to baseline; **S5** state seeded with 5,000 history rows → time one persist, < 250 ms; **S6** export a session with a ≥50 MB `.events` sidecar → the main heap transient equals the buffered sidecar bytes (and collapses to chunk size once streaming lands). Record CSVs and snapshots under `bench/memory/<date>/`. Pass criteria: S3 < 5 MB/h, S4 within 10% of baseline, per-tab renderer cost within 2× the 240 KB estimate, S5 < 250 ms.

## Evidence and open measurement

Automated tests cover repeated search beyond the memory-cache budget, shared indexing/cancellation, growing diff files, split UTF-8 event records, oversized events, navigation within a 200,000-line file, and directory-cache invalidation.

The persist throttle (`ffcd283`) is covered by `src/renderer/state.test.ts`. Measurement note: mutations inside one 200 ms window coalesce to a single serialize + IPC (leading edge fires the first mutation immediately), so S5-style persist timing counts one persist per burst, not per mutation; a lone mutation never waits behind the window.

Still needed: run the measurement protocol above (S1–S6) in a packaged app, plus packaged preview/navigation checks and sustained terminal-output profiling. Passing unit tests does not establish a speedup percentage or complete the broader Pi/OMP integration audit.
