---
type: open-work-list
date: 2026-09-30
scope: current uncommitted working tree
---

# Vibeyard: remaining audit work

The earlier code and feature audit fixes are implemented in the working tree. The later [Pi/OMP integration audit](PI_OMP_INTEGRATION_AUDIT_2026-09-30.md) records eight findings: seven remain open, and PO-06 is partially addressed by subsequent performance work. [Audit status](docs/AUDIT_STATUS.md) records their disposition. The [performance guide](docs/performance.md) describes implemented limits and remaining costs. The original [code audit](AUDIT_FINDINGS_2026-09-29.md) and [feature audit](FEATURE_AUDIT_2026-09-30.md) remain as historical evidence for local LLM processing.

## Follow-up code fixes (resolved)

The [current code audit](CODE_AUDIT_2026-09-30.md) reproduced four issues after the performance work, all now fixed in the working tree with regression tests:

- R-03: Gemini discovery stats each transcript, skips files above the indexer limit, and reads only a bounded header for the session ID.
- R-01: `IndexTextBudget` enforces one text budget including separators before scoring or either cache; the disk index moved to `search-index-v2`.
- R-02: provider/profile identity is preserved through search deduplication and tab/archive matching.
- R-04: `getGitFiles` parses `git status --porcelain=v2 -z` without retaining quoting or escapes.

## Pi/OMP implementation work

| Category | Work still needed | Finding IDs |
| --- | --- | --- |
| Needs to be done | Enforce OMP profile identity; preserve resumed identities; prevent fresh external CLI runs from taking over tab transcript associations. | PO-01, PO-02, PO-03 |
| Needs to be refactored | Reconcile effective session storage; finish synchronous scan/native watcher improvements and benchmark shared history; bound status cache; preserve quoted extra arguments. | PO-05, PO-06, PO-07, PO-08 |
| Needs to be updated | Handle aborted turns correctly; correct ownership/cache comments and update provider/session contracts after fixes. | PO-04 and supporting documentation |

PO-01 through PO-05, PO-07 and PO-08 remain open. PO-06 is partially addressed: per-tab path-set duplication is removed and idle listings are cached; synchronous registration, cached-history iteration, watcher allocation and live benchmarks still need work. Source references, reproductions, priorities and acceptance checks are in the linked integration audit. Passing existing unit tests does not close them.

## Performance verification

- Measure heap/RSS, main-thread delay and watcher handles for 1/10/50 tabs against 1k/10k/100k transcripts. Record first-search and repeated-search costs separately.
- Exercise preview paging, page-local search and distant go-to-line in a real Electron window. Record frame times and memory during file reloads.
- Profile sustained terminal output before deciding whether IPC batching or producer backpressure is needed.

No live performance measurements were collected for the implementation. The passing automated tests verify bounded behaviour, not measured speedups.

## Runtime verification

| Priority | Work still needed | Completion evidence |
| --- | --- | --- |
| High | Test packaged install, startup and update on macOS, Windows and Linux x64. Confirm the Linux npm launcher finds the actual published AppImage asset. | Record OS, package/app version, asset name, install/start/update result and failure log. |
| High | Verify macOS signing and notarization on an actual published artifact. | Record artifact hash plus `codesign` and `spctl` results on macOS. Configuration alone does not prove a release is signed. |
| High | Test P2P sharing with two real peers across LAN and NAT conditions. | Confirm read-only/read-write behavior and that no scrollback, live output or resize reaches the guest before host authentication. |
| Medium | Exercise all six authenticated CLI backends, profile isolation, session status and resume. | Record CLI versions, account/profile setup, steps and results for each provider. |
| Medium | Exercise embedded webview, inspection, flow/draw capture, Chrome-cookie import and browser partition cleanup in Electron. | Record real-window steps, imported cookie behavior and isolation results. |
| Medium | Test persistence across packaged app restart and a simulated state-file rename failure. | Record the saved and recovered state and the observed error behavior. |

Windows x64 portable and installer executables for 0.3.9-dev now exist in `dist/`; their runtime behavior remains untested. The other checks require macOS/Linux builds, authenticated accounts or a second peer. Build and unit results are in [audit status](docs/AUDIT_STATUS.md).
