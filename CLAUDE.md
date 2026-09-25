# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A terminal-centric IDE desktop app built on Electron that wraps CLI tool sessions. Users manage projects and sessions, each backed by a PTY running a CLI tool (currently Claude Code, with a provider abstraction for future tools like Copilot CLI and Gemini CLI), rendered via xterm.js.

## Build & Run

```bash
npm run build    # Compile all three targets (main, preload, renderer) + copy assets
npm start        # Build then launch Electron app (alias: npm run dev)
```

No hot reload — changes require rebuild + app restart. Requires Node v24 (see `.nvmrc`). No lint tooling.

Cross-platform: macOS, Linux, Windows. Release artifacts (electron-builder): `.dmg`/`.zip` (mac), `.deb`/`.AppImage` (linux), NSIS installer + portable `.exe` (win). CI covers all three platforms.

## Testing

```bash
npm test             # Run all tests once
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report (HTML → coverage/index.html)
```

Vitest with v8 coverage; tests co-located as `*.test.ts`, excluded from production builds via tsconfig `exclude`. Three renderer modules (`session-cost.ts`, `session-activity.ts`, `session-context.ts`) expose `_resetForTesting()`. Main-process tests mock `fs`, `child_process`, `node-pty`, `os`.

## Architecture

Three-process Electron app with strict context isolation:

- **Main** (`src/main/`) — Node.js: windows, PTY lifecycle (`node-pty`), filesystem, persistent state (`~/.vibeyard/state.json`). IPC handlers in `ipc-handlers.ts` dispatch to `pty-manager.ts` and `store.ts`. CLI behavior abstracted via providers (`src/main/providers/`).
- **Preload** (`src/preload/preload.ts`) — `contextBridge` exposing `window.vibeyard` with namespaces: `pty`, `session`, `store`, `profiles`, `fs`, `provider`, `menu`.
- **Renderer** (`src/renderer/`) — Vanilla TypeScript DOM (no framework). `AppState` singleton (`state.ts`) with event-emitter pattern; components subscribe to state changes.

Data flow: renderer → IPC invoke/send → main → PTY/filesystem → IPC send → renderer updates xterm.

Build targets: each process has its own `tsconfig.*.json`. Main + preload compile via `tsc` (CommonJS); renderer bundles via esbuild (IIFE, browser, sourcemaps).

## CLI Provider System

CLI-specific behavior behind a `CliProvider` interface (`src/main/providers/provider.ts`): binary resolution, env vars, args, hooks, config reading, cleanup. Registered in `providers/registry.ts` at startup.

- Each `SessionRecord` pins a `providerId` (default `'claude'`); a project may mix providers.
- Providers declare support via `CliProviderCapabilities`; UI conditionally enables features per-session.
- `ClaudeProvider` (`providers/claude-provider.ts`) holds all Claude-specific logic.
- **System prompt**: `buildArgs` accepts `systemPrompt?` and every provider must honor it (Team feature). Claude → `--append-system-prompt`; Codex → `-c developer_instructions=`; Copilot/Gemini → `--system-prompt`. Renderer passes it via transient `pendingSystemPrompt`, consumed once on first PTY spawn and stripped from `state.json`.
- **Profiles** (multi-login): a `Profile` (`{ id, name, providerId, configDir, managed }`, top-level `state.profiles`) isolates a CLI config dir per login/license. The Profiles UI (Preferences section, project default-profile selectors, New Session dialog) keys off `capabilities.profiles` rather than a hardcoded provider id, so every profile-capable provider is supported — today Claude and Pi. Claude's `buildEnv(..., { configDir })` sets `CLAUDE_CONFIG_DIR`, relocating *everything* (credentials, settings.json, hooks, transcripts); Pi's sets `PI_CODING_AGENT_DIR`. The effective profile is resolved **once at session creation** (`resolveProfile` in `state/specialized-sessions.ts`: explicit > project default > pref, provider-matched) and **pinned** on `SessionRecord.profileId` — never re-derived at spawn. A team-chat member's pin (`TeamMember.profileId`) outranks the whole chain and bypasses `resolveProfile` — resolved via `resolvePinnedTeamProfile`/`resolveTeamChatBackend` (`state/team-state.ts`), with the provider derived *from* the pin so a member can't land on a contradicting backend; only a dangling pin or a non-team-capable provider falls back to the chain. At spawn, `split-layout.ts` looks up the dir from the sticky `profileId` and threads `configDir` through `pty.create` → `spawnPty` → `buildEnv`. `profileId` persists on sessions, archives, and transcripts (so global-search resume reopens under the right dir); `removeProfile` clears it everywhere. Because `CLAUDE_CONFIG_DIR` relocates settings.json, `spawnPty` re-installs hooks + status line per profile dir via `installHooksOnly(configDir)` / `installStatusLine(configDir)` (the status-line *script* stays global in `~/.vibeyard/run/`). Managed dirs at `~/.vibeyard/profiles/<id>/`; provisioning via `src/main/profiles.ts` (IPC `profiles:provision`). UI: Preferences → Profiles; selection in New Session dialog + project settings menu. v1 leaves `getConfig` and the config-watcher on default `~/.claude`. macOS keychain caveat: credentials live in the Keychain under a per-config-dir service name on newer Claude builds; older builds (≤2.1.19) share one entry, bleeding logins across profiles. `claude-keychain.ts` guards this (IPC `profiles:keychainStatus`): `unsupported` blocks Claude profile creation and profile-session spawns (writes an in-pane message, never throws); unknown versions are allowed, never false-blocked; non-macOS is always `supported`. Semver helpers in `claude-hook-versions.ts`.
- **Agent files**: providers expose `agentsDir()` / `installAgent()` / `removeAgent()` (default impls in `providers/agent-files.ts`; Copilot uses `.agent.md`). Team members with `installAsAgent: true` mirror as `<slug>.md` in every installed provider's `~/.<cli>/agents/`, invokable as `/<slug>`. Slug is sticky (`agentSlug`). Collides with non-Vibeyard agents of the same slug — dedup is only within team members.
- **Session-id discovery** (`onSessionStarted?` / `onSessionExited?` on `CliProvider`): providers without a hook system that reports the CLI session id implement these. `pty:create` calls `onSessionStarted` before spawn when `cliSessionId` is null, and `onSessionExited` on PTY exit *after* the `isSilencedExit` check (a re-spawn's async old-PTY exit must not cancel the new registration) and in the spawn-failure catch. Codex tails `~/.codex/history.jsonl` (`codex-session-watcher.ts`); Pi watches `<agentDir>/sessions/<cwd-as-dashes>/*.jsonl` (`pi-session-watcher.ts`) — matches the header `cwd` against the project path (case-insensitive on Windows), pairs simultaneous same-project sessions in filename (ISO-timestamp) order not readdir order, and writes `<uiId>.sessionid` via `hook-status.writeCliSessionId` (the channel `hook-status` forwards as `session:cliSessionId`). Shared Pi on-disk contract (agent dir, 8KB-bounded header readers, header parse) lives in `providers/pi-transcripts.ts`; default+profile transcript-root collection is `collectProfileRoots` in `transcript-utils.ts`. Pi facts: `PI_CODING_AGENT_DIR` is its `CLAUDE_CONFIG_DIR` (profiles work); no hooks/cost/context; resume `--session <id>`; system prompt `--append-system-prompt`; no plan mode.

## Key Components

- `terminal-pane.ts` — xterm.js wrapper per session; WebGL rendering with software fallback; right-click menu via `terminal-context-menu.ts` (every action re-focuses the terminal).
- `state.ts` — Reactive AppState singleton; 300ms-debounced persistence to `~/.vibeyard/state.json`.
- `split-layout.ts` — Tab mode (single terminal) vs split mode.
- **Renders must not touch pane DOM they don't need to.** `renderLayout()` runs on every `session-changed`/`layout-changed`, and re-`appendChild`ing an existing child blurs focus (the find bar lives *inside* `.terminal-pane`) and collapses selections. Rules: every `attach*ToContainer` no-ops when `element.parentElement === container`; pane order fixed by `ensurePaneOrder` via the DOM-free `isInRelativeOrder` (`components/pane-order.ts`); `renderSwarmMode` reuses its wrapper node; focus changes gate through `shouldFocusPane` (`components/pane-focus.ts`) so a render that doesn't change focus never calls `setFocused`; `fitTerminal` skips `pty.resize` when cols×rows is unchanged (a redundant resize clears xterm selections). `spawnTerminal` re-fits **after** `pty.create` resolves — a fit racing the un-awaited spawn is dropped by `resizePty` and the PTY stays at the spawn default. `updateSessionCliId` early-returns on an unchanged id; statusLine writes files only on change (each write costs a persist + full re-render).
- `session-activity.ts` — working/waiting/idle status with debounced transitions.
- `session-cost.ts` — cost tracking via the Claude statusLine (`statusLine` setting), regex fallback for older CLIs. Together with `session-context.ts` feeds the pane's **status rail** (right = `profile · model · $cost | in/out`, left = context meter) off the *same* `session:costData` payload — statusLine writes `{cost, context_window, model}` into one `<sid>.cost` file; no `.context` file. Restore fragility, both load-bearing: (1) `setCostData`/`setContextData` dedupe on unchanged values and `restoreCost`/`restoreContext` seed those maps silently at load, so a resumed session's first payload is deduped away and `onContextChange` never fires (cost self-heals only because its dedupe set includes the ticking `totalDurationMs`); (2) the rail's left cluster is built lazily and hidden by `:empty`, so "no event" renders as "no meter". Hence `createTerminalPane` **pulls both clusters from `getCost`/`getContext` right after `instances.set`** — invariant: a store with a silent `restore*` seeder must be pulled by any lazy-DOM consumer. `ArchivedSession` persists `cost` but no `contextWindow`, so resume-from-history starts both empty.
- **Hook → session-state contract** — full map in `HOOKS.md`; verified against a specific Claude Code version, re-check https://code.claude.com/docs/en/hooks whenever hook handling changes. Three load-bearing points:
  1. **`PostToolUse` fires only on success**; a failed tool run fires `PostToolUseFailure`; a rejected call fires neither. (Misreading `tool_response` as failure fed every successful call into `missing-tool-detector.ts`.)
  2. **A `Stop` is not always a completion** — the main agent stops every time it pauses on parallel subagents. `stop_status_writer.py` resolves from the payload's `background_tasks` array, holding `working` only for `subagent`/`teammate`/`workflow` entries; only a *non-empty* array is authoritative (the CLI filters on an `isBackgrounded` flag fresh subagents lack), empty/absent fall through to the legacy `<sid>.subagents` counter. Never consult `session_crons` — a `/loop` session would never complete.
  3. **Every field in `INSPECTOR_FIELDS` (`claude-cli.ts`) must exist in a documented per-event schema and be read by something.** The type system checks the internal half; whether Claude actually sends the field it can't check — an invented name silently renders a blank timeline row forever. Beware nested keys when reading docs.
  4. **The `.events` reader (`hook-status.ts`) is byte-offset incremental; both ends of the offset are load-bearing.** Advance only to the end of the last *complete* line (advancing past a hook's mid-write tail permanently loses that event — this made prompt-based naming fire one prompt late); reset offset to 0 when it exceeds file size (`/clear` recreates `.events` smaller). The mtime poll processes a file on *first sight* too, so a missed `fs.watch` event recovers — safe because the reader is offset-based and idempotent.
- **Session auto-naming** — `session-title.ts` adopts the CLI's own session title as the tab name. Source: the **`session_name` field of the statusLine stdin payload** (CLI's `--name`/`/rename` value, else its AI-generated topic; key absent until one exists). Hook payloads carry **no** title (verified against the 2.1.237 binary) — the statusLine is the only live source. The statusLine script (`buildStatusLinePython` in `hook-status.ts`) writes `<STATUS_DIR>/<sid>.name` keyed on `CLAUDE_IDE_SESSION_ID`; the watcher forwards `session:sessionName` → `applyCliSessionName`, which skips `userRenamed` sessions, drops titles whose `session_id` doesn't match `session.cliSessionId`, and is gated on `preferences.autoTitleEnabled`. Script rules: write **only on change** (each write = persist + tab re-render; this is why toggling `autoTitleEnabled` on triggers `session:resyncStatus` to replay status files); `json.dumps` so CJK/emoji titles stay ASCII on disk; embed `STATUS_DIR` via `JSON.stringify` — a raw `r'…'` breaks on an apostrophe in a path, and a `SyntaxError` there silently kills cost, context, sessionid *and* name. The wrapper invokes the script **by path** (`~/.vibeyard/run/statusline.py`), never inlined (see `hook-commands.ts` docstring). `.name` is a provider-facing channel any provider may write (today only Claude does).

  Two-phase naming (`preferences.promptNamingEnabled`, default on) splits a **free early name** from a **paid final name**:
  - **Early (free)**: providers declaring `capabilities.selfTitles` (today only Claude) publish via `.name` and it's adopted. Providers without one get a one-shot on their 1st prompt.
  - **Final (paid)**: on the 5th prompt, a one-shot names the session from its full on-disk transcript, frozen via `userRenamed`. Complementary because a CLI titles a session once from its opening topic and never revisits it, so drifting sessions keep stale names. Hand-off needs no extra logic: the final call sets `userRenamed`, which `applyCliSessionName` already bails on. **`session-title.ts` must NOT be gated on `promptNamingEnabled`** (that kills the free path).
  - The one-shot: main-process print-mode call (`src/main/session-naming.ts`, IPC `session:generateName` → `provider.buildOneShotArgs`: claude `-p … --output-format text --no-session-persistence`, codex `exec`, gemini `-p`; Copilot has none). **`--no-session-persistence` is load-bearing** — without it every call journals a transcript that global search then surfaces. Runs through the session's own profile: `resolveConfigDir` returning null **skips the call entirely** (a profile may point at a local model; defaulting to `~/.claude` would silently bill a cloud account). Cost is real (~36k input tokens per call — CLI boot context dwarfs the task), which is why the model is **never overridden**; the profile decides the backend.
  - `extractConversation` returns an **ordered `{role, text}[]`** — order is load-bearing (index-zip user/assistant arrays pairs unrelated moments and starves prompts). `buildConversationInstruction` walks backwards filling `MAX_CONVERSATION_CHARS` (O(n)). Assistant turns clip to `MAX_ASSISTANT_TURN_CHARS` (200) and may total ≤ `ASSISTANT_BUDGET_RATIO` (50%) of budget; over-share turns are **skipped, not breaked** so the walk reaches past agentic tails. Claude's impl skips `isSidechain` entries and keeps user entries with a `promptSource` (`sdk`/`typed`/`queued`), falling back to all user turns for old transcripts. Providers **stream** JSONL (`forEachJsonlEntry`). Char budget is platform-dependent: on Windows the call goes through `cmd.exe` (`claude.cmd`), which truncates at **8191 chars** (not CreateProcess's ~32k) → 6k on win, 16k elsewhere; overshooting silently degrades to the mechanical name.
  - Default names: `session-naming.ts` — `nextNumberFor(key, project)` counts the highest number across sessions *and* history for **every locale's template** of that i18n key (replaces `length + 1` formulas that reused visible numbers). `composeName`/`MAX_SESSION_NAME_LENGTH` live there (not `state.ts` — import cycle) and are shared by both paths. A `/clear` (changed `cliSessionId`) resets the count via `resetSession`; only plain CLI sessions are named; a user rename always wins.
- `components/active-sessions-panel.ts` — cross-project Active Sessions list in the sidebar. `selectActiveSessions()` is DOM-free; rows are open `isCliSession` sessions whose live status is in `preferences.activeSessionStatuses`, ordered by `STATUS_PRIORITY` then project name. Shown only when `sidebarViews.activeSessions` **and** >1 project. Styles in `styles/sidebar.css`.
- `components/git-panel.ts` — Git changes as a `git` panel-toggle tab inside the active project's sidebar card (third `ProjectPanel` alongside history/files). Badge count + `Cmd/Ctrl+Shift+G` toggle. `mountGitPanel` reparents a single persistent node so rows/scroll survive re-renders. No `#git-panel` node in `index.html`.
- `browser-tab/` — Browser tab pane modules: `types`, `instance` (registry + preload path), `navigation`, `viewport`, `selector-ui`, `inspect-mode`, `flow-recording`, `flow-picker`, `session-integration`, `pane` (DOM + events). `browser-tab-pane.ts` is a re-export shim.
- `board-state.ts` / `board-filter.ts` / `board-session-sync.ts` — Kanban CRUD (mutates `activeProject.board` in place + `notifyBoardChanged()`), module-level filter state with observer, session-lifecycle → task auto-moves.
- `components/board/` — board UI: `board-view`, `board-column`, `board-card`, `board-task-modal`, `board-dnd` (injected DOM drop targets), `board-context-menu`. Styles: `styles/kanban.css`.
- **Board task assignee** — a `BoardTask` may carry `assigneeId` (a `TeamMember` id) picked in the task modal; the card shows a name badge (omitted for a dangling id). **Running an assigned task starts a team-chat session as that member** via `appState.startTeamChat(project.id, member, task.providerId)`; unassigned tasks keep the plain session path, and `runTask` falls back to a plain session when no team-capable provider is installed. Referential integrity at the mutation boundary: `addTask`/`updateTask` strip an `assigneeId` that no longer resolves via `appState.getTeamMemberById`; `removeTeamMember` scrubs it and `updateTeamMember` re-notifies the board, so views stay keyed on `board-changed` alone.
- `components/team/` — Team tab (mirrors kanban plumbing): `team-view`, `member-card`, `member-modal`, `predefined-picker` (fetches this repo's `personas/` folder), `github-fetcher` (Contents API + raw download, 1h cache), `frontmatter` (Markdown → `TeamMember`). State at top-level `state.team.members` (global) + `state.team.predefinedCache`; target repo configured by `TEAM_MEMBERS_REPO` in `src/shared/team-config.ts`. Styles: `styles/team.css`.
- `components/project-tab/` — Overview page on a gridstack.js drag-and-drop grid. `pane.ts` (toolbar + grid root), `grid.ts` (gridstack wrapper + tile chrome). Layout persists per-project at `ProjectRecord.overviewLayout` as `{ id, type, x, y, w, h, config? }` (lazy defaults, no migration). Widgets are `WidgetFactory`s in `widgets/widget-registry.ts`: `readiness`, `provider-tools`, `github-prs`, `github-issues`, `team`, `kanban` (reuses board card element; listens only to `board-changed` — no per-session metrics, deliberately, to avoid re-render storms), `sessions` (active + recent archived, click-to-focus/resume, surgical row updates, settings modal), `usage-stats` (reads `~/.claude/stats-cache.json` via `window.vibeyard.stats.getCache()`; `styles/usage.css`). GitHub widgets use `window.vibeyard.github.*` → `src/main/github-cli.ts` shelling out to local `gh` (PATH = `getFullPath()`); repo defaults to git origin (`getGitRemoteUrl`), per-widget settings modal overrides. Unread tracking in `github-unread.ts` + `ProjectRecord.githubLastSeen`; tab bar consults `hasUnreadInProject`. Gridstack CSS copied to `dist/renderer/vendor/` at build (esbuild has no CSS loader). Shared tile chrome in `styles/widgets.css`.
- **Opening a file in a tab** — every "open this path in a reader tab" path goes through `openFileReaderChecked(projectId, filePath, lineNumber?)` (`src/renderer/open-file-reader.ts`), never `addFileReaderSession` directly. Order is load-bearing: `addFileReaderSession` appends the tab and sets `activeSessionId` *before* touching the filesystem, so a stale path spawns a tab that `closeSessionIfFileMissing` reaps seconds later and `removeSession` drops the user on the left neighbour. The helper validates with parallel `fs.exists` + `fs.isDirectory` (a dir reads as `EISDIR` and is never reaped), re-checks `projectId` is still active after the await, never rejects (callers fire `void`; failures are `console.warn`-only). Path normalization shared via `resolveProjectFilePath`. Callers: terminal cmd+click links, Markdown links, file tree, quick-open, provider-tools/top-files widgets. `closeSessionIfFileMissing` stays as the complementary later check (file deleted *while* open). `addDiffViewerSession` still has the unguarded shape.
- **Rendered-Markdown links** — `renderMarkdownContent(content, baseDir?)` attaches one delegated click listener that **always** `preventDefault()`s, then routes via the DOM-free `markdown-link.ts` (`resolveMarkdownLink` → `anchor` | `external` | `file` | `ignore`). `external` → `app.openExternal`; `file` → `openFileReaderChecked` (see **Opening a file in a tab** above); `anchor` → scroll to matching `slugifyHeading`. **No `baseDir` ⇒ no `file` targets at all, absolute included** (the predefined-picker renders network Markdown and `isAllowedReadPath` permits `~/.claude/…`). Suppressing the default is load-bearing: the renderer is a `file://` document, so an un-intercepted relative link navigates the window off the app, destroying every session and PTY. Main-process backstop: `will-navigate` in `main.ts` allows only the app document. Helpers: `resolveRelativePath` (`shared/platform.ts`, root-aware so `..` can't make an absolute path relative), `slugifyHeading` (`shared/slug.ts`, keeps non-latin), `isHttpUrl` (`shared/url.ts`).
- **i18n** — in-house (`src/renderer/i18n.ts`): `t(key)` (dot-path, English fallback, `console.warn` on miss), `getLocale`, `setLocale`, `onLocaleChange`. Catalogs `src/renderer/locales/{en,zh-CN}.json` statically imported. `system-locale.ts` maps `navigator.language` (`/^zh/i` → `zh-CN`). Choice persisted at `Preferences.locale` (type defined inline in `shared/types.ts` to avoid an import cycle). `initI18n()` runs after `appState.load()`; first launch persists the OS choice. `preferences-changed` → `setLocale` + `rerenderOpenPreferencesModal()` (live switch, no Confirm). Language switcher in Preferences → General. v1 translates Preferences sidebar/General/Appearance; other strings stay English.

## Platform Checks

Platform detection is centralized in `src/main/platform.ts` — import `isWin`/`isMac`/`isLinux` (and `pathSep`, `whichCmd`, `pythonBin`) from there; never inline `process.platform === 'win32'` or redefine locally (source or tests). The three-way managed-path branch in `claude-cli.ts` is the one intentional exception.

## Cross-platform paths in tests

When asserting on a path the implementation produced via `path.join`/`resolve`/`normalize`, **never hardcode forward-slash literals** — they fail on Windows CI. Build the expected value with the same primitive:

```ts
expect(mockRm).toHaveBeenCalledWith(path.join('/repo', 'foo.ts'), opts);  // good
expect(mockRm).toHaveBeenCalledWith('/repo/foo.ts', opts);                 // bad
```

Applies to `fs.*` args, `child_process` calls, anything that flows a joined path through.

## File Watching

Two separate watchers:

- **`src/main/file-watcher.ts`** (chokidar; ESM-only but `require`-able under Electron's Node ≥22.12) — for the file tree, file reader, diff viewer. Watches **directories non-recursively** (`depth: 0`), ref-counted via `watchDir`/`unwatchDir` (IPC `fs:watchDir`/`fs:unwatchDir`). Watching the *parent dir* (not the file inode) is deliberate: it survives atomic save/replace (write-temp + rename), which kills an inode watch. Changes coalesce (150ms) into a batched `fs:changed` IPC carrying `FsChange[]`; renderer subscribes via `window.vibeyard.fs.onFsChange`. `stopAllFileWatchers()` wired into `main.ts` teardown. Scope is **lazy** (only expanded folders + parent dirs of open files). The file tree (`file-tree.ts`) reconciles **incrementally** (`reconcileChildren`, keyed by `data-entry-path`) — vanished rows removed (subtree unwatched), new rows inserted sorted, unchanged rows/scroll/selection untouched; bursts flushed per `requestAnimationFrame`. Shared path helpers `dirname`/`isPathUnder` in `shared/platform.ts`.
- **`git-watcher.ts`** — whole working tree for the git-status UI (`git:changed`). Uses a **single recursive `fs.watch`** on macOS + Windows (one OS handle; events filtered via `hasIgnoredSegment` — avoids the macOS FSEvents teardown storm, #142) and keeps the **capped per-dir BFS** (`walkAndWatch`, `MAX_WATCHES`) on Linux, where recursive `fs.watch` is unsupported and previously leaked inotify watches (#139). Fine-grained `.git` watches + 60s status poll unchanged.

## State Persistence

App state (projects, sessions, layout) persists to `~/.vibeyard/state.json` via the main-process store. Saves debounced, flushed on quit. Sessions track `cliSessionId` for CLI resume.

## UI Development

When working on renderer/UI code, the `/ui-dev` skill is automatically invoked. It documents all custom components (dropdowns, modals, alerts, badges), CSS theming variables, styling conventions, and component architecture patterns. Always follow it — never use native `<select>`, never hardcode colors, always reuse existing components.

## Planning

When entering plan mode for a new feature, consider whether the feature (or aspects of it) should be exposed as a user-configurable option in Preferences. If it's relevant, ask the user whether they'd like it added as a config in the prefs before finalizing the plan.

## Post-Implementation

After completing an implementation task, always:

1. Run `/code-review` to review changed code for correctness bugs and reuse/quality/efficiency cleanups. Run it automatically — do not ask the user for permission first.
2. Run `/simplify` to apply reuse, simplification, efficiency, and altitude cleanups to the changed code. Run it automatically — do not ask the user for permission first.
3. Add or update tests as needed to cover the changes.

## Git Workflow

Always use the `/commit` command when committing changes to this project. Do not create commits manually.

Never commit, push, or create pull requests unless the user explicitly asks for it.

`CHANGELOG.md` is auto-generated by the release action (via the `/release` / release-notes flow). Do not edit it as part of coding tasks — changes there will be overwritten at release time.

## Maintaining This File

When your changes affect the architecture, build process, key components, data flow, or any other information documented above, update this CLAUDE.md to reflect the new state. This includes adding/removing/renaming files, changing IPC namespaces, modifying the build pipeline, or introducing new patterns. Keep this file accurate so future sessions start with correct context.
