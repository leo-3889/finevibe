# Vibeyard full audit — 2026-10-10

HEAD `869a7ed` (fork `leo-3889/vibeyard`, upstream `elirantutia/vibeyard`). Method: parallel subsystem reviewers against the contract docs + parent-run verification gates + inline slices. Read-only audit; no code changed. Severity: critical / high / medium / low.

## Verification gate (parent-run, this audit)

- `npx vitest run`: **79 failed / 2271 passed / 1 skipped** across 8 files — byte-identical failure count to `docs/AUDIT_STATUS.md` (2026-10-03); no new red files. All 8 files are Pi/OMP: `omp-session-watcher` (20), `pi-session-watcher` (15), `pi-provider` (12), `omp-provider` (12), `pi-compatible-session-watcher` (11), `session-transcript-sync` (3), `pi-provider.search` (3), `omp-provider.search` (3).
- Triage: **stale assertions, not regressions.** `pi/omp-provider.test.ts` `buildArgs` cases throw `TypeError` inside `launchSessionDir` (`src/main/launch-session-dir.ts:46`) because their `vi.mock('electron')` provides no `app.getPath`, which the per-launch-session-dir feature now requires (`launchSessionBaseDir`, line 34). Watcher tests assert the pre-launch-dir contract (readdir snapshots of the default `~/.omp/agent/sessions` root, "Number of calls: 0"), superseded by exclusive per-launch session dirs (PO-02/PO-03).
- Consequence: `npm test` fails ⇒ **CI (build + test on 3 OSes) blocks every merge to `main`**, and the release workflow runs `npm test` twice before tagging ⇒ releases are currently impossible until the stale suites are updated. `AUDIT_STATUS.md` item 1 is still the top of the queue.

## Feature areas audited

| Area | Verdict summary |
| --- | --- |
| Provider registry & spawn | contract holds; 1 finding |
| Session lifecycle, hooks, watchers | PO-04/PO-07 re-confirmed open; rest holds |
| Security boundaries | P2P/cookie/IPC gating verified; 3 findings |
| Renderer UI & state | contract holds; 2 minor findings |
| Search & performance limits | verified — no drift |
| Packaging, launcher, updater, CI | 5 findings |
| GitHub integration | 2 findings |
| Test gate | red; stale assertions |

## Search & performance contract — verified clean

Every numeric claim in `docs/performance.md` and the search clauses of `docs/provider-contracts.md` were checked against code; all hold:

- 8 MiB file read (`ipc-handlers.ts:38` `MAX_READ_FILE_BYTES`); preview page 2,000 lines / 128 Ki chars (`file-preview.ts:1-2`); untracked diff 256 KiB + 5,000 lines (`git-status.ts:314-329`).
- Search: top-20 (`session-deep-search.ts:176`), text cache 500 entries / 8 Mi chars (`:10,13` + eviction loop `:86`), record cap 50 Ki chars / `MAX_TEXT*6+32Ki` ≈ 332 KiB (`session-search-index.ts:10-11`), index dir `<userData>/search-index-v2/<provider>` (`session-search-index.ts:14`), concurrency 4 (`transcript-utils.ts:56` `TRANSCRIPT_IO_CONCURRENCY`), abort signal checked at discovery, per-descriptor, per-provider and final return (`session-deep-search.ts:138-176`); pruning only on uncancelled passes (`:163`).
- Gemini discovery: 64 KiB header read (`gemini-provider.ts:35`), skips files > 64 MiB (`:262`).
- Event ingestion: 64 KiB/turn + 64 KiB record cap (`bounded-event-reader.ts:3-4`); renderer retention 2,000 events / 2 Mi chars / 64 Ki per-event skip (`session-inspector-state.ts:5-7`).

## Packaging, launcher, updater, CI — findings

1. **high — npm launcher broken on Windows.** `bin/vibeyard.js:22` expects asset `Vibeyard-<version>-win-<arch>.zip`, but the release workflow (`build-windows`) publishes the electron-builder win targets nsis+portable only. Verified against real upstream assets (v0.3.8): `Vibeyard-0.3.8.exe` + `Vibeyard-Setup-0.3.8.exe` — no zip exists ⇒ `npm i -g vibeyard` throws "Release not found" on every Windows install. Fix: add `"zip"` win target + win `artifactName: Vibeyard-${version}-win-${arch}.${ext}`, or change the launcher to the portable exe. (mac zip names and the new linux `artifactName` do match the launcher.)
2. **medium — launcher download has no integrity check and allows TLS downgrade.** `bin/vibeyard.js:47-50` `followRedirects` switches to `http` on any off-scheme redirect; no checksum/signature is verified before `extract()` + `launch()` of the downloaded binary (`:113-142, 198-205`). A network attacker able to redirect can achieve code execution. Fix: pin to https redirects only, and verify the published `sha256` digest (GitHub now exposes `digest` per asset) or at least block http.
3. **medium — fork inherits upstream update chain.** `package.json` `publish.owner: elirantutia` (`:100-105`) and `bin/vibeyard.js:17` `REPO = 'elirantutia/vibeyard'`. A packaged FineVibe build auto-updates from **upstream** releases (`auto-updater.ts` uses electron-updater defaults): silent lineage flip / downgrade of fork-only Pi+OMP features on quit-and-install. Also `version: 0.3.9-dev` + `releaseType: release` means electron-updater never finds prerelease updates, and the launcher's `v0.3.9-dev` tag doesn't exist upstream. Fix: point publish/launcher at the fork repo (or intentionally document that the fork never self-updates).
4. **low — packaged window icon missing.** `main.ts:38` loads `<appRoot>/build/icon.png` but electron-builder `files` (`package.json:56-60`) ships only `dist/**` ⇒ `existsSync` false in packaged builds (Windows taskbar/Linux dock icon). `electron-builder.local.json` includes `build/icon.png` — the divergence suggests the intended fix is in package.json.
5. **low — two divergent builder configs.** `package.json build` vs `electron-builder.local.json` (extra win `signAndEditExecutable`/`signExts`, icon in files). Unreferenced from scripts; drift risk between local and CI packaging.

## GitHub integration — findings

6. **low — `gh` availability cached permanently.** `github-cli.ts:11,39-66`: first `isGhAvailable()` result is cached for process lifetime (`cachedAvailable`); installing `gh` requires an app restart. Fix: expire the cache (TTL) or clear on `gh:` IPC retry.
7. **low — availability check and invocation disagree.** `ghCandidates()` probes known install dirs (`:17-33`), but `ghApi` execFiles bare `ghBinaryName()` resolved via `getFullPath()` (`:79-87`). When `gh` exists only at a candidate dir absent from PATH, availability says yes and every API call ENOENTs. Fix: remember the resolved candidate and execFile it.

## Test gate / dead weight notes

- Graph dead-weight flags for `scripts/copy-assets.js`, `vitest.config.ts`, `src/preload/browser-tab-preload.ts` are **false positives** (all referenced: build script, vitest, `ipc-handlers.ts:628`).
- `prerequisites.ts` (claude-only check) and provider `validatePrerequisites` coexist; startup gates on at least one provider (`main.ts:100-114`) — correct for a 6-provider fork; `validatePrerequisites()` legacy export should be reconciled.

## Provider registry & spawn — verified, 1 finding

Contract clauses verified holding: single launch spec resolved before any side effect (`pty-manager.ts:275-334` `resolveLaunchSpec` — env-conflict and extra-arg conflict rejection pre-spawn); user env merged last but provider-owned vars dropped via `partitionUserEnv` (`:299-310`); `quoteArgForCmdExe` throws on literal double quotes and quotes metachar tokens (`:192-201`), `.ps1` → powershell, `.cmd/.bat` → `cmd.exe /c` (`resolveWindowsShell :208-230`); no `shell:true` anywhere (node-pty options object carries none); replaced-PTY exit suppression + `replacedPtys` (`:368-371, 434-435`); dead-PTY guards for node-pty#887 (`:447+`); macOS keychain-isolation block for profile launches (`:404-412`); per-spawn Copilot/Claude-profile hook installs (`:380-421`); crash annotation reads `readSessionExitReason` before teardown and rejects markers older than `launchStartedAt` (`ipc-handlers.ts:239-263`); `session:syncRestored` is title-only, boundary-validated, known-id-only (`ipc-handlers.ts:569-603`).

8. **medium — close/race window during `spawnPty` awaits.** `ipc-handlers.ts:195-215` registers transcript sync + watcher before `await spawnPty`, and `pty-manager.ts:380-386` awaits Copilot `installHooks` before `pty.spawn` lands in the map (`:445`). A `pty:kill`/`session:release` arriving in that window is a no-op (`killPty` finds no entry), then the PTY spawns orphaned: a live CLI with no renderer session and no exit path until the user quits. Fix: mark a per-session "closing" flag checked after `pty.spawn`, or register a placeholder in `ptys` before the awaits.

## Session lifecycle, hooks, watchers — PO-04/PO-07 re-confirmed open

- **PO-04 CONFIRMED (high, carried):** `pi-compatible-transcripts.ts:148` — `return stop === 'stop' ? 'completed' : 'working'`; a Pi/OMP `stopReason: "aborted"` still maps to `working`. The renderer interrupt latch (`session-activity.ts:88`) swallows the stale `working` while set, so the UI usually looks right — but the latch clears on the next `UserPromptSubmit` (`:84`) and the main-side status file stays `working`, so cost/status consumers and any re-sync between turns see a session that never finished. Fix per AUDIT_STATUS: map `aborted` to idle/completed consistently with the latch.
- **PO-07 CONFIRMED (medium, carried):** `statusTailCache` (`pi-compatible-transcripts.ts:164`) is a module-global `Map` with no capacity or TTL; entries are inserted at `:190` and only deleted when a small-window read yields a status again (`:177`) or size changes. The comment at `:160-162` claims "dropped the moment the small window yields a status again … which bounds memory" — that never happens for a closed session whose final entry exceeded the 16 KiB window, so one entry per such launch persists for the process lifetime. Fix: cap size (LRU) or delete the key when the session's sync is unregistered.

Contract clauses verified holding: HOOKS.md end-to-end — `# vibeyard-hook` marker (`claude-cli.ts:210`), `INSPECTOR_FIELDS` compile-time assertion + 2000-char truncation (`:196, 205`), `STOP_FALLBACK_MS`/`STOP_STALE_MS` = `STOP_INFLIGHT_TRUST_MS` = 600000 (10 min, `shared/constants.ts:68`), `TOKEN_TRUNCATION_KEY` vs `SENTINEL` split (`constants.ts:49-57`), version-gated installs (`claude-hook-versions.ts:10+`), `.subagents` fallback only, `session_crons` never consulted (`hook-commands.ts:63-111`); `statusFilePath` UI-session-ID regex (`hook-status.ts:56-59`); Kanban `completed`→Done only on completed (`board-session-sync.ts:14-18`), close clears `sessionId` only (`:21-28`); state save atomic tmp+rename (`store.ts:84-86`) and flushed on close/quit (`main.ts:86, 167`).

## Security boundaries — verified gating + 3 findings

Verified holding: preload exposes only `contextBridge` with fixed arg marshalling (`preload.ts:173-226`); fs handlers gate through `canonicalPath` (realpath with parent-chain fallback) + `isWithinKnownProject` + `isAllowedReadPath` and log-block escapes (`ipc-handlers.ts:41-120`); P2P — PBKDF2-SHA256 100k → AES-GCM-256 with fresh salt/IV (`share-crypto.ts:12-47`), random 128-bit key (`:17-19`), host sends a challenge and sends **zero** data before `authState === 'verified'` (`peer-host.ts:117-124, 164-165`), scrollback only after verification (`sendInitAndStartKeepalive` fired only in the verified branch `:151-153`), guest `input` honored only in `readwrite` mode (`:167-168`), mismatch/timeout tears down the share; Chrome import — unique random temp dir, `cleanup()` in `finally` (`importer.ts:77-78`), no decrypted material written (encrypted DB snapshot only); persisted state carries no credential fields (`shared/types.ts` — token fields are usage counters only).

9. **medium — `sandbox: false` for the main window.** `main.ts:44` disables the Chromium renderer sandbox ("needed for node-pty IPC"). Preload only imports `electron` modules (`preload.ts:1`), which works under `sandbox: true` on Electron 41; the flag widens renderer-compromise blast radius (native `require` in any injected frame) for no current need. Verify preload under sandbox and re-enable.
10. **medium — webview popups unguarded.** `browser-tab/pane.ts:217` sets `allowpopups`; no `new-window` handler exists on any webview, while the main window's `setWindowOpenHandler` (`main.ts:53-56`) doesn't cover webview guests. Remote pages can open in-app windows that inherit the guest session partition — the same partition that may hold imported Chrome cookies. Fix: handle `new-window` → `deny` + `shell.openExternal`.
11. **low — dangerous schemes in the address-bar allowlist.** `browser-tab/navigation.ts:3` includes `javascript:` and `view-source:` in `KNOWN_SCHEMES`, so `navigateTo` assigns them straight to `webview.src` (`:13-18`). Chromium blocks most external `javascript:` navigations, so this is self-XSS-hardening only, but the scheme serves no feature. Fix: drop `javascript:`/`view-source:`.

Note: no `will-attach-webview` handler in main (guest `webpreferences` string is renderer-controlled); acceptable under the trusted-renderer model, worth pinning if item 9 lands.

## Renderer UI & state — contract holds, 2 minor findings

Verified: title adoption precedence (`session-title.ts:17-34`: autoTitle gate → sticky `userRenamed` → stale `cliSessionId` guard → idempotent compare); smart transition rules (completed sticky, interrupt swallow/clear, `session-activity.ts:84-115`); modal dialogs move focus to first input and pair `keydown` add/remove (`modal.ts:149-158, 191-198, 296`); DEC 9001 Win32 key adapter attaches and tracks set/reset mode (`win32-terminal-keys.ts:12-16`, wired `terminal-pane.ts:120`); pending-prompt timer state owned per pane (`terminal-pane.ts:251, 288-290`); Markdown preview sanitizes (`file-reader.ts:126` `DOMPurify.sanitize`); provider capability flags drive UI visibility (`terminal-pane.ts:86-87`).

12. **low — i18n gaps in file tree / mcp inspector.** `file-tree.ts:235` `'(empty)'` and 13+ literals in `mcp-inspector.ts` bypass `t()` (sidebar/git-panel are clean at 48/15 `t()` calls). Untranslated strings leak across all locales.
13. **low — `session-changed` board scan is O(all tasks) per event.** `board-session-sync.ts:30-40` re-walks every project's tasks on any session change to mirror `cliSessionId`; fine for current board sizes, worth indexing by `sessionId` before boards grow.

## Method note

Four delegated subsystem audits (providers/spawn, lifecycle/hooks, security, renderer) were killed twice by a model-backend outage (`404 model_not_found` → `sighup`, same failure class as `docs/OMP_SESSION_DROPS_2026-10-03.md`); their transcripts park mid-investigation with no persisted result. The four slices above were therefore re-audited inline by the parent with file:line citations; nothing in this report is agent-claimed-but-unverified.
## Remediation status (same day, fix team)

| # | Fix status | Evidence |
| --- | --- | --- |
| 1 win-zip asset | DONE | `package.json` win targets `nsis,portable,zip` + `artifactName` + per-target pins keeping legacy Setup/portable names; local config reconciled |
| 2 launcher integrity | DONE | https-only redirects + streaming sha256 vs GitHub API digest (warn-and-proceed when API gives none); 16 launcher tests |
| 3 update lineage | DONE | `VIBEYARD_RELEASE_REPO` override in launcher + `autoUpdater.setFeedURL`; README Known limits; upstream default byte-identical |
| 4 icon | DONE | `build/icon.png` in asar `files` |
| 5 config drift | DONE | both configs identical targets/names/files |
| 6 sandbox | DONE | `sandbox: true` after removing preload's local value-import (constants inlined; drift note); Electron smoke pending |
| 7 popups | DONE | `new-window` → deny + http(s)-only `openExternal` (`pane.ts:660+`); 29/29 browser-tab tests |
| 8 spawn race | IN PROGRESS (MainWiringFixes) | pendingKill placeholder design |
| 9 PO-04 | DONE | `aborted`→`waiting` (`pi-compatible-transcripts.ts:152`); 39/39 incl. next-turn sequence |
| 10 PO-07 | DONE | LRU cap 512 + eviction/recency tests |
| 11 gh cache/PATH | IN PROGRESS (RendererMiscFixes) | TTL + resolved-candidate execFile |
| 12 i18n | IN PROGRESS (RendererMiscFixes) | file-tree + mcp-inspector literals + locale keys |
| 13 board index | IN PROGRESS (RendererMiscFixes) | per-project sessionId→task map |
| gate (79 tests) | IN PROGRESS (GateTestsFix) | stale assertions → launch-dir contract; provider mocks get `app.getPath` |
| will-attach-webview pin | IN PROGRESS (MainWiringFixes) | follow-up to item 6 |

Full-suite gate, renderer `tsc --noEmit`, `git diff --check`, and the Electron smoke (sandbox + webview) run after all fix agents land; results appended here.
