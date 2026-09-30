# Vibeyard audit status — 2026-09-30

This is the current entry point for local LLM processing. Status refers to the uncommitted working tree, not a published release. `Implemented in working tree` means code and local tests exist; it does not mean verified in a release. The detailed audit reports (original code, feature, performance and Pi/OMP integration audits) were removed on 2026-09-30; this file is the single record of finding dispositions and remaining work.

## Finding status

### Resolved code findings

The 2026-09-29 code audit (A-01 through A-13) and the 2026-09-30 feature audit (F-01 through F-09) are fully implemented in the working tree with regression tests:

| Finding | Current evidence |
| --- | --- |
| A-01 | Canonical filesystem target checks for project paths. |
| A-02 | Broken test syntax and stale mocks repaired. |
| A-03 | Codex history reader retains partial lines with bounded reads. |
| A-04 | Pi/OMP `/clear` re-adoption disambiguates same-second files. |
| A-05 | Git porcelain paths handle spaces and renames. |
| A-06 | Global transcript search bounds concurrency and reads. |
| A-07 | File reader enforces an 8 MiB limit. |
| A-08 | Pi/OMP trailing `session_exit` no longer reports an older status. |
| A-09 | Unprofiled Claude sessions discard inherited config override. |
| A-10 | Profile config directories must be unique. |
| A-11 | PTY replacement suppresses the old process's exit callback. |
| A-12 | Profile removal is refused while sessions or archives pin it. |
| A-13 | Transcript search cache has an enforced size bound. |

The 2026-09-30 feature audit (F-01 through F-09) is fully implemented in the working tree:

| Finding | Current evidence |
| --- | --- |
| F-01 | Host now generates a 128-bit share key; short PIN input removed. `share-crypto.test.ts`. |
| F-02 | Host sends terminal frames only after challenge verification. `peer-host.test.ts`. Real peer verification is open. |
| F-03 | Session removal clears the link without moving an unfinished task. `board-session-sync.test.ts`. |
| F-04 | Board sync updates the owning project; two-project test added. |
| F-05 | Readiness uses built-in exclusions in memory and does not create `.vibeyardignore`; tests updated. |
| F-06 | Linux x64 npm launcher installs and runs the named AppImage; mocked Linux smoke test added. Published asset remains unverified. |
| F-07 | Rename assertion and real temp-directory save/load/recovery tests added. |
| F-08 | GitHub widget ignores stale refresh results; out-of-order test added. |
| F-09 | Chrome import tooltip now says cookies. |

The follow-up code audit reproduced four issues after the performance work, all fixed in the working tree with regression tests:

- R-01: `IndexTextBudget` enforces one text budget including separators before scoring or either cache; the disk index moved to `search-index-v2`.
- R-02: provider/profile identity is preserved through search deduplication and tab/archive matching.
- R-03: Gemini discovery stats each transcript, skips files above the indexer limit, and reads only a bounded header for the session ID.
- R-04: `getGitFiles` parses `git status --porcelain=v2 -z` without retaining quoting or escapes.

None of these fixes is verified in a published release.

## Open Pi/OMP integration findings

Seven findings remain open; PO-06 is partially addressed. Installed versions checked: Pi 0.87.1, OMP 18.4.4. Focused Pi/OMP suite at audit time: 11 files / 197 tests passed. Authenticated interaction and real memory measurements remain open.

| ID | Priority | Finding | Status |
| --- | --- | --- | --- |
| PO-01 | High | Native OMP profile selection (`OMP_PROFILE`/`PI_PROFILE`) overrides the pinned Vibeyard profile | Open |
| PO-02 | High | A resumed tab claims a new tab's transcript (resume registers as unidentified launch) | Open |
| PO-03 | High | A fresh external CLI run in the same project/profile replaces an existing tab's transcript association | Open |
| PO-04 | Medium | Cancelled assistant turns (`stopReason: "aborted"`) report working | Open |
| PO-05 | Medium | `--session-dir`/`--no-session` storage overrides are invisible to discovery | Open |
| PO-06 | Medium | Registration history scanning and watcher allocation cost | Partially addressed |
| PO-07 | Low | `statusTailCache` retains closed-session entries indefinitely | Open |
| PO-08 | Medium | Quoted extra arguments are split into invalid tokens | Open |

High-priority items are incorrect profile or session identity; they do not demonstrate PTY input being redirected between running processes, but incorrect persisted CLI IDs can make later resume open the wrong conversation.

### PO-01: OMP native profiles override the pinned profile

- **Location:** `src/main/providers/omp-provider.ts`; `src/shared/env-vars.ts`; environment merge in `src/main/pty-manager.ts`.
- **Cause:** Vibeyard only removes/replaces `PI_CODING_AGENT_DIR`. OMP resolves the native profile (`OMP_PROFILE`/legacy `PI_PROFILE`) first and ignores the agent-directory override when that profile is active.
- **Required change:** Define one profile authority. Remove conflicting inherited native selectors case-insensitively, protect them from user overrides when pinning a profile, and validate conflicting CLI flags.
- **Acceptance:** Default and pinned launches retain the selected identity with `OMP_PROFILE`, `PI_PROFILE`, mixed-case Windows keys and native profile arguments present. Discovery and resume use the same effective root as the child.

### PO-02: A resumed tab steals a new tab's transcript

- **Location:** `src/main/providers/pi-provider.ts`; `src/main/providers/omp-provider.ts`; `src/main/pi-compatible-session-watcher.ts`.
- **Cause:** Resume calls `registerPending` without the known CLI ID or adopted transcript, so the resumed registration is treated as awaiting its first transcript. Its original file is in `knownFiles`, so the next new file is attributed to it instead.
- **Required change:** Pass the known identity/path through the resume lifecycle and seed an adopted watcher registration. Do not enqueue a resumed session as an unidentified launch.
- **Acceptance:** Resuming A and launching B in either order preserves both identities; clearing either session is attributed to its own process.

### PO-03: Fresh external runs are mistaken for `/clear`

- **Location:** `src/main/pi-compatible-session-watcher.ts` (re-adoption path).
- **Cause:** Re-adoption uses project, root and creation time, with no proof that the file belongs to the tab's process. A fresh external file within the 60-second freshness window satisfies every check.
- **Required change:** Establish process-specific ownership, such as an explicit launch identity or isolated per-launch session location propagated to discovery/resume. Do not infer `/clear` ownership from freshness alone. Pi 0.87.1 exposes `--session-id`; verify the corresponding OMP strategy independently.
- **Acceptance:** External launches never alter existing tab associations. Concurrent fresh tabs remain correct even when their first transcript writes arrive in reverse order. `/clear` works with multiple same-project tabs.

### PO-04: Cancellation is reported as ongoing work

- **Location:** `src/main/providers/pi-compatible-transcripts.ts` (status tail mapping).
- **Cause:** Only `error` and `stop` are terminal in the adapter; all other stop reasons (including `aborted` and `length`) map to `working`.
- **Required change:** Handle aborted turns explicitly. Review terminal stop reasons against each installed CLI's turn lifecycle; keep tool-use/intermediate states working.
- **Acceptance:** Cancel a running turn and verify waiting/idle; send another prompt and verify working, then completed. Cover cancellation with and without a literal `Interrupted` terminal message.

### PO-05: Effective session storage is not propagated

- **Location:** provider spawn and transcript-root derivation (`pi-provider.ts`, `omp-provider.ts`, `pi-transcripts.ts`, `omp-transcripts.ts`).
- **Cause:** `--session-dir`, `--no-session` and OMP's `PI_CODING_AGENT_SESSION_DIR` can change persistence, while Vibeyard derives the transcript root solely from its default agent directory or pinned `configDir`.
- **Required change:** Parse and propagate supported storage overrides, or reject incompatible options with a clear validation error. Explicitly support or reject nonpersistent mode. Audit OMP's `PI_CONFIG_DIR` and platform-dependent XDG layout as part of the same effective-directory contract.
- **Acceptance:** Custom session directories and no-session launches either work consistently across the lifecycle or fail validation before spawning.

### PO-06: History size multiplies registration memory and main-thread work

**Partially addressed.** Performance work replaced per-tab path sets with shared root generations and caches unchanged directory listings during idle polling. Registration intentionally still forces a synchronous scan to preserve existing-file exclusion. Cached-path iteration, native watcher allocation and real heap/RSS/latency benchmarks remain.

- **Remaining:** Share bounded root metadata or watch only relevant project/session locations; move large scans off the synchronous main-thread path. Bound native watcher allocation and close unused watchers.
- **Acceptance:** Benchmark 1/10/50 tabs against 1k/10k/100k transcripts. Record registration latency, main-thread delay, heap/RSS and watcher handles; demonstrate that per-tab memory no longer scales with total history.

### PO-07: Status fallback cache has no lifecycle bound

- **Location:** `src/main/providers/pi-compatible-transcripts.ts` (`statusTailCache`).
- **Cause:** The cache retains path, size and status for transcripts whose final meaningful line exceeds the tail window. It is deleted only when a later small read returns a status; file disappearance and session exit do not evict it, and there is no size limit.
- **Required change:** Add a capacity/expiry bound or explicit lifecycle eviction, including vanished files.
- **Acceptance:** Read more unique oversized-final-entry transcripts than the configured limit, close/delete them, and verify bounded entry count and correct subsequent status reads.

### PO-08: Extra arguments do not preserve quoting

- **Location:** extra-argument splitting in `src/main/providers/pi-provider.ts` and `src/main/providers/omp-provider.ts`.
- **Cause:** `.split(/\s+/)` splits inside quotes and retains quote characters, so `--append-system-prompt "Use concise replies"` becomes four tokens.
- **Required change:** Use a defined argument parser or a structured argument list. Preserve system prompts and initial prompts as single arguments, and explicitly validate malformed quoting.
- **Acceptance:** Both providers handle spaces, empty quoted values, escaped quotes and Windows paths correctly without invoking shell expansion.

### Suggested implementation order

1. **Needs to be done:** PO-01 profile isolation, PO-02 resume identity and PO-03 reliable process attribution; add failing regression tests before fixes.
2. **Needs to be refactored:** PO-05 effective launch/storage contract, PO-06 watcher allocation/scanning, PO-07 bounded status cache and PO-08 argument parsing.
3. **Needs to be updated:** PO-04 terminal-state mapping; watcher/cache comments; provider/session contract documentation and this status after each verified fix.
4. Run the focused suite, then authenticated two-tab/external-process/profile/cancellation checks. Record live CLI versions and actual memory measurements. Do not mark runtime coverage complete from mocked tests.


Historical reproduction assertions for PO-02, PO-03, PO-04 and PO-06 are archived in [pi-omp-audit-repro.test.ts.txt](audits/pi-omp-audit-repro.test.ts.txt), outside the active test suite. They describe the 2026-09-30 snapshot and may fail against later changes; convert them to desired-behavior regression tests when implementing fixes.

## Runtime verification still open

| Check | Local result | Needed to close |
| --- | --- | --- |
| Packaged startup/update on macOS, Windows, Linux | Windows x64 portable and NSIS executables for 0.3.9-dev were built locally in `dist/` on Windows with Node v24.14.0. Product version and SHA-256 hashes were checked. Both report `NotSigned` in Windows Authenticode. Neither executable was launched or installed in this check; macOS/Linux packages are unavailable here. | Test install, startup and update on each OS, and record results. |
| All six authenticated providers | `codex`, `pi`, `omp` found on PATH; `claude`, `copilot`, `gemini` missing. Authentication was not exercised. | Run interactive start, status, resume and profile isolation with six authenticated CLIs. |
| P2P across networks | Unit tests pass; no second peer/network available in this run. | Test same LAN, ordinary NAT and restrictive NAT, including no pre-auth terminal frames. |
| Browser/webview/cookie import | No live Electron window or Chrome profile import exercised. | Test inspection, flow/draw capture, partition isolation, cookie import and cleanup. |
| Persistence after restart/failure | Real temp-directory save/load and corrupt-main recovery pass. No packaged restart or injected rename failure run. | Relaunch packaged app after save and simulate a failed rename. |
| macOS release signature | Workflow config enables signing/notarization; GitHub latest release page listed v0.3.4 when checked, but did not expose a verifiable signature in this environment. | Verify a downloaded artifact with macOS `codesign` and `spctl`; record artifact hash and result. |

### Performance verification still open

- Measure heap/RSS, main-thread delay and watcher handles for 1/10/50 tabs against 1k/10k/100k transcripts. Record first-search and repeated-search costs separately.
- Exercise preview paging, page-local search and distant go-to-line in a real Electron window. Record frame times and memory during file reloads.
- Profile sustained terminal output before deciding whether IPC batching or producer backpressure is needed.

No live performance measurements were collected for the implementation. Passing automated tests verify bounded behaviour, not measured speedups.

## Validation gates

- `npm run build` and renderer TypeScript check pass on Windows.
- Targeted tests for security, board, readiness, persistence, Linux launcher and GitHub refresh pass.
- Latest recorded full Vitest run after the performance implementation: 161 files passed, 2,231 tests passed, one skipped on Windows.
- `tsconfig.test.json` is **excluded** from required checks. It currently fails with legacy target errors and extensive test-mock typing drift. This is a separate test-infrastructure task, not a passing gate.

## Documentation disposition

`CLAUDE.md` is the short current entry point. Current contracts are in `provider-contracts.md`, `session-lifecycle.md`, `security-boundaries.md`, `ui-conventions.md` and [performance/resource limits](performance.md); the open Pi/OMP findings above record violations and gaps in those contracts. `HOOKS.md` retains Claude 2.1.238-specific details. The dated audit reports and plan documents were removed on 2026-09-30; this file is the remaining audit record.
