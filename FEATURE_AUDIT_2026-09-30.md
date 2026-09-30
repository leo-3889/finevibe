# Vibeyard feature implementation audit — 2026-09-30

> Historical finding evidence. F-01 through F-09 have implementation changes in the current uncommitted working tree. See [current audit status](docs/AUDIT_STATUS.md) for per-finding disposition and open runtime checks.

## Scope and method

This is a documentation-only audit of the current working tree. It covers every feature advertised in `README.md` plus the major features exposed by the source. The working tree already contains uncommitted implementation changes from the earlier audit; findings here describe that current tree, not a released build. I traced the renderer entry points through state, preload/IPC, main-process handlers and relevant tests. I did not launch a packaged Electron app, connect live CLI accounts, or test WebRTC between real networks. A passing unit test is evidence for the tested path, not proof of end-to-end behavior.

Verification on this tree: `npm run build` passed; `npx tsc -p tsconfig.renderer.json --noEmit` passed; `npx vitest run --reporter=dot` passed with 155 files, 2,210 tests passed and one skipped. Vitest initially hit `spawn EPERM` in the restricted Windows sandbox; the same command passed when rerun with process-spawn permission. `git diff --check` passed. The full test run prints mocked persistence errors described in F-07 despite its green summary.

## Findings

### F-01 — High — Sharing codes permit offline PIN guessing

- **Feature:** P2P sharing authentication and confidentiality.
- **Evidence:** `src/renderer/sharing/share-crypto.ts:15-21` accepts a 4-digit PIN (10,000 possibilities). `src/renderer/sharing/share-crypto.ts:39-73` encrypts the offer/answer code with a key derived from that PIN using PBKDF2 and AES-GCM. `src/renderer/sharing/webrtc-utils.ts:18-36` embeds that encrypted payload in the share code.
- **Impact:** Anyone who obtains a connection code can test PIN guesses offline against its authenticated ciphertext. PBKDF2 slows guesses but cannot add entropy to a 4-digit secret. The code should not be treated as safely shareable over an untrusted channel on the strength of its PIN alone. Completing a connection still requires the host to accept an answer.
- **Recommendation:** Use a high-entropy generated secret for code encryption and authentication. If a short human PIN remains, make its security limits explicit and avoid relying on it to protect a captured code.

### F-02 — Medium — Host sends live output before the second authentication step finishes

- **Feature:** P2P sharing authentication boundary.
- **Evidence:** `src/renderer/sharing/peer-host.ts:113-121` sets `connected = true` as soon as the data channel opens, then starts the challenge. `src/renderer/sharing/peer-host.ts:223-227` gates `broadcastData` only on `connected`. `src/renderer/index.ts:74-85` forwards PTY output while sharing. The existing test at `src/renderer/sharing/peer-host.test.ts:259-265` explicitly expects data immediately after `onopen`, before a valid response.
- **Impact:** A peer with an established data channel can receive PTY bytes during the pending-auth window. The encrypted signaling code still limits who can normally establish that channel, but the documented second-stage auth gate does not protect live output.
- **Recommendation:** Gate data and resize broadcasts on `authState === 'verified'`; add tests for pending and failed authentication.

### F-03 — Medium — Closing an unfinished session marks its Kanban card Done

- **Feature:** Kanban automatic status changes.
- **Evidence:** `src/renderer/board-session-sync.ts:14-18` moves a task on a `completed` status, but `src/renderer/board-session-sync.ts:20-27` also moves it on every `session-removed` event. `src/renderer/state.ts:769-794` emits that event for ordinary session removal. `src/renderer/board-session-sync.test.ts:70-82` codifies the close-to-Done behavior.
- **Impact:** Closing an idle, waiting, failed, or interrupted session can report an unfinished task as complete. This conflicts with the README claim that tasks move to Done when their session completes.
- **Recommendation:** On removal, clear the UI session link while preserving the task's column unless a completed status was recorded (or the user explicitly completed the task).

### F-04 — Medium — Background-project session events update only the active board

- **Feature:** Per-project Kanban/session synchronization.
- **Evidence:** `src/renderer/board-session-sync.ts:16-17,22-26` calls `getTaskBySessionId` without a project ID. That helper reads `appState.activeProject?.board` in `src/renderer/board-state.ts:4-7,22-25`; `moveTask` and `updateTask` use the same active-board accessor. The removal event actually includes `projectId` (`src/renderer/state.ts:793`), but the listener drops it.
- **Impact:** When a session in project A finishes or is closed while project B is selected, A's linked card is not moved or unlinked. A task in B cannot have the same UUID in normal operation, so the usual outcome is stale state in A.
- **Recommendation:** Resolve the board by the session's owning project for status and removal events; test a two-project scenario while the other project is selected.

### F-05 — Medium — A readiness scan writes to the project automatically

- **Feature:** AI Readiness Score.
- **Evidence:** Opening the readiness widget calls `autoScanIfNeeded` (`src/renderer/components/project-tab/widgets/readiness-widget.ts:538-558`). `analyzeReadiness` calls `ensureVibeyardignore` (`src/main/readiness/analyzer.ts:42`), which writes `.vibeyardignore` if absent (`src/main/readiness/checkers/context-optimization.ts:16-24`).
- **Impact:** Simply opening a project overview with the widget can create an untracked file in the project, before the user requests a fix. This changes the user's Git working tree as a side effect of a score calculation.
- **Recommendation:** Apply built-in scan exclusions in memory. Offer creation of `.vibeyardignore` as an explicit action if the user wants to customize exclusions.

### F-06 — Medium — Advertised npm install path cannot run on Linux

- **Feature:** Distribution and first-run install.
- **Evidence:** `README.md:83-90` advertises `npm i -g vibeyard` for macOS, Linux and Windows, with automatic download on first run. `bin/vibeyard.js:180-184` exits with an error on every non-macOS/non-Windows platform before download or launch. `package.json` exposes this script as the npm binary.
- **Impact:** A Linux user following the documented npm instructions cannot launch Vibeyard. The `.deb` and AppImage paths are separate and may work, but were not packaged or run in this audit.
- **Recommendation:** Either implement the Linux npm launcher using the listed AppImage asset or restrict the README npm claim to supported platforms.

### F-07 — Medium — Green persistence tests do not verify the final state-file write

- **Feature:** Project/session/preferences persistence and test coverage.
- **Evidence:** `src/main/store.ts:79-88` writes a temp file and must call `fs.renameSync` to replace `state.json`. The `fs` mock in `src/main/store.test.ts:3-8` omits `renameSync`. The save tests at `src/main/store.test.ts:73-119` assert only that `writeFileSync` ran. During the passing suite, these tests log `No "renameSync" export is defined on the "fs" mock`; production code catches and logs the error.
- **Impact:** The save tests pass even though, under their test setup, no state file is committed. A regression in the final rename step would remain invisible to those tests.
- **Recommendation:** Mock and assert `renameSync`, and add a real temporary-directory round trip covering save, load and recovery from a temp file.

### F-08 — Low — Concurrent GitHub widget refreshes can display stale results

- **Feature:** Live GitHub PR/issue widgets.
- **Evidence:** `src/renderer/components/project-tab/widgets/github-widgets.ts:201-237` starts asynchronous availability and list requests with no in-flight guard or request sequence. Manual refresh, polling and visibility changes can each call `refresh` (`src/renderer/components/project-tab/widgets/github-widgets.ts:240-285`). Every completed request assigns `items` and renders, regardless of when it started.
- **Impact:** A slower earlier request may overwrite the result of a newer refresh. This can show outdated PR/issue rows or errors until the next poll.
- **Recommendation:** Use a request generation counter or cancellation and apply only the latest response; test out-of-order completion.

### F-09 — Low — Chrome import control promises passwords but imports only cookies

- **Feature:** Embedded browser Chrome import.
- **Evidence:** The browser Import button tooltip says `Import cookies and passwords from Chrome` (`src/renderer/components/browser-tab/pane.ts:165`). The modal says cookies (`src/renderer/components/chrome-import-modal.ts:13-23`), and `src/main/chrome-import/importer.ts:43-83` imports only cookie records.
- **Impact:** Users may expect saved passwords to become available when they do not.
- **Recommendation:** Change the tooltip to describe cookies only.

## Feature coverage matrix

`Code + unit` means the feature has a traced implementation and relevant unit tests. `Code only` means I found the path but no end-to-end confirmation. `Finding` refers to the IDs above. Runtime verification is still required for packaged, networked and CLI-dependent flows.

| Feature | Implementation path and test evidence | Audit result |
| --- | --- | --- |
| Application boot and CLI prerequisite detection | `src/main/main.ts`, `src/main/prerequisites.test.ts`, provider registry tests | Code + unit; packaged startup untested |
| macOS/Linux/Windows packaged targets | `package.json` electron-builder targets, `src/main/auto-updater.ts` | Code only; packaging and signing untested |
| npm first-run launcher | `bin/vibeyard.js`, `README.md` | Finding F-06; no launcher test |
| In-app updates | `src/main/auto-updater.ts`, `src/main/auto-updater.test.ts`, update banner | Code + unit; release feed untested |
| Project add/remove/select and persisted preferences | `src/renderer/state.ts`, `src/main/store.ts`, state/store tests | Code + unit; test gap F-07 |
| Project overview drag, resize and widget persistence | `src/renderer/components/project-tab/grid.ts`, widget registry tests | Code + unit for registry; grid interaction runtime untested |
| Overview provider-tools widget | `src/renderer/components/project-tab/widgets/provider-tools-widget.ts`, main provider config handlers | Code only for the widget; live provider config untested |
| Overview session-history and favorites widgets | `src/renderer/components/project-tab/widgets/sessions-widget.ts`, `favorite-sessions-widget.ts`, session-history state tests | Code + unit for state; widget interaction runtime untested |
| Overview Claude usage and top-files widgets | `usage-stats-widget.ts`, `top-files-widget.ts`, main stats/fs handlers | Code only for widgets; real cache/file scan UI untested |
| AI Readiness score and one-click fix sessions | `src/main/readiness/`, readiness widget, analyzer/checker tests | Code + unit; side effect F-05 |
| Kanban CRUD, drag/drop, search and tags | `src/renderer/board-state.ts`, `board-filter.test.ts`, `board-dnd.test.ts`, board UI | Code + unit |
| Kanban start/resume and auto Done | board card, `src/renderer/board-session-sync.ts`, matching tests | Findings F-03 and F-04 |
| Team personas and member chat | `src/renderer/state/team-state.ts`, team components/tests | Code + unit for state/parsing; live CLI flow untested |
| Predefined GitHub team members | `src/renderer/components/team/github-fetcher.ts`, frontmatter tests | Code only; remote fetch untested |
| Multiple PTY sessions and terminal lifecycle | `src/main/pty-manager.ts`, `src/renderer/components/terminal-pane.ts`, PTY/terminal tests | Code + unit; live CLI PTY untested |
| Per-project shell terminal | `src/renderer/components/project-terminal.ts`, `src/main/pty-manager.ts`, project-terminal tests | Code + unit; live shell untested |
| Split panes and swarm layout | `src/renderer/state/layout-state.ts`, `src/renderer/components/split-layout.ts`, state/layout tests | Code + unit for state; UI layout runtime untested |
| Claude Code backend | provider, hooks, watcher and provider tests | Code + unit; authenticated CLI untested |
| Codex CLI backend | provider, hooks, watcher and provider tests | Code + unit; authenticated CLI untested |
| Copilot CLI backend | provider, hooks and provider tests | Code + unit; authenticated CLI untested |
| Gemini CLI backend | provider, hooks and provider tests | Code + unit; authenticated CLI untested |
| Pi backend | provider, transcript watcher and provider tests | Code + unit; authenticated CLI untested |
| Oh my Pi backend | provider, transcript watcher and provider tests | Code + unit; authenticated CLI untested |
| Separate Claude/Pi/OMP profiles | `src/main/profiles.ts`, profile UI, provider environment tests | Code + unit; simultaneous account login untested |
| Session history, resume and provider handoff | state archive/history, provider resume-handoff, related tests | Code + unit; real transcript compatibility untested |
| Global session deep search | `src/main/session-deep-search.ts`, six provider search tests | Code + unit; large real histories untested |
| Session status, cost and context | hook/transcript sync, session activity/cost/context tests | Code + unit; live provider telemetry untested |
| Session inspector and timeline | inspector components, timeline/utility/state tests | Code + unit for data transforms; full UI untested |
| Smart alerts and desktop/sound notifications | tools and insights detectors/tests; notification modules/tests | Code + unit for detectors; OS notification behavior untested |
| Git panel, branch and worktree status | main Git handlers/watcher, renderer Git panel and tests | Code + unit; live multi-platform Git UI untested |
| File tree, reader, quick open and top files | main fs IPC, renderer file components/tests | Code + unit; large-tree UI runtime untested |
| GitHub PR/issue widgets | `src/main/github-cli.ts`, GitHub widgets/unread tests | Code + unit for CLI parsing/unread; race F-08 |
| Embedded browser, responsive viewport, inspect, draw and flow capture | browser tab/preload components, navigation/flow/draw tests | Code + unit for helpers; live webview and page interaction untested |
| Browser cookie isolation and Chrome import | browser partition selection, `src/main/chrome-import/`, decrypt/profile tests | Code + unit for crypto/profile helpers; import runtime untested; F-09 |
| P2P read-only/read-write sharing | sharing host/guest/crypto tests and share dialogs | Code + unit; security findings F-01/F-02; real NAT traversal untested |
| MCP inspector and provider tools | `src/main/mcp-client.ts`, MCP IPC, inspector/widget | Code only for live server interaction; no dedicated MCP client integration test |
| Themes, zoom, locale and keyboard shortcuts | preferences sections, i18n/shortcut tests, terminal theme tests | Code + unit for helpers; complete UI localization/runtime untested |

## Runtime checks needed to close the audit

1. Launch a packaged build on macOS, Windows and Linux; exercise install/update and each configured CLI backend with an authenticated account.
2. Test two-project board events while the other project is selected, and closing an unfinished linked session.
3. Connect sharing peers across same-LAN, ordinary home NAT, and restrictive NAT; inspect whether any frames arrive before challenge verification.
4. Exercise embedded webview inspection, flow/draw capture, cookie import, profile isolation and browser cleanup in an actual Electron window.
5. Verify persistence after force exit/restart and after a simulated write or rename failure.

No implementation files were changed for this audit.
