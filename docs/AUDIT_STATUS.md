# Vibeyard audit status — 2026-09-30

This is the current entry point for local LLM processing. Status refers to the uncommitted working tree, not a published release. Read the linked audit reports for original evidence, and this file for current disposition. `Implemented in working tree` means code and local tests exist; it does not mean verified in a release.

## Finding status

### Follow-up code findings (resolved)

The [current code audit](../CODE_AUDIT_2026-09-30.md) reproduced four issues after the performance work: R-01 persisted-index truncation changes search results; R-02 search identity ignores provider/profile boundaries; R-03 Gemini discovery performs unbounded whole-transcript reads; R-04 Git-quoted filenames are not decoded. All four are fixed in the working tree with regression tests; see the audit's resolution section.

### Open Pi/OMP integration findings

The [Pi/OMP integration audit](../PI_OMP_INTEGRATION_AUDIT_2026-09-30.md) recorded eight findings: PO-01 native OMP profile override, PO-02 resumed-session misattribution, PO-03 external-session re-adoption, PO-04 cancellation status, PO-05 session storage overrides, PO-06 history snapshot/scanning cost, PO-07 fallback cache retention and PO-08 quoted argument parsing. That audit made no implementation changes. Subsequent performance work partially addresses PO-06: shared root generations replace per-tab snapshots, and idle listings are cached. Fresh registration still scans synchronously, scans still visit cached filenames, native watcher allocation remains unbounded by this change, and live resource measurements are open. PO-01 through PO-05, PO-07 and PO-08 remain open. PO-02 and PO-03 expose additional isolation cases beyond original A-04.

At the integration-audit snapshot, focused Pi/OMP tests passed 11 files / 197 tests. Four additional audit assertions reproduced defects/complexity at that snapshot and were archived outside the active suite. Installed versions checked: Pi 0.87.1 and OMP 18.4.4. Authenticated interaction and real memory measurements remain open.

### Earlier findings

| Finding | Status | Current evidence |
| --- | --- | --- |
| [Original audit](../AUDIT_FINDINGS_2026-09-29.md) A-01 | Implemented in working tree | Canonical filesystem target checks for project paths. |
| A-02 | Implemented in working tree | Broken test syntax and stale mocks repaired. |
| A-03 | Implemented in working tree | Codex history reader retains partial lines with bounded reads. |
| A-04 | Implemented in working tree | Pi/OMP `/clear` re-adoption disambiguates same-second files. |
| A-05 | Implemented in working tree | Git porcelain paths handle spaces and renames. |
| A-06 | Implemented in working tree | Global transcript search bounds concurrency and reads. |
| A-07 | Implemented in working tree | File reader enforces an 8 MiB limit. |
| A-08 | Implemented in working tree | Pi/OMP trailing `session_exit` no longer reports an older status. |
| A-09 | Implemented in working tree | Unprofiled Claude sessions discard inherited config override. |
| A-10 | Implemented in working tree | Profile config directories must be unique. |
| A-11 | Implemented in working tree | PTY replacement suppresses the old process's exit callback. |
| A-12 | Implemented in working tree | Profile removal is refused while sessions or archives pin it. |
| A-13 | Implemented in working tree | Transcript search cache has an enforced size bound. |
| [Feature audit](../FEATURE_AUDIT_2026-09-30.md) F-01 | Implemented in working tree | Host now generates a 128-bit share key; short PIN input removed. `share-crypto.test.ts`. |
| F-02 | Implemented in working tree | Host sends terminal frames only after challenge verification. `peer-host.test.ts`. Real peer verification is open. |
| F-03 | Implemented in working tree | Session removal clears the link without moving an unfinished task. `board-session-sync.test.ts`. |
| F-04 | Implemented in working tree | Board sync updates the owning project; two-project test added. |
| F-05 | Implemented in working tree | Readiness uses built-in exclusions in memory and does not create `.vibeyardignore`; tests updated. |
| F-06 | Implemented in working tree | Linux x64 npm launcher installs and runs the named AppImage; mocked Linux smoke test added. Published asset remains unverified. |
| F-07 | Implemented in working tree | Rename assertion and real temp-directory save/load/recovery tests added. |
| F-08 | Implemented in working tree | GitHub widget ignores stale refresh results; out-of-order test added. |
| F-09 | Implemented in working tree | Chrome import tooltip now says cookies. |

None of the earlier fixes is verified in a published release. The original reports retain historical line numbers and descriptions, which no longer describe this working tree after these edits. The Pi/OMP report preserves its audit-time evidence; use the disposition above for the current working tree.

## Runtime verification still open (D-07)

| Check | Local result | Needed to close |
| --- | --- | --- |
| Packaged startup/update on macOS, Windows, Linux | Windows x64 portable and NSIS executables for 0.3.9-dev were built locally in `dist/` on Windows with Node v24.14.0. Product version and SHA-256 hashes were checked. Both report `NotSigned` in Windows Authenticode. Neither executable was launched or installed in this check; macOS/Linux packages are unavailable here. | Test install, startup and update on each OS, and record results. |
| All six authenticated providers | `codex`, `pi`, `omp` found on PATH; `claude`, `copilot`, `gemini` missing. Authentication was not exercised. | Run interactive start, status, resume and profile isolation with six authenticated CLIs. |
| P2P across networks | Unit tests pass; no second peer/network available in this run. | Test same LAN, ordinary NAT and restrictive NAT, including no pre-auth terminal frames. |
| Browser/webview/cookie import | No live Electron window or Chrome profile import exercised. | Test inspection, flow/draw capture, partition isolation, cookie import and cleanup. |
| Persistence after restart/failure | Real temp-directory save/load and corrupt-main recovery pass. No packaged restart or injected rename failure run. | Relaunch packaged app after save and simulate a failed rename. |
| macOS release signature | Workflow config enables signing/notarization; GitHub latest release page listed v0.3.4 when checked, but did not expose a verifiable signature in this environment. | Verify a downloaded artifact with macOS `codesign` and `spctl`; record artifact hash and result. |

## Validation gates

- `npm run build` and renderer TypeScript check pass on Windows.
- Targeted tests for security, board, readiness, persistence, Linux launcher and GitHub refresh pass.
- Latest recorded full Vitest run after the performance implementation: 161 files passed, 2,231 tests passed, one skipped on Windows. This documentation-only update did not rerun the suite. The focused Linux launcher test uses a mocked Linux process; it is not an AppImage runtime test.
- `tsconfig.test.json` is **excluded** from required checks. It currently fails with legacy target errors and extensive test-mock typing drift. This is a separate test-infrastructure task, not a passing gate.

## Documentation disposition

`CLAUDE.md` is the short current entry point. Current contracts are in `provider-contracts.md`, `session-lifecycle.md`, `security-boundaries.md`, `ui-conventions.md` and [performance/resource limits](performance.md); the new Pi/OMP audit records open violations and gaps in those contracts. `HOOKS.md` retains Claude 2.1.238-specific details; the Pi plan is historical. The root [remaining-work list](../DOCUMENTATION_FILTER_2026-09-30.md) contains open integration fixes and runtime checks.


## Performance implementation — 2026-09-30

[Performance audit](../PERFORMANCE_AUDIT_2026-09-30.md) P-01 through P-07 received implementation changes in the working tree: compact search results, cancellation/shared indexing, a derived disk index, bounded untracked diffs and event ingestion, paged file previews, and shared Pi/OMP registration history with cached idle directory listings. Final validation passed 161 test files, 2,231 tests (one skipped), the build, renderer type check and whitespace check. Live Electron performance and packaged interaction remain unmeasured. See [performance and resource limits](performance.md) for current behaviour and the performance report for test evidence. P-07 does not close the broader PO-06 requirements described above.
