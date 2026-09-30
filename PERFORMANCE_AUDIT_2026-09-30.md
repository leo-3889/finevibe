# VibeYard speed and memory audit — 2026-09-30

Scope: current working tree, including existing uncommitted changes. Reviewed transcript search, session polling, hook event ingestion, terminal delivery, persistence, and file/Git rendering. This is a targeted code audit, not a complete runtime profile. The findings below preserve the pre-implementation evidence and line references.

## Implementation status

All seven findings have implementation changes in the working tree. [Performance and resource limits](docs/performance.md) is the current behaviour guide. The broader integration finding PO-06 is only partially addressed: synchronous registration scans, cached-filename iteration, native watcher allocation and live resource benchmarks remain.

Implemented changes:

| Finding | Implemented behaviour |
| --- | --- |
| P-01 | Workers score transcripts immediately and retain only compact results. Snippets and names are copied so string slices cannot keep entire transcript buffers alive. |
| P-02 | Palette edits/close, newer IPC searches and window destruction cancel obsolete work. Discovery observes cancellation. Index reads share in-flight promises and one four-operation budget across queries/providers. Already-started reads finish within that budget. |
| P-03 | A derived index under Electron's user-data directory, `search-index-v1`, stores one bounded record per source. Mtime, size and ctime validate reuse. Successful discovery prunes records for absent sources. Memory eviction no longer forces unchanged transcripts to be parsed again. |
| P-04 | Untracked diffs use asynchronous bounded reads; files exceeding 256 KiB or 5,000 lines, and files containing NUL bytes, receive an explanatory response. Growth after stat is also bounded. |
| P-05 | Hook events read in 64 KiB batches with scheduled continuation and partial UTF-8/JSONL preservation. Records over 64 KiB are skipped. Inspector retention is capped at 2,000 events and 2 Mi characters per session; bulk spread insertion is removed. |
| P-06 | File previews use pages of at most 2,000 lines and 128 Ki characters, with Previous/Next and distant go-to-line support. Search covers the current page. Long lines can be truncated; a notice makes the preview limits explicit. Markdown rendering uses the same bounded page. |
| P-07 | Pi/OMP registrations reference a shared per-root generation history instead of copying every path. Registration always refreshes its snapshot, including on coarse-mtime filesystems. During polling, directory mtimes and rename events invalidate cached listings; a 30-second reconciliation covers missed invalidations while the existing two-second polling remains. |

Regression evidence: the 1,000-transcript fixture is indexed once across repeated queries and a memory-cache reset; two overlapping searches share reads and never exceed four concurrent index operations. Tests cover bounded backlog draining, split UTF-8 appends, oversized records, file growth during diff reads, 200,000-line DOM navigation, IPC cancellation, and cached-directory invalidation.

Validation: the final full suite passed 161 files / 2,231 tests with one skipped. The build, renderer TypeScript check and git diff whitespace check pass. No live Electron heap/CPU benchmark or packaged-app interaction was performed. The terminal-output observation remains a profiling suggestion, not one of the seven implemented findings. The derived disk index scales with source history; only the in-memory cache has a fixed aggregate budget.

## Historical findings, in original priority order

### P-01 — High: search retains every indexed transcript despite the cache budget

Evidence: `src/main/session-deep-search.ts:115-122`; `src/main/providers/transcript-utils.ts:39-45`.

`mapWithConcurrency` stores all results until indexing finishes. Each result retains the original and lowercased transcript text. Evicting an entry from the 8 Mi-character cache cannot release text still referenced by this array. Even a query matching nothing retains the whole indexed corpus before scoring starts. The `best` map subsequently retains matching entries too; the final 20-result limit is applied only after all providers finish.

At 1,000 transcripts of 51,200 characters, this represents 102,400,000 retained text characters across the two forms, before other allocations. This is a logical payload calculation, not a measured V8 heap figure; string representation and sharing affect physical memory.

Fix: score each entry inside the bounded worker, immediately produce a compact result containing only score, snippet, name and identity, and release its text reference. Preserve duplicate-session selection using compact results. Apply a bounded top-result selection where compatible with deduplication.

Verify: compare peak heap for 100, 1,000 and 10,000 transcripts using a nonmatching query; text retention should follow the cache and worker budgets rather than corpus size.

### P-02 — High: obsolete searches continue and multiply I/O

Evidence: `src/renderer/components/session-search-palette.ts:129-161`; `src/main/ipc-handlers.ts:458`; `src/main/session-deep-search.ts:115,146`.

The renderer's token discards stale responses but does not stop backend work. A new query after the 400 ms debounce starts another full discovery/index pass while the previous pass can still be running. Closing the palette also leaves that work running. The four-worker limit is per provider per invocation; there is no shared budget or in-flight indexing deduplication.

Reproduction using the actual search implementation, actual concurrency helper, and mocked discovery/filesystem: two simultaneous searches over 1,000 transcripts for one provider performed 2,000 index calls, with eight index operations active at once.

Fix: propagate a request generation/cancellation signal through discovery and indexing, stop scheduling obsolete work, share in-flight index promises by file/version, and enforce a shared I/O budget across requests/providers. Cancellation must not abort an index operation still needed by another request.

Verify: rapid query changes and palette close stop obsolete work; shared reads happen once and aggregate concurrency stays bounded.

### P-03 — Medium: full-history scans can defeat the LRU cache on every query

Evidence: `src/main/session-deep-search.ts:9-12,40-64,115-118`.

Every query traverses the corpus again. When it exceeds the cache budget, a repeated traversal in the same order loads the early files and evicts later files before reaching them. This creates cache thrashing even when no transcript changed.

Reproduction using the actual search implementation with 1,000 stable descriptors, unchanged mtimes and 51,200-character indexed texts: first query made 1,000 index calls; the identical second query also made 1,000. This measured call counts, not disk timing.

Fix: maintain an incremental searchable index, preferably persisted, and reindex only changed transcripts. For a smaller interim change, process cached descriptors before misses so misses do not evict entries this query has yet to use. Increasing the cache alone merely moves the threshold.

Verify: a repeated query over a corpus larger than the text cache avoids reparsing unchanged transcripts, while edits/deletions still update results.

### P-04 — High: untracked-file diffs read and expand arbitrarily large files

Evidence: `src/main/git-status.ts:90-102`; direct IPC route at `src/main/ipc-handlers.ts:641`.

The untracked branch uses `readFileSync`, splits the entire file into lines, prefixes every line, and joins another full string. It has neither the normal file reader's 8 MiB limit nor the tracked-diff subprocess output limit. Selecting a large untracked log, export or binary therefore blocks the main process and creates several large allocations before the result crosses IPC.

Fix: inspect size/type before reading and return a bounded preview or an explicit too-large result. Use bounded asynchronous reads and cap lines/output bytes as well as input bytes. Preserve the existing tracked-diff behavior.

Verify: a large untracked text/binary file receives a bounded response without full-file allocation; normal small-file diffs remain correct.

### P-05 — High: hook event catch-up allocates the whole unread backlog

Evidence: `src/main/hook-status.ts:306-332`; `src/renderer/session-inspector-state.ts:5-18`.

The event reader allocates `stat.size - offset`, synchronously reads that entire region, decodes/splits/parses every event, and sends the full array over IPC. A large append or resync with a zero offset causes a main-thread stall and allocation spike. The renderer's 2,000-event cap is applied after receipt and after `existing.push(...events)`, so it does not bound ingestion memory; sufficiently large arrays can also exceed spread argument limits. Event count alone does not bound the bytes in tool payloads.

Fix: use bounded byte/line batches, retain partial JSONL records, schedule continuation without relying on another file-change event, and bound event payloads and IPC batches. Keep only the needed recent events during ingestion, before bulk insertion into renderer state.

Verify: backlog catch-up has bounded allocations, partial records survive between batches, and oversized payloads have an explicit truncation policy.

### P-06 — Medium: text viewer builds the full DOM for every line

Evidence: `src/renderer/components/file-reader.ts:47-70,156`; file-byte limit at `src/main/ipc-handlers.ts:819`.

Raw rendering creates one div and two spans for every line synchronously. A 200,000-line file consisting of `x` plus newline is only about 0.4 MB, but produces roughly 600,000 elements. It passes the 8 MiB read limit while imposing substantial DOM allocation, layout and search costs. Refreshing the file repeats the work.

Fix: virtualize visible lines with overscan and a line-offset index, or initially enforce a line-limited preview. Search should operate on text/line offsets and materialize only the selected match; preserve go-to-line behavior.

Verify: opening, scrolling, searching and reloading a 200,000-line file keeps the rendered element count bounded by the viewport.

### P-07 — Medium: Pi/OMP discovery repeatedly enumerates all history and duplicates snapshots

Evidence: `src/main/pi-compatible-session-watcher.ts:168-180,239-266,327-333,389-393`.

Each pending session synchronously snapshots every transcript path under its provider root into its own `knownFiles` set. With S live sessions and N historical files, retained snapshot entries scale as O(S × N). The two-second fallback still enumerates all project directories and their files while sessions remain watched, including adopted sessions needed for `/clear` discovery. Filename freshness filtering reduces header reads but happens after directory enumeration, so it does not eliminate the repeated history walk.

Fix: share a per-root discovery index, record per-session registration generations rather than complete independent path sets, and update candidate directories from watcher events. Keep a paced reconciliation scan for missed events. Preserve the existing same-cwd isolation, registration snapshot semantics and `/clear` adoption rules.

Verify: multiple sessions sharing a large root do not duplicate full-history snapshots; idle directory enumeration falls substantially while late files, profile roots and `/clear` remain discoverable.

## Validation and limits

- Focused Vitest run: **6 files passed, 152 tests passed** (`session-deep-search`, `hook-status`, `git-status`, `session-transcript-sync`, `pi-compatible-session-watcher`, renderer `session-inspector-state`). The initial sandbox attempt failed to start Vite with `spawn EPERM`; the permitted retry passed.
- Search reproductions executed the current TypeScript implementation in memory with mocked filesystem/provider inputs; no transcript contents or user files were read by those reproductions.
- P-02 and P-03 have synthetic call-count evidence. Other findings follow reachable code paths and allocation structure; no live Electron heap, frame-time or CPU measurements were collected.
- Existing fixes were accounted for: bounded normal file reads, transcript text/cache limits, per-provider indexing concurrency, transcript-path caching/backoff, watcher cleanup, and coalesced cost persistence. These do not close the separate gaps above.
- Terminal output also forwards each PTY chunk directly to IPC and xterm without application-level acknowledgements (`pty-manager.ts:325`, `ipc-handlers.ts:214`, `terminal-pane.ts:446`). Profile a sustained-output workload before deciding whether batching and producer backpressure warrant a separate change; no queue growth was measured here.

Original implementation recommendation (before the changes above): P-01/P-02 together for search responsiveness and peak memory, followed by P-04/P-05 for bounded main-process ingestion. Address P-03 for large histories, then P-06/P-07 for large files and many sessions. No speedup percentage is claimed without before/after workload measurements.
