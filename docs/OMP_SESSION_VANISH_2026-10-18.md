# Vibeyard session "vanished": audit (2026-10-18)

## Symptom

The session that was working the vibeyard repo on 2026-10-18 (history title "Check vibeyard uncommitted status", CLI id `01a14f5c`) disappeared mid-work, and no vibeyard session newer than 2026-10-01 was listed by the CLI session picker. Sessions from 2026-10-02 onward appeared lost.

## Root causes (two independent problems)

### A. The session was killed — pi-lens is reinstalled and crashes omp again

- 2026-10-18 18:46:59 (+02:00), pid 41336: `Unhandled rejection` `EPIPE: broken pipe, write`, stack frames at `C:\Users\Leo\.omp\plugins\node_modules\pi-lens\dist\index.js:58467` / `:56832` — the same `vscode-jsonrpc` writable-stream frames documented in [OMP session drops: pi-lens investigation (2026-10-03)](OMP_SESSION_DROPS_2026-10-03.md). The process died; the transcript's trailing `session_exit` is `reason=unhandled_rejection, kind=fatal` at 16:46:59Z.
- pi-lens 4.3.0 — the exact version implicated on 2026-10-03 — is present again: `node_modules\pi-lens` (installed 2026-10-05 09:07), `"pi-lens": "npm:pi-lens@^4.3.0"` in `plugins\package.json`, and `"enabled": true` in `omp-plugins.lock.json` (mtime 2026-10-05 09:07). The 2026-10-03 uninstall was reversed two days later; which action reversed it (manual reinstall vs dependency sync) is not recorded on disk.
- The same fatal signature killed sessions four times on 2026-10-18 alone (03:09Z, 11:57Z, 13:55Z, 16:46Z; log pids 32400, 25964, 11292, 41336), including subagent transcripts in the same tab. Across the recovered vibeyard transcripts: 12 `unhandled_rejection` fatal exits and 25 `sighup` signal exits (sleep/shutdown kills) since 2026-10-03.
- Consequence in the UI: the fatal exit tears down the omp PTY, the live tab is destroyed, and the row finalizes as a crash (Resume offered). Nothing was corrupted.

### B. The transcript was invisible — per-launch session dirs are not in the CLI default store

- Since the installed build containing `src/main/launch-session-dir.ts` (first per-launch dir 2026-10-03 17:25), every Vibeyard-launched Pi/OMP tab spawns with `--session-dir %APPDATA%\vibeyard\omp-sessions\<uiSessionId>`. Transcripts never reach `~\.omp\agent\sessions\<project-slug>\`.
- The CLI resume picker and any tooling that scans the default store (including the session archive) therefore show no vibeyard session after 2026-10-01. Resuming outside the originating tab looks like total loss. Nothing was deleted: 153 tab dirs / 287 transcripts (all projects, 20 of them vibeyard) were intact under `%APPDATA%\vibeyard\omp-sessions`.
- `docs/session-lifecycle.md` stated Pi/OMP launches "use exclusive session directories" but never recorded the location or the default-store invisibility. Fixed with this audit.

## Recovery performed (2026-10-18)

All 20 vibeyard main transcripts in `%APPDATA%\vibeyard\omp-sessions` (2026-10-02 → 2026-10-18, `cwd` verified from each transcript's `session` record) were **copied** — originals untouched — with their subagent transcript subdirectories into `~\.omp\agent\sessions\-Desktop-DEV-PAPA-Projects-vibeyard\`. Verified: 38 vibeyard transcripts now list in the default store, newest first being the current session; the vanished `01a14aad` (2026-10-17), `01a14f5c` (2026-10-18) and the 2026-10-18 morning sessions are resumable from the picker. `.vibeyard.json` sidecars were not copied (tab-watcher metadata only).

## Open risks

1. ~~pi-lens 4.3.0 remains installed and enabled~~ **RESOLVED 2026-10-18 evening: upgraded to pi-lens 4.4.3** (`omp plugin install pi-lens@latest`, plus a trailing `bun install` in `~\.omp\plugins` — the manager's install wrote lock+bins but did not materialize the package dir; `omp plugin list` now shows `pi-lens@4.4.3`). Crash source: a floating `throw error;` in the bundled `vscode-jsonrpc` 9.0.2 `sendRequest` catch; fixed upstream in microsoft/vscode-languageserver-node PR #1855 (jsonrpc 9.0.3), bumped by pi-lens PR #3631, first shipped in **4.4.0**. Verified on this machine: 4.4.3 bundle's catch ends at `Sending request failed.` (no rethrow), bundled jsonrpc is 9.0.3, and the 4.4.0+ peer range for `@earendil-works/pi-tui` is `"*"` (0.87.1 accepted; the 4.3.0 mismatch is gone). Running omp processes keep the 4.3.0 bundle until restarted. Validate under load: kill the LSP server PID mid-edit and watch `~\.omp\logs` for `Unhandled rejection` (expect none).
2. Per-launch dirs accumulate forever (153 dirs since 2026-10-03, no retention policy). Closing a tab keeps the dir; nothing prunes it.
3. Copies in the default store are point-in-time snapshots: the live tab keeps writing to the AppData original, so re-copy before resuming a session that is still live. A session resumed from the copy forks the snapshot; the tab's continuing history stays in AppData.
