# Vibeyard audit status — 2026-10-13

This is the current work queue for a local LLM. The work described below under "Implemented" is committed on `main`; read the current code and diff before editing. Code and unit-test coverage do not establish behavior in a running or packaged Electron app.

## Status 2026-10-18 (resumed after pi-lens crashes)

- The 2026-10-18 cleanup audit was applied to the working tree (uncommitted): 14 fully dead exports, the `session:claudeSessionId` and `claude:getConfig` IPC shims, dead locale keys, the superseded `src/renderer/components/tab-bar.ts` monolith (the live `tab-bar/` directory is untouched), unreferenced `tsconfig.test.json`, and the doc-drift fixes — 37 files, net −147 lines, staged deletions included. Verified on this tree: renderer `tsc --noEmit` clean; `npm test` 170 files / 2,470 passed / 1 skipped (one forks-worker start timeout on `file-reader.test.ts`, passed 10/10 in isolation — machine-load flake, same class as the 2026-10-10 notes); `git diff --check` clean.
- pi-lens 4.3.0 — reinstalled 2026-10-05, reversing the 2026-10-03 uninstall — killed four sessions on 2026-10-18 with the documented `vscode-jsonrpc` EPIPE fatal, including the session that applied this cleanup. Disarmed: removed from `~/.omp/plugins/package.json` dependencies and `omp-plugins.lock.json`, so dependency sync cannot restore it; effective on the next omp restart (`node_modules/pi-lens` remains on disk, inert). Details: [session vanish audit](OMP_SESSION_VANISH_2026-10-18.md).
- Next unfinished items are unchanged: 4 (measure watcher cost), then 5 (live integration).

## Next work, in order

1. ~~**Restore the full test gate.**~~ Completed 2026-10-10: the full Vitest run is green — 169 files, 2,391 passed, 1 skipped. The original 79 failures were stale watcher/provider assertions already updated in the working tree; the final two failures were the disk-backed 512-file LRU cache tests, which sit on vitest's 5s timeout under load on Windows (they passed in 1.5s in isolation). They were replaced by `pi-compatible-transcripts.cache.test.ts` (in-memory `fs` stub, same five cache-semantics tests, 190ms) and the disk-backed block was removed from `pi-compatible-transcripts.test.ts`. Fixing the build surfaced a real regression: the `will-attach-webview` guest-privilege guard in `src/main/main.ts` was registered on `app`, an event that does not exist on App in Electron 41 (it is a host-webContents event) — the guard could never fire. It now registers on the main window's webContents, the only webContents with `webviewTag` enabled. Runtime suppression of a malicious guest preload remains unverified in a built app (item 5).
2. ~~**Fix Pi/OMP cancellation status (PO-04).**~~ Implemented 2026-10-10: `stopReason: "aborted"` now maps to `waiting` (never `completed`, so Kanban tasks are not falsely Done), with cancellation-sequence regression tests in `pi-compatible-transcripts.test.ts`.
3. ~~**Bound the fallback status cache (PO-07).**~~ Implemented 2026-10-10: `statusTailCache` is an LRU capped at `MAX_STATUS_TAIL_CACHE = 512` with eviction and recency tests.
4. **Measure and reduce remaining watcher cost (PO-06).** `pi-compatible-session-watcher.ts` still forces a synchronous listing at registration and polls cached filenames. Per-launch session directories reduce the usual scope, but real main-thread delay, RSS, and watcher-handle counts have not been measured at increasing tab/history sizes. Measure first, then change the cost shown by the measurements without losing ownership or same-timestamp safeguards.
5. **Exercise live integration.** In a built app, test project provider/profile selection, OMP arrow keys, Pi/OMP new/resumed/restored tabs, `/clear`, cancellation, external CLI runs, abnormal exits, and MCP/P2P teardown. Record the CLI version, profile, tab ID, process ID, and outcome. Reproduce the OMP drop workload after the pi-lens uninstall; a prompt-free startup alone does not settle it. See [OMP session drops](OMP_SESSION_DROPS_2026-10-03.md).

For each completed item, record the exact tests and observed runtime result here. Keep unverified runtime behavior marked as unverified.

Copyable starting prompt: “Read `CLAUDE.md`, `docs/AUDIT_STATUS.md`, and the current diff. Start with item 4 only. Measure watcher cost (registration delay, RSS, watcher handles) at increasing tab/history sizes in the running app before changing anything; report the measurements. Update this file with exact numbers, files changed, and the next unfinished item. Preserve unrelated working-tree changes.”

## Implemented; runtime verification remains

| Area | Current implementation |
| --- | --- |
| Restored identity (N-01) | Unknown CLI IDs remain unresolved; known IDs use title-only sync. No timestamp-based identity recovery. |
| MCP connection lifetime (N-02) | Pending connections are owned through disconnect/disposal; deferred-handshake and timeout tests exist in `mcp-client.test.ts`. |
| P2P teardown (N-03) | Host teardown closes the data channel and peer connection; `peer-host.test.ts` covers cleanup. |
| Profile and arguments (PO-01, PO-05, PO-08) | OMP native profile selectors are removed from launch env; quoted extra arguments are parsed; unsupported storage overrides are rejected; launches use exclusive session directories. |
| Pi/OMP ownership (PO-02, PO-03) | Resume registration carries the known CLI ID, and each launch has its own session directory. External processes do not share that launch directory. |
| Project settings and OMP keys | Project Settings exposes provider/profile selection; terminal input adapts arrow keys to ConPTY Win32 mode. |
| OMP exit recovery | Exit metadata includes PID, code, signal, and transcript reason when available. Stale exit markers are rejected; crash history offers Resume when a transcript exists. |
| Webview guest privileges | The `will-attach-webview` guard pins `nodeIntegration` off, `contextIsolation`/`sandbox` on, and keeps only the shipped browser-tab preload; registered on the main window's host webContents (Electron 41 has no App-level event). Runtime suppression unverified. |

The older A-01–A-13, F-01–F-09, and R-01–R-04 audit items were implemented in this working tree and removed from the active queue. Their current contracts are in [provider contracts](provider-contracts.md), [session lifecycle](session-lifecycle.md), [performance](performance.md), and [security boundaries](security-boundaries.md).

## Last recorded validation

- Full gate re-passed on 2026-10-13 on the committed tree: `npm test` 170 files / 2,399 passed / 1 skipped; `npm run build`; renderer `tsc --noEmit`; `git diff --check`. (First green run was 2026-10-10: 169 files / 2,391 passed / 1 skipped; added since: `src/renderer/components/sidebar-preferences.test.ts` and the pending-`killPty` cases in `src/main/pty-manager.test.ts`.)
- 2026-10-10 diagnostics sweep + fixes: launcher (`bin/vibeyard.js`) now uses `execFileSync` argument arrays (no shell string, so paths with quotes/`$` cannot be reinterpreted) and drops the nested-ternary `APP_PATH`; `main.ts` guards the `mainWindow!` null case; `github-cli.ts` wraps `JSON.parse` and uses `which.length > 0`. `vitest.config.ts` sets `testTimeout: 15_000` — the heavy jsdom file-reader/sidebar suites run 2–3s alone and crossed vitest's 5s default under the 169-file parallel load, failing spuriously. Five watcher/search suites retyped their fs mock handles to the subset they actually implement. Remaining sweep warnings (extensionless relative imports, `console.warn`, `Record<string, unknown>` payloads, test `path.join`) were dispositioned as false-positives/suppressed with per-finding reasons; the CommonJS build and repo console convention make them intentional. Full gate re-passed twice after these edits.
- Focused cache-stub + transcript suites passed in isolation (39 tests) before the full run.
- Fresh `omp --print --no-session --no-title` exited 0 after the OMP pi-lens copy was uninstalled. The intermittent workload and packaged UI were not verified.
- All `dist/` artifacts were wiped and rebuilt on 2026-10-11 from the current tree with `npx electron-builder --win --publish never`: `Vibeyard-Setup-0.3.9-dev.exe` (NSIS, with blockmap), portable `Vibeyard-0.3.9-dev.exe`, `Vibeyard-0.3.9-dev-win-x64.zip`, and updater metadata `latest.yml`. Plain `npm run dist` fails at the publish stage without `GH_TOKEN` — artifacts build, then the GitHub upload errors; local rebuilds must pass `--publish never`. Artifacts are unsigned; interactive behavior was not verified. Artifact details are in [OMP session drops](OMP_SESSION_DROPS_2026-10-03.md).
