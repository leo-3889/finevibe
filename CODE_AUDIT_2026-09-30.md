# Current code audit — 2026-09-30

Status: resolved in the working tree. This follow-up examined the current uncommitted working tree after the performance implementation. It traces search discovery/indexing/persistence, profile-to-tab mapping, Git file operations, preview paging and event ingestion. It is a targeted audit, not an exhaustive review of every module or a live Electron performance profile. All four findings are fixed; see [Resolution](#resolution-2026-09-30).

## R-01 — P2: search results change after loading the persisted index

**Locations:** `src/main/session-search-index.ts:45`; `src/main/session-deep-search.ts:75-78`; `src/main/providers/gemini-provider.ts:257-262`. The same separator accounting pattern is present in Claude and Pi-compatible indexers.

Providers count message text against the 50 Ki-character budget, then join messages with `\n---\n` without charging those separators to the budget. The resulting text can exceed 51,200 characters. The first search scores that full text, but `writeSearchIndex` silently slices it to 51,200 before saving. Reloading that disk entry after memory eviction or restart therefore searches a different string even though the transcript has not changed.

**Reproduction:** the actual Gemini indexer produced 54,951 characters from 999 user messages of 50 characters plus a final `needle` message. The actual search coordinator found one match before its memory-cache reset and zero afterward, using the actual disk-index implementation in a temporary directory. This is a semantic mismatch, not a timing measurement.

**Required fix:** enforce a single final-text budget, including separators, before either cache or scoring sees the text. Make first-read, memory-hit and disk-hit behaviour identical. Version or invalidate persisted records if extraction semantics change.

**Acceptance:** the same query produces the same results before and after memory eviction/app restart for many short messages and a boundary-length message. Assert final serialized index text length as well as cumulative message length.

## R-02 — P2: search identity ignores provider/profile boundaries

**Locations:** `src/main/session-deep-search.ts:149-158`; `src/renderer/components/session-search-palette.ts:54-65,160,243-249`.

Backend deduplication keys only on `cliSessionId` within a provider. The renderer also maps active and archived sessions solely by that ID, without provider or profile. If a history is copied/imported into two profiles, both may legitimately contain the same session UUID. One backend result disappears; a result for one profile can then acquire another profile's active-tab or archive identity. Opening it selects that other tab, or resumes the matched archive with its own binding instead of the result's binding. An identical ID across providers can also collide in the renderer.

**Reproduction:** two descriptors with the same ID and different profile IDs yielded only one search result. Running the actual palette mapping against two corresponding active tabs mapped the shared ID to the second tab regardless of the result's profile. The harness exercises mapping directly; it does not send input to a CLI or use real accounts.

**Required fix:** define and consistently use a composite identity containing provider, profile (including a stable default-profile representation), and CLI session ID. Preserve same-profile deduplication for duplicate project-slug copies where intended. Include any further project disambiguation required by the resume contract.

**Acceptance:** copied histories in two profiles remain separately discoverable. A result opens/resumes only the matching provider/profile identity, with tests for active and archived sessions and cross-provider ID collisions.

## R-03 — P1: Gemini discovery bypasses the transcript read limits

**Locations:** `src/main/providers/gemini-provider.ts:204-215`, contrasted with the later size check at `:226-236`; discovery is awaited before indexing in `src/main/session-deep-search.ts:140`.

`discoverTranscripts` calls `readFile` for every matching session JSON file to extract its ID. It does not check file size, read a bounded header, or use the persisted text index. Consequently, every search reads whole Gemini transcripts before the indexer's 64 MiB exclusion can run. A transcript larger than that limit still allocates its full contents during discovery. Repeated searches and cancelled searches already inside `readFile` retain this cost; the abort signal is checked between files, not passed into the active read.

**Reproduction:** two calls to the actual discovery method, with mocked directory/file I/O, made two whole-transcript `readFile` calls and no stat calls. The fixture was small; no oversized real transcript or heap-exhaustion test was performed. The missing bound and repeat-read path are confirmed by code and call counts.

**Required fix:** derive discovery metadata with a bounded reader/parser or a validated metadata cache. Apply size/read limits before allocating transcript contents, and make cancellation effective for active I/O where supported. Handle IDs outside the initial window explicitly rather than silently assuming every valid file has one particular field order.

**Acceptance:** discovering a file larger than the indexing limit never reads it in full. Repeated unchanged-history discovery avoids full-transcript reads. Cancellation stops further work and handles already-active reads without unbounded allocation.

## R-04 — P2: Git-quoted filenames are used as literal paths

**Locations:** `src/main/git-status.ts:133-170`; consumers include `getGitDiff` at `:90-91` and untracked discard at `:235-238`.

`git status --porcelain=v2` is requested without NUL-delimited output. Git can quote and escape non-ASCII or special filename bytes. The parser fixes space handling but never decodes these Git path strings. It therefore passes the quotes and octal escapes to file reads and Git operations. For untracked discard, `force: true` can resolve successfully despite leaving the intended file untouched because the constructed filename does not exist.

**Reproduction:** a real disposable repository with `core.quotePath=true` and `café.txt` returned the path `"caf\303\251.txt"`. Passing that result to the actual diff reader returned `(unable to read file)`. No user repository was modified and no user file was discarded. Discard impact is code-path analysis, not a destructive reproduction.

**Required fix:** request and parse `--porcelain=v2 -z` with its documented record structure, including the separate original pathname for renames, or implement complete Git quoting/byte decoding. Disabling `core.quotePath` alone does not cover every special character.

**Acceptance:** Unicode names, tabs/newlines where the platform permits them, spaces and renames round-trip from status to diff/stage/unstage/discard without path corruption. Include a real temporary-repository test, not only hand-authored porcelain fixtures.

## Resolution (2026-09-30)

All four findings are fixed in the working tree with regression tests:

- **R-01:** `IndexTextBudget` (`src/main/providers/transcript-utils.ts`) charges the join separator at push time, so the final joined text is provably within the 50 Ki-character cap in all five indexers (Gemini, Claude, Codex, Copilot, Pi-compatible). The persisted-index directory was bumped to `search-index-v2`, invalidating old-semantic records.
- **R-02:** Backend deduplication keys on profile + cliSessionId (provider is already scoped per search), and the palette maps tabs/archives with `sessionIdentityKey(providerId, profileId, cliSessionId)`, so a result opens only its own provider/profile identity.
- **R-03:** Gemini discovery stats each transcript, skips files above the indexer's 64 MiB limit, and extracts the session ID from a bounded 64 KiB header read (full-read fallback only for in-limit files).
- **R-04:** `getGitFiles` parses `git status --porcelain=v2 -z` (NUL-delimited records, raw unquoted paths); Unicode, space and rename paths round-trip to diff/stage/unstage/discard.

Regression tests: `session-search-pipeline.test.ts`, `session-search-palette.test.ts`, updated `session-deep-search.test.ts`, `session-search-index.test.ts` and `gemini-provider.search.test.ts`, plus `git-status.test.ts` and the new real-temp-repository `git-status.real.test.ts`. The standalone harness described below was removed; the permanent tests cover the same scenarios.

## Reproduction and scope limits

The standalone reproduction harness (`docs/audits/current-code-repro.cjs`) loaded current TypeScript source in memory, injected fixture dependencies, and used a dedicated temporary directory for disk-index and real-Git checks. Its assertions intentionally confirmed the defects above: a passing harness meant the findings reproduced, not that the application was fixed. It was outside the normal test suite. The initial sandbox run reproduced R-01 through R-03 but could not spawn Git (`EPERM`); the permitted retry reproduced all four and cleaned up its temporary fixture directory. After the fixes, the harness was removed and its scenarios moved into the permanent regression tests listed in [Resolution](#resolution-2026-09-30).

The existing broader Pi/OMP findings retain their separate disposition in [audit status](docs/AUDIT_STATUS.md). They were not reclassified or fixed here. No authenticated-provider test, packaged-app interaction, live heap/RSS benchmark or full-repository correctness claim is made.

## Validation in this audit

- Existing focused tests: 80 passed in six files. The combined run exited with an infrastructure error because the file-reader worker did not start before its timeout.
- Isolated file-reader retry with one worker: 10 tests passed. Across those runs, all 90 selected tests passed; the initial worker timeout is retained here rather than described as a clean combined run.
- Standalone defect harness: all four reproductions confirmed, including real disk-index reload and real Git quoting in disposable fixtures.
- Local report/status links and `git diff --check`: passed. No full build or full-suite rerun was performed in this findings-only audit.
