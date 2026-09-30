---
type: integration-audit
date: 2026-09-30
scope: audit snapshot of the uncommitted working tree
status: historical-findings-with-current-disposition
providers: [pi, omp]
open_findings: 7
partially_addressed_findings: [PO-06]
---

# Pi and OMP integration audit

> Historical audit evidence. Current disposition is in [audit status](docs/AUDIT_STATUS.md). Subsequent performance work partially addresses PO-06; the other seven findings remain open. Original locations, counts and reproduction assertions below describe the audit snapshot, not a fresh validation of the implementation.

All eight findings were open when this audit was written; it made no production fixes. Seven remain open and PO-06 is now partially addressed as described above and in its status note. Original source references and reproduction counts describe the audit snapshot.

## Original finding summary

| ID | Priority | Providers | Finding | Evidence |
| --- | --- | --- | --- | --- |
| PO-01 | High | OMP | Native profile selection overrides the pinned Vibeyard profile | Installed OMP resolver executed |
| PO-02 | High | Both | A resumed tab claims a new tab's transcript | Mocked watcher reproduction |
| PO-03 | High | Both | A fresh external CLI run replaces an existing tab's transcript association | Mocked watcher reproduction |
| PO-04 | Medium | Both | Cancelled assistant turns report working | Parser reproduction and upstream source |
| PO-05 | Medium | Both | Explicit session storage overrides are invisible to discovery | Source and installed CLI contract |
| PO-06 | Medium | Both | Each tab snapshots the entire session history synchronously | Mocked enumeration count and source |
| PO-07 | Low | Both | Fallback status cache retains closed-session entries indefinitely | Source inspection |
| PO-08 | Medium | Both | Quoted extra arguments are split into invalid tokens | Direct source inspection |

High means incorrect profile or session identity. These findings do not demonstrate PTY input being redirected between running processes. Incorrect persisted CLI IDs can, however, make later resume open the wrong conversation.

## PO-01: OMP native profiles override the pinned profile

- **Location:** `src/main/providers/omp-provider.ts:43-52`; `src/shared/env-vars.ts:66-70`; environment merge in `src/main/pty-manager.ts:298-315`.
- **Trigger:** The launching environment or a user environment override includes `OMP_PROFILE` or legacy `PI_PROFILE`, while Vibeyard selects a different `configDir`. Native `--profile` in extra arguments also needs an explicit policy.
- **Cause:** Vibeyard only removes/replaces `PI_CODING_AGENT_DIR`. OMP 18.4.4 resolves the native profile first and ignores the agent-directory override when that profile is active.
- **Observed result:** Executing the installed OMP directory resolver with `OMP_PROFILE=audit-example` and `PI_CODING_AGENT_DIR=C:/audit/pinned-profile` returned `C:\Users\Leo\.omp\profiles\audit-example\agent`.
- **Impact:** The CLI uses another profile's settings and credential store while Vibeyard labels and watches the pinned directory. Status, discovery and resume can also fail. The reproduction resolved paths only; it did not authenticate or read credentials.
- **Required change:** Define one profile authority. Remove conflicting inherited native selectors case-insensitively, protect them from user overrides when pinning a profile, and validate conflicting CLI flags. Alternatively, model native profiles explicitly and propagate the effective resolved directory everywhere.
- **Acceptance:** Default and pinned launches retain the selected identity with `OMP_PROFILE`, `PI_PROFILE`, mixed-case Windows keys and native profile arguments present. Discovery and resume use the same effective root as the child.

Installed evidence: `@oh-my-pi/pi-utils/src/dirs.ts`, profile environment resolution at 83-96 and `DirResolver` at 341-347. The installed package is under `C:\Users\Leo\.bun\install\global\node_modules`.

## PO-02: A resumed tab steals a new tab's transcript

- **Location:** `src/main/providers/pi-provider.ts:134-136`; `src/main/providers/omp-provider.ts:110-112`; `src/main/pi-compatible-session-watcher.ts:279-288,328-334`.
- **Trigger:** Resume a conversation, then start a new tab with the same provider, project and profile.
- **Cause:** Resume calls `registerPending` without the known CLI ID or adopted transcript. The resumed registration is therefore treated as awaiting its first transcript. Its original file is in `knownFiles`, so the next new file is eligible instead.
- **Reproduction:** Register `ui-resumed` with an existing transcript; register `ui-new`; create `new-session` in that project; advance the poll. `writeCliSessionId('ui-resumed', 'new-session')` is called, and the new tab receives no association.
- **Impact:** The resumed tab follows another conversation's transcript/status/title and persists the wrong resume identity. The new tab remains undiscovered.
- **Required change:** Pass the known identity/path through the resume lifecycle and seed an adopted watcher registration. Do not enqueue a resumed session as an unidentified launch.
- **Acceptance:** Resuming A and launching B in either order preserves both identities; clearing either session is attributed to its own process.

## PO-03: Fresh external runs are mistaken for `/clear`

- **Location:** `src/main/pi-compatible-session-watcher.ts:291-324`.
- **Trigger:** One adopted tab is open. An unrelated Pi/OMP process starts in the same project and profile and writes a newer transcript within the 60-second freshness window.
- **Cause:** Re-adoption uses project, root and creation time, with no proof that the file belongs to the tab's process. A fresh external file satisfies every check. The comment saying freshness prevents external hijacking is incorrect.
- **Reproduction:** Adopt `original` for `ui-original`; advance ten seconds; create `external` with the same cwd; poll. The watcher publishes `external` as the tab's new CLI ID.
- **Impact:** Status/title/transcript tracking and future resume point to the external conversation. The current terminal still belongs to the original process.
- **Required change:** Establish process-specific ownership, such as an explicit launch identity or isolated per-launch session location propagated to discovery/resume. Do not infer `/clear` ownership from freshness alone. Pi 0.87.1 exposes `--session-id`; verify the corresponding OMP strategy independently.
- **Acceptance:** External launches never alter existing tab associations. Concurrent fresh tabs remain correct even when their first transcript writes arrive in reverse order. `/clear` works with multiple same-project tabs.

## PO-04: Cancellation is reported as ongoing work

- **Location:** `src/main/providers/pi-compatible-transcripts.ts:142-150`.
- **Trigger:** The last assistant message has `stopReason: "aborted"` after cancellation.
- **Cause:** Only `error` and `stop` are terminal in the adapter; all other stop reasons map to `working`.
- **Reproduction:** `transcriptStatusFromTail` returns `working` for a final assistant entry with `stopReason: "aborted"`. It also returns `working` for `length`; whether the surrounding CLI auto-continues a length-limited turn must be tested before choosing its final mapping.
- **Impact:** Transcript polling does not reliably return the cancelled session to an idle/waiting state. A renderer text heuristic may mask this in some terminal outputs, but does not correct the transcript contract.
- **Required change:** Handle aborted turns explicitly. Review terminal stop reasons against each installed CLI's turn lifecycle; keep tool-use/intermediate states working.
- **Acceptance:** Cancel a running turn and verify waiting/idle; send another prompt and verify working, then completed. Cover cancellation with and without a literal `Interrupted` terminal message.

Primary source references: [Pi agent failure handling](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts) and [OMP agent session lifecycle](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts). Installed Pi 0.87.1 `dist/core/agent-session.js` also handles `aborted` explicitly. Online main-branch sources are supporting evidence, not a claim of exact installed-version equivalence.

## PO-05: Effective session storage is not propagated

- **Location:** `src/main/providers/pi-provider.ts:61-62`; `src/main/providers/omp-provider.ts:60-61`; `src/main/providers/pi-transcripts.ts:18-25`; `src/main/providers/omp-transcripts.ts:18-25`.
- **Trigger:** Extra arguments set `--session-dir` to a different directory, or disable persistence with `--no-session`. OMP additionally initializes its session directory from `PI_CODING_AGENT_SESSION_DIR`, which Vibeyard preserves.
- **Cause:** CLI flags/environment can change persistence, while Vibeyard continues deriving the transcript root solely from its default agent directory or pinned `configDir`.
- **Impact:** The terminal starts, but automatic identity discovery, status, title, history search and subsequent resume cannot reliably locate its transcript. A persistence-disabled session remains registered for discovery despite never producing one.
- **Required change:** Parse and propagate supported storage overrides, or reject incompatible options with a clear validation error. Explicitly support or reject nonpersistent mode. Audit OMP's `PI_CONFIG_DIR` and platform-dependent XDG layout as part of the same effective-directory contract.
- **Acceptance:** Custom session directories and no-session launches either work consistently across the lifecycle or fail validation before spawning. Test inherited OMP session-directory overrides independently of profile selection.

Installed evidence: both CLIs advertise `--session-dir` and `--no-session`; OMP `src/cli/args.ts:169` reads `PI_CODING_AGENT_SESSION_DIR`. XDG behavior was inspected in OMP source but was not exercised on Linux/macOS.

## PO-06: History size multiplies registration memory and main-thread work

**Current status: partially addressed.** [Performance changes](PERFORMANCE_AUDIT_2026-09-30.md) replace per-tab path sets with shared root generations and cache unchanged directory listings during idle polling. Registration intentionally still forces a synchronous scan to preserve existing-file exclusion. Cached-path iteration, native watcher allocation and real heap/RSS/latency benchmarks remain. The original evidence follows; it does not imply per-tab full-history sets still exist.

- **Location:** `src/main/pi-compatible-session-watcher.ts:168-180,249-255,328-334,384-398`.
- **Trigger:** Many historical transcripts, many open tabs or many historical project directories.
- **Cause:** Every registration synchronously walks the entire provider/profile history and retains its own `Set` of all transcript paths. Polling also enumerates all directories/files in active roots every two seconds. Initial startup creates an OS watcher for every existing default-root subdirectory.
- **Evidence:** With 1,000 historical files and ten registrations, the fixture counted ten complete registration walks. Source shows each resulting set remains attached to its registration until unregister. Timestamp filtering limits header reads, but does not avoid directory enumeration or snapshots.
- **Impact:** Snapshot storage is O(open registrations × history files); polling enumeration is O(history files) per active root. Both run in Electron's main process and can cause latency on large or slow filesystems. OS watcher count grows with default-root project directories.
- **Required change:** Share bounded root metadata or watch only relevant project/session locations; avoid per-tab full-history snapshots and move large scans off the synchronous main-thread path. Bound native watcher allocation and close unused watchers.
- **Acceptance:** Benchmark 1/10/50 tabs against 1k/10k/100k transcripts. Record registration latency, main-thread delay, heap/RSS and watcher handles; demonstrate that per-tab memory no longer scales with total history.
- **Limit:** No real heap/RSS benchmark was run. These are verified allocation/iteration patterns, not measured megabyte or latency claims.

## PO-07: Status fallback cache has no lifecycle bound

- **Location:** `src/main/providers/pi-compatible-transcripts.ts:158-197`.
- **Trigger:** Poll a transcript whose final meaningful line exceeds the small tail window, then close its tab without a later small readable status entry.
- **Cause:** `statusTailCache` retains the path, size and status. It is deleted only when a later small read returns a status, or by the test-only reset. File disappearance and session exit do not evict it; there is no size limit.
- **Impact:** Metadata accumulates with qualifying sessions over the application's lifetime. The cache does **not** retain the full 1 MiB fallback text, so per-entry impact is modest. The comment claiming the deletion behavior bounds memory is inaccurate.
- **Required change:** Add a capacity/expiry bound or explicit lifecycle eviction, including vanished files.
- **Acceptance:** Read more unique oversized-final-entry transcripts than the configured limit, close/delete them, and verify bounded entry count and correct subsequent status reads.

## PO-08: Extra arguments do not preserve quoting

- **Location:** `src/main/providers/pi-provider.ts:61-62`; `src/main/providers/omp-provider.ts:60-61`.
- **Trigger:** Configure a flag value containing spaces, for example `--append-system-prompt "Use concise replies"` or `--session-dir "C:\Session Data"`.
- **Cause:** `.split(/\s+/)` splits inside quotes and retains quote characters. The first example becomes four tokens: `--append-system-prompt`, `"Use`, `concise`, `replies"`.
- **Impact:** The CLI receives an incomplete option value and stray positional arguments; paths with spaces break. Shell escaping later cannot recover the lost token boundaries.
- **Required change:** Use a defined argument parser or a structured argument list. Preserve system prompts and initial prompts as single arguments, and explicitly validate malformed quoting.
- **Acceptance:** Both providers handle spaces, empty quoted values, escaped quotes and Windows paths correctly without invoking shell expansion.

## Coverage and verification

- Verified installed CLI versions: **Pi 0.87.1**, **OMP 18.4.4**. Help confirms the existing resume flags (`--session` and `--resume`, respectively) and system-prompt flags are supported.
- Inspected launch environment, argument building, profile pinning, session registration/resume/exit, transcript discovery/search/status/title, binary resolution and renderer interruption handling.
- Existing focused suite: **11 files, 197 tests passed**. Includes shared/provider-specific watchers, both provider adapters and search adapters, transcript parsing, transcript sync, binary resolution and profiles.
- Audit run: **201 tests passed**, comprising the same coverage plus four assertions demonstrating current defects/complexity. Passing these audit assertions means the defect was reproduced, not fixed.
- The temporary test source was archived as [audit reproduction source](docs/audits/pi-omp-audit-repro.test.ts.txt), outside the active test suite. It contains the existing shared watcher fixture plus four clearly labelled audit cases. To rerun the historical assertions against a chosen snapshot, copy it to `src/main/pi-omp-audit-repro.test.ts`, run `npx vitest run src/main/pi-omp-audit-repro.test.ts`, then remove that temporary copy. Its old implementation assumptions can fail after later changes; these are historical reproduction assertions, not current acceptance tests. Change assertions to desired behavior when implementing regression tests.
- Vitest required an approved process-spawn escalation because the Windows sandbox rejected child processes. Pi help also printed a sandbox `settings.json.lock` permission warning; this was not treated as a Vibeyard defect.
- No authenticated model requests, live Electron interaction, package installation, global configuration edits or package rebuild were performed. The existing 0.3.9-dev executables predate this report and were not runtime-verified here.

## Implementation order for a local LLM

1. **Needs to be done:** PO-01 profile isolation, PO-02 resume identity and PO-03 reliable process attribution; add failing regression tests before fixes.
2. **Needs to be refactored:** PO-05 effective launch/storage contract, PO-06 watcher allocation/scanning, PO-07 bounded status cache and PO-08 argument parsing.
3. **Needs to be updated:** PO-04 terminal-state mapping; watcher/cache comments; provider/session contract documentation and audit status after each verified fix.
4. Run the focused suite, then authenticated two-tab/external-process/profile/cancellation checks. Record live CLI versions and actual memory measurements. Do not mark runtime coverage complete from mocked tests.
