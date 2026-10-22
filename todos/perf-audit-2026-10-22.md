# Wave F audit — 2026-10-22 (post-Wave-E re-audit)

Loop: 4 read-only scouts over the `b4c0721` tree → parent verifies every
finding against source → fix agents (≤4) → integration gate
(`npx tsc -p tsconfig.main.json/preload/renderer --noEmit`, `npx vitest run`,
`git diff --check`) → commit. Scope: perf, leaks, races, bugs; NOT style/lint,
NOT rows already closed in `perf-audit-2026-10-21.md`.

Scout slices: S1 startup+main/store/IPC-surface, S2 watchers+transcripts+
providers+spawn, S3 renderer core+state+terminals+tab-bar, S4 UI+search+export.

## Findings ledger

| id | sev | file:line | mechanism | verdict | fix |
| --- | --- | --- | --- | --- | --- |
| S1-01 | P1 | main.ts ready handler | boot serializes N sync provider probes before first window | FIXED (wave F pre-commit) | async probe fan-out, 08aa404 ancestry |
| S1-02 | P1 | store.ts saveState/saveStateSync + settings-guard | dual-writer wipes statusLine consent; guardedInstall pre-modal snapshot rolls back renderer state | FIXED | consent-key graft at both writers + fresh loadState post-modal (33839b7), regression test |
| S1-03 | P1 | state.ts persist + store.ts throttle | beforeunload flush discarded (300 ms throttle, trailing timer dies with process) | FIXED | saveStateSync + flushPersist (08aa404); flushPersistSync over store:save-sync sendSync (7b34b9e) |
| S1-04 | P2 | ipc-handlers pty:create log | launch args (tokens) logged | VERIFIED-ABSENT | cycle-2 check (C2-SEC-04): no arg-logging surface at b4c0721 (pty-manager zero logs); 08aa404 contains no redaction code — the `redactLaunchArgs` FIXED row was fabricated; no spawn-path arg/env/prompt logging exists at HEAD |
| S1-05 | P1 | resolve-binary + providers | sync execSync PATH probe on every spawn, fresh env | FIXED | getFullPathAsync + async probes + isWithin (08aa404) |
| S1-06 | P2 | launch-session-dir | per-spawn lstat storm over session dirs | FIXED | realpath per-call cache (08aa404) |
| S1-06b | P2 | launch-session-dir prune | 2000-dir prune SYNCHRONOUS on spawn path, ~10-12k sync syscalls at cap | FIXED | setImmediate off spawn + PRUNE_SCAN_LIMIT 200 (33839b7) |
| S2-03 | P2 | ipc-handlers describePtyExit | exit payload read from mutable ref after 2 s race | FIXED | captured copy (08aa404) |
| S2-04 | P2 | git-watcher Linux BFS | superseded walk keeps arming fs.watch handles | FIXED | generation guard + async flush (08aa404) |
| S3-04 | P2 | git-status poll key | key included session id -> tab clicks always re-spawn git status | FIXED | (project, worktree) key; stale test rewritten (08aa404) |
| S3-07 | P2 | git-status poll() | git:changed push + status-transition polls bypass visibility gate | FIXED | hidden early-return (08aa404) |
| S5-01 | P2 | settings-guard git:changed | every watcher event re-validates + writes state.json (burst amplification) | FIXED | 300 ms burst + 5 s trailing debounce (08aa404) |
| S3-05 | P2 | sidebar session-added/removed | full render wipes Files panel + file-tree cache per tab open/close | FIXED | in-place pill/dot patch, Files panel identity test (0a1f70a) |
| S3-06 | P2 | state batchRemoveSessions | deferRender honored only by split-layout; Close All = 2N full rebuilds | FIXED | deferRender through removeSession + one kick, all consumers gated (0a1f70a, 3 tests) |
| S3-08 | P2 | terminal-pane destroyTerminal | search bar DOM + subscription retained per closed searched tab | FIXED | destroySearchBar first (0147167) |
| S4-01 | P1 | session-inspector event handler | 2000-cap rotation + post-trim window mismatch force 500-row full rebuild every 200 ms tick on streaming sessions | FIXED | trimWindow re-anchors firstWindowTs (append stays incremental, 94a7cfa + test) + full-rebuild fallback floored 2 s with retry (0147167) |
| S4-02 | P2 | board-view boardChangeKey | key omitted title/prompt/notes — renames never re-rendered cards | FIXED | FNV-1a text digest in the key (0147167) |
| S3-02-host | P2 | terminal-pane fitTerminal | host resize never forwarded to guests (onResize hook dead) | FIXED | forwardResize on every real resize (0147167) |
| S4-04 | P2 | ipc-handlers fs:listDirs | out-of-home path types fire modal confirm dialog per keystroke prefix | FIXED | async readdir + memoized consent (db59b82), sidebar debounce (0a1f70a) |
| PA-07+ | P3 | ipc-handlers enumerateCache | global git:changed invalidation + stale in-flight writeback (no generation) | FIXED | enumerateGeneration stamp; superseded runs publish nothing, git:changed routes invalidateEnumerations (0073101, in-flight drop test) |
| SR2-a | P2 | tab-bar/index.ts | add/close double strip rebuild (session-added + structural kind) | FIXED | single handleSessionChanged path (0a1f70a) |
| SR2-b | P2 | sidebar clone flow | `cloning` guard never armed; Enter re-enters cloneRepo | FIXED | armed at entry (test caught a re-confirm through the await window), try/finally (0a1f70a) |
| SR2-c | P3 | sidebar path-autocomplete | per-keystroke fs.listDirs, stale responses win | FIXED | 100 ms debounce + seq guard + rejection caught (0a1f70a) |
| SR2-d | P3 | tab-arrows | locale switch never re-translates arrow labels | FIXED | applyArrowLabels on onLocaleChange (0a1f70a) |
| SR2-e | P3 | tab-list/sidebar rename | events during open rename dropped, dead tab clickable | FIXED | dirty flag + replay on commit/cancel; sidebar self-heals (verified, no change) (0a1f70a) |
| SR2-f | P3 | sidebar+tab-bar | duplicate document dismissers run twice | FIXED | pair kept in initTabBar only (0a1f70a) |
| scout2-P2 | P2 | profiles.ts | home ROOT accepted as profile configDir (CLI writes into ~) | FIXED | reject homeRel === '' (33839b7) |
| S2-05 | P2 | codex-session-watcher Linux | recursive fs.watch on ~/.codex/sessions = one inotify watch per dir (nodejs/node#139) | FIXED | non-recursive root+YYYY/MM/DD chain, idempotent per-tick re-arm, rollover retire, error re-arm slot release (764e674, 3 new tests) |
| S1-07/S1-08 | P2 | pi/codex session watchers | 2 s poll cadence, sync listing reads | ACCEPTED | both watchers: per-tick cost bounded (cached statSync per watched dir; codex day-dirs mtime-skipped; 1 s min-spacing floor); poll is the documented correctness guarantee |
| UI3-1 | P1 | file-viewer loadGeneration | global gen makes concurrent diff loads discard each other; losers pinned stale (loaded=false) forever | FIXED | per-instance gen (0073101, new file-viewer.test.ts) |
| UI3-2 | P1 | preferences-modal Enter handler | Enter in a nested modal also confirms+closes Preferences | FIXED | modalStackDepth>1 guard (0073101, stack test) |
| UI3-3 | P2 | inspector append at cap | cap rotation kills the PA-14 append path (== S4-01) | MITIGATED | 2 s floor (0147167); ring/epoch deep fix open |
| UI3-4 | P2 | quick-open searchFiles | out-of-order listFiles responses; Enter opens the wrong file | FIXED | latestSearchToken + show/hide bump (0073101, new quick-open.test.ts) |
| UI3-5 | P2 | file-tree reconcile | superseded burst's insertion pass re-inserts deleted rows as ghosts | FIXED | shared renderGeneration WeakMap, collapse invalidate (0073101) |
| UI3-6 | P2 | modal-shell focus | ModalCloser modals never take focus — keystrokes reach the PTY behind the overlay | FIXED | focus ownership + MutationObserver (0073101, new modal-shell.test.ts) |
| UI3-7 | P2 | inspector row keys | timestamp:type:tool collisions expand parallel tool-call twins together | FIXED | index-inclusive keys (0073101) |
| UI3-8 | P2 | board-dnd | pointercancel leaves drag armed; next pointerup commits phantom moveTask | FIXED | document pointercancel -> cancelDrag (0073101, ghost/phantom tests) |
| UI3-9 | P2 | mcp-inspector refreshLists | missing destroy guard renders into dead pane | FIXED | identity guards post-Promise.all + in doConnect (0073101, dead-pane test) |
| UI3-10 | P2 | session-export zip failure | failed export leaves generator + transcript fd open (Windows unlink EPERM) | FIXED | zipStream?.destroy() in catch (0073101, destroy-count test) |
| UI3-11 | P2 | ipc-handlers fs:topFilesByTokens | no dedup; stacked full repo scans | FIXED | topFilesScans shared walk per cwd (43fbc6b, open-count test) |
| UI3-12 | P2 | board tag input | Escape (blur) commits the half-typed tag | FIXED | committed + isConnected flags (0073101, 3 tests) |
| UI2-1 | P1 | ipc-handlers fs:listDirs + sidebar | per-keystroke sync readdir + uncoalesced native out-of-home confirm modal (== S4-04) | FIXED | async readdir + memoized per-(window,dir) consent (db59b82); sidebar debounce (0a1f70a) |
| UI2-2 | P2 | inspector trimWindow | startIdx advanced without re-baselining firstWindowTs -> append bails after first trim, ~2.5 full rebuilds/s steady state | FIXED | same fix as S4-01 (94a7cfa, append-after-trim test) |
| UI2-3 | P2 | githubLastSeen writes + docs | PA-31 prune module never existed (docs row fabricated); entries grew per viewed item forever | FIXED | github-last-seen.ts implemented (200 cap) + write-site wiring, 2 tests (3cd11eb); bulk-mark `now` stamp reclassified conservative-by-design |
| UI2-6 | P2 | chrome-import-modal | cleanupFn wired after await -> double-open leaks subscriptions | FIXED | single-flight + sync dismiss binding, disposed-continuation guard (d0c592d, double-open test) |
| UI2-8 | P3 | session-deep-search | pruneSearchIndex full readdir per query burst | FIXED | claimPruneSlot 30 s/provider rate limit (d0c592d, timing test) |
| UI2-9 | P3 | modal-close | per-dialog document Enter closes stacked dialogs | FIXED | Enter routed through modal-manager top-of-stack (onEnter), enterCloseKeydown deleted (d0c592d, 3 tests) |
| UI2-10 | P3 | provider-tools/usage-stats widgets | refresh() without generation guard | FIXED | renderToken guards + destroy bumps (d0c592d, stale/destroy tests) |
| UI2-11 | P3 | predefined-picker | dispose leaves debounce timer armed; open not single-flighted | FIXED | timer cleared on dispose + open single-flight (d0c592d) |
| UI2-12 | P3 | docs/performance.md | growth row names ENTRY_CACHE_CAP; shipped name ENTRY_CACHE_MAX_DIRS | FIXED | doc rename + prune-bound/deferral sync (24d51a2) |

## Gate

- vitest: full suite green at integration — 207 files / 3169 passed, 4 skipped (final, after all slices: db59b82…43fbc6b)
- tsc (main + renderer): 0 errors at final HEAD (state.ts import regressions from 0a1f70a restored in 7b34b9e)
- git diff --check: clean; worktree clean at end of wave
- commits: 08aa404, 33839b7 (audit slices) → 0147167, 24d51a2, 764e674, 94a7cfa, 0a1f70a, db59b82, 3cd11eb, d0c592d, 0073101, 7b34b9e, 97b0b01, 43fbc6b (+ ledger docs commits)
- open by design: UI3-3 deep fix (ring/epoch cap rotation) — mitigated by 2 s floor; S1-07/S1-08 accepted
## Cycle 2 (2026-10-22 ~11:00 UTC, 4 scouts @ HEAD 2439f85)

Scouts: C2PerfMain (main/IPC), C2PerfRenderer (renderer chrome), C2BugsIntegration (Wave-F regression sweep), C2Security (gates/boundaries). 45 findings: 1 P1, 15 P2, 29 P3; duplicates merged (CI-01=SEC-02, CI-09=C2M-10, CI-15⊂C2R-02, C2R-14=CI-07, C2M-01=SEC-02).

| id | sev | file:line | mechanism | verdict | fix |
| --- | --- | --- | --- | --- | --- |
| C2-SEC-01 | P1 | preload.ts store block | 7b34b9e added saveSync impl+renderer type but not the preload FineVibeApi interface — tsc -p tsconfig.preload.json fails, build:core/build/start broken at HEAD | FIXED | saveSync declared (4364b29); gate expanded: tsc now main+preload+renderer |
| C2-SEC-04 | P3 | ledger S1-04 | redactLaunchArgs FIXED row fabricated; no arg-logging surface ever existed | FIXED (docs) | row rewritten VERIFIED-ABSENT (this wave) |
| SEC-02/CI-01/C2M-01 | P2 | ipc-handlers store:save-sync | raw ipcMain.on (P2-108 contract): poison payload = fatal main crash, PTYs orphaned, flush lost | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: safeOn + syncFallback returnValue:false; main.ts clearIsolatedStorage wrapped |
| SEC-03 | P2 | provider:getConfig | renderer projectPath/configDir verbatim → arbitrary dir read | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: managed-configDir + isWithinKnownProject gates |
| SEC-05 | P3 | confirmHomeOutsideListing | dialog labels raw path, listing follows canonical target (symlink deception) | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: prompt names canonical key |
| C2M-02 | P2 | main.ts boot | PATH cache cold: first PTY spawn pays sync execSync probe on main (short-circuited by agentmemory probe) | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: getFullPathAsync prewarm in boot fan-out |
| C2M-03/CI-08 | P2/P3 | fs:topFiles | no result cache (re-scan per widget mount) + shared scan ignores enumerateGeneration | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: 30 s result cache + git:changed invalidation + generation supersede |
| C2M-04 | P3 | flushPtyData | outbox deleted by sessionId — re-spawn's fresh outbox killed by old exit callback | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: identity-guarded delete |
| C2M-07 | P3 | scanTopFiles | 16×10 MiB buffers + sync tokenize; uncancellable | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: 1 MiB read budget, scaled estimate |
| C2M-08 | P3 | enumerateProjectFiles | git branch unbounded vs fallback MAX_FILES 5000 | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: cap git branch |
| C2M-10/CI-09 | P3 | confirmHomeOutsideListingOnce | answer-only memo; concurrent listDirs stack native dialogs | FIXED | 855c310/c4164be/c9625b3/19e350f slice A: in-flight promise memo |
| C2M-05 | P3 | session-transcript-sync | read failures never arm backoff (codex .zst compaction): 2 s churn forever | FIXED | 855c310/c4164be/c9625b3/19e350f slice B: read-failure backoff |
| C2M-06 | P3 | session-deep-search | shared in-flight read raced against first caller's abort → co-waiters lose results | FIXED | 855c310/c4164be/c9625b3/19e350f slice B: per-waiter raceAbort |
| CI-02 | P2 | session-export | UI3-10 fix incomplete: JSZip destroy() never releases SOURCE fds → Windows transcript lock + fd leak on failed export | FIXED | 855c310/c4164be/c9625b3/19e350f slice B: hoist sources[], destroy all in catch |
| C2R-01 | P2 | session-inspector startResize | mousemove/mouseup leak on release-outside-window (S3-01 twin) | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: pointer capture pattern |
| C2R-02/CI-15 | P2 | timeline expand keys | UI3-7 index-inclusive keys drift on 2000-cap in-place rotation (expansion hops rows; stale keys unbounded) | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: monotonic seq at ingestion, seq-keyed, prune on rotation |
| CI-03 | P2 | timeline cap guard | ts-equality cap-shift guard passes on same-ms boundary events → silent freeze (fallback disarms) | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: object-identity guard |
| C2R-03 | P2 | git-status session-changed | manualOverride cleared on kind:'metadata' (auto-title/CLI-id adoption) → worktree pick vanishes | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: gate to activate/payload-less |
| C2R-04 | P2 | session-inspector-state addEvents | JSON.stringify every ingested event app-wide, inspector closed included | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: cheap estimate while closed |
| C2R-05 | P3 | git-status cache | composite project:worktree keys survive project removal | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: prefix prune |
| C2R-06 | P3 | git-status detectSessionWorktree | getCwd IPC per event, result discarded when ≤1 worktree | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: hoist check + trailing timer |
| CI-05 | P2 | session-inspector auto-follow | ignores deferRender: Close All → N full panel rebuilds | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: gate |
| CI-16 | P3 | closeInspector | fullRenderRetry timer survives close | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: module-scope + clear |
| CI-17 | P3 | file-tree collapse | only direct subContainer invalidated; deep in-flight renders paint detached | FIXED | 855c310/c4164be/c9625b3/19e350f slice C: subtree invalidate |
| C2R-07 | P3 | git-status-bar create branch | async confirm, Enter re-fires → N branch spawns (SR2-b sibling) | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: creating flag |
| C2R-08 | P3 | tab-bar github-unread | full strip rebuild per notify; patchUnread already covers dots | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: patch-first |
| C2R-09 | P3 | split-layout onSessionAdded | panes built from activeProject, not payload projectId (background adds → wrong cwd) | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: owner resolve/skip |
| C2R-10 | P3 | tab-list drag | render wipe mid-drag leaves dwell timer + draggingSessionId | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: reset on render |
| C2R-11 | P3 | sidebar suggest | 100 ms timer survives modal close | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: registerModalCleanup |
| C2R-12 | P3 | tab-bar+sidebar layout-changed | full rebuilds (sidebar wipes+re-reads file tree) on layout toggles, layout unread | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: drop subscriptions |
| CI-04 | P2 | board-dnd pointercancel | skips dragEndCallbacks flush → deferred renders never land (stale board, touch); test pinned the bug | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: shared finish path, amend test |
| CI-06 | P2 | sidebar onSessionRowsChanged | ignores deferRender, full render() per batched removal | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: gate |
| CI-07/C2R-14 | P2 | board-session-sync | per-event fullScanSync+updateTask, ignores deferRender | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: gate |
| C2R-15 | P3 | kanban-widget | board-changed full rebuild, no change key | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: reuse boardChangeKey |
| C2R-16 | P3 | board-view singleton | boardEl retained detached after pane destroy; per-tick patches scan dead tree | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: resetBoardView |
| C2R-17 | P3 | insights dismissed | unbounded persisted array | FIXED | 855c310/c4164be/c9625b3/19e350f slice D: FIFO cap 200 |
| C2R-13 | P3 | win32-terminal-keys | latchedKeys set grows per closed Windows PTY (no un-latch) | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: unlatchWin32Key on destroy |
| C2R-18 | P3 | project-terminal panel drag | sync fit storm per pointermove (forced layout + reflow) | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: rAF coalesce |
| CI-10 | P3 | chrome-import-modal | open-replace tears down old gen without disposed flag/progress unsub/onClosed | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: full dismiss |
| CI-11 | P3 | predefined-picker | load catch writes after dispose | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: disposed guard + in-flight fetch share |
| CI-12 | P3 | provider-tools widget | catch wipes body before token check (blank live widget) | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: guard |
| CI-13 | P3 | mcp-inspector | callTool/readResource/getPrompt legs lack instance identity guard | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: guards |
| CI-14 | P3 | mcp-inspector destroy | disconnect fires while connect in flight → orphaned MCP server | FIXED | 19e350f renderer: chained post-connect disconnect; 855c310 main: connect closes transports landing on an active disconnect tombstone |
| CI-18 | P3 | member-sessions-modal | static #modal-overlay path never focuses → keystrokes hit PTY | FIXED | 855c310/c4164be/c9625b3/19e350f slice E: focus + restore |

### Cycle 2 gate

- vitest: full suite green at integration — 211 files / 3216 passed, 4 skipped (was 207/3169; +4 suites, +47 tests)
- tsc (main + preload + renderer): 0 errors (preload added to the gate after C2-SEC-01)
- git diff --check: clean; worktree clean at end of cycle
- commits: 4364b29 (P1 preload) → 855c310 (main) → c4164be (inspector/git-status) → c9625b3 (chrome/board/sidebar) → 19e350f (panes/modals/widgets) + this docs commit
- process: 2 scout findings (C2M-05/06) fell out of the fan-out task lists and were fixed inline by the parent; fan-out checklists must be diffed against the ledger before launch (done at integration)
- open by design: UI3-3 ring/epoch deep fix (unchanged); S1-07/S1-08 accepted (unchanged)

## Cycle 3 (2026-10-22 ~12:20 UTC, 4 scouts @ HEAD dc7c645)

Scouts: C3RegressionSweep (cycle-2 commits 2439f85..dc7c645), C3MainPeriphery (providers/readiness/chrome-import/settings), C3RendererPeriphery (sharing/widgets/preferences/state), C3Contracts (IPC/event/test-pinning/docs — pending at ledger write). 29 findings fixed in-flight: 3 P2, 26 P3; renderer-periphery ids renumbered C3R→C3RP (collision with regression sweep).

| id | sev | file | mechanism | verdict | fix |
| --- | --- | --- | --- | --- | --- |
| C3R-01 | P3 | session-inspector-state.ts:50 | exact-size gate is global inspector-open, not per-session → stringify storm returns app-wide while panel open on any session | FIXED | slice B: per-session gate + test |
| C3R-02 | P3 | session-inspector-timeline.ts:531 | CI-15 prune deletes seq-prefixed keys that C2R-02 made rotation-stable → expansions collapse every rotation | FIXED | slice B: prune loop deleted, pinning test repointed |
| C3R-03 | P3 | session-transcript-sync.ts:333 | nextReadAt gate discards fs.watch-triggered resyncs up to 60 s | FIXED | slice B: watch lifts backoff + test |
| C3R-04 | P3 | kanban/pane.ts:53 | destroyKanbanPane resets board-view singleton owned by visible pane (2 projects) → visible board freezes | FIXED | slice B: resetBoardViewIf(paneEl) + 2 tests |
| C3R-05 | P3 | session-inspector.ts:320 | startResize re-entry leaves orphaned pointermove handler → width jitter after touch tap | FIXED | slice B: arm-on-entry guard + test |
| C3M-01 | P2 | codex-provider.ts:279 | .zst index decompresses full 64 MiB compressed prefix, no break on budget.full, unbounded decompressed expansion (≥1000:1 zstd) → main memory bomb via deep search | FIXED | slice A: break + counting Transform cap; bomb repro test |
| C3M-02 | P2 | readiness/utils.ts:17 | execSync ls-files no maxBuffer → ENOBUFS >~30k files → [] → silent readiness score collapse; sync 5 s main freeze | FIXED | slice A: async execFile, 8 MiB maxBuffer, 5000 cap |
| C3M-03 | P3 | codex-provider.ts:201 | getTranscriptPath sync full-tree scan of ~/.codex/sessions on main | FIXED | slice A: newest-400-day-dir bound + boundary test |
| C3M-04 | P3 | chrome-import/decrypt-win.ts:72 | legacy DPAPI rows: powershell spawn per row, sync on main | FIXED | slice A: 1 spawn/import, cached failure |
| C3M-05 | P3 | settings-guard.ts:157 | statusLineConsentByDir never pruned → unbounded state.json growth | FIXED | slice A: prune dead dirs + FIFO cap 200 + tests |
| C3M-06 | P3 | gemini-provider.ts:293 | ≤64 MiB JSON readFile+parse on main (index + discovery fallback) | FIXED | slice A: 8 MiB cap both paths + tests |
| C3M-07 | P3 | claude/copilot/codex indexers | no break on budget.full → full 8 MiB line-split cost after extraction done | FIXED | slice A: break; provable via non-ending stream tests |
| C3RP-01 | P2 | top-files-settings-modal.ts:16 | reused modal shell never cleared → N stacked forms, stale Save closures write stale limit | FIXED | slice D: clear body/actions (sibling idiom) |
| C3RP-02 | P2 | peer-host.ts:262 | teardown() detaches onclose before close → all stopShare teardowns silent; share badge claims live viewer forever (privacy-relevant) | FIXED | slice C: fire disconnectCbs at end of teardown |
| C3RP-03 | P2 | webrtc-utils.ts:10 | no bufferedAmount gate → unbounded SCTP queue + guest latency growth on slow links | FIXED | slice C: pending buffer + bufferedamountlow backpressure |
| C3RP-04 | P3 | peer-host.ts:95 | scrollback chunked in UTF-16 units; serialized ESC-dense JSON > ~256 KB cap → un-caught send throw kills keepalive+callbacks, later chunks throw | FIXED | slice C: byte-size chunks + try/catch + connected ordering |
| C3RP-05 | P3 | peer-host.ts:144 | computeChallengeResponse chain lacks .catch → unhandled rejection, auth pending | FIXED | slice C: catch → teardown |
| C3RP-06 | P3 | share-manager.ts:111 | pendingJoinHandles has no join-wide timeout → dead RTCPeerConnection + entry until quit | FIXED | slice C: 30 s join watchdog |
| C3RP-07 | P3 | state.ts:575 | removeProject leaks transcriptFlags entries per CLI session | FIXED | slice D: delete flags in loop |
| C3RP-08 | P3 | index.ts:158 | isMcpSession full projects×sessions scan per PTY chunk | FIXED | slice D: O(1) findSessionWithProject |
| C3RP-09 | P3 | agentmemory-console.ts:94 | 1 s poll: no document.hidden gate, no in-flight guard | FIXED | slice D: hidden gate + inFlight |
| C3RP-10 | P3 | profiles-section.ts:198 | un-latched async onConfirm → double Enter provisions 2 dirs/profiles | FIXED | slice D: in-flight flag (SR2-b idiom) |
| C3RP-11 | P3 | general-section.ts:253 | save() = up to 10 setPreference persist+emit → 10 full re-theme fan-outs per click | FIXED | slice D: setPreferences batch mutator, one emit |
| C3RP-12 | P3 | sessions/favorite-sessions widgets | history-changed payload projectId ignored → cross-project widget rebuilds | FIXED | slice D: filter by projectId |
| C3RP-13 | P3 | project-tab/grid.ts:184 | grid.addWidget null → record already pushed → persisted unremovable ghost widget | FIXED | slice D: placeWidget bool + splice |
| C3RP-14 | P3 | readiness-widget.ts:558 | per-instance scanning flag → duplicate full scans per project-tab session | FIXED | slice D: module-level Set guard |
| C3RP-15 | P3 | github-widgets.ts:78 | ensureRepo caches only success → detectRepo spawn per minute per widget for remote-less projects | FIXED | slice D: cache negative |
| C3RP-16 | P3 | favorite-sessions-widget.ts:33 | favorites list uncapped (only 500-history bound) | FIXED | slice D: cap 50 |
| C3RP-17 | P3 | hover-card.ts:62 | show timer fires against detached anchor → stuck card at corner | FIXED | slice D: isConnected check |
| C3A-01 | P2 | ipc-handlers.ts:2183 mcp:removeServer | renderer-supplied configDir/projectPath both identify AND authorize the write target (self-built allowlist in claude-cli.ts:741-758) → destructive rewrite of any .claude.json/.mcp.json/settings.json on disk | FIXED | slice E: isManagedMcpConfigDir + isWithinKnownProject gates (addServer idiom) |
| C3A-02 | P3 | ipc-handlers.ts:1379 config:watchProject | unvalidated projectPath → fs.watch any config tree + displace real watcher (git:watchProject gates the same arg) | FIXED | slice E: isWithinKnownProject gate |
| C3A-03 | P3 | session:exportArchive/transcriptExists/buildResumeWithPrompt | projectPath unvalidated into getTranscriptPath → transcript oracle/handoff text for foreign projects (getConfig gates both args) | FIXED | slice E: getConfig gate on all three |
| C3A-04 | P3 | preload.ts:385 menu:next/prev/goto-session | dead IPC: main/menu.ts never sends; 3 listeners + registrations never fire | FIXED | slice E: delete bindings/types/registrations |
| C3A-05 | P3 | state.ts:1516 overview-layout-changed | dead emit, zero subscribers repo-wide | FIXED | parent: emit + EventType removed, persist kept |
| C3T-01 | P3 | share-manager.test.ts:60 | mock factory lacks resizeRemoteTerminal → guest-resize leg has zero coverage | FIXED | slice E: mock + assertion |
| C3T-02 | P3 | sidebar-clone.test.ts:66 (+sidebar-preferences:20) | file-tree mock lacks FILE_MANAGER → context-menu path throws, silent drift | FIXED | slice E: add to factories |
| C3T-03 | — | session-inspector.test.ts:59 | claimed dead split-layout mock | VERIFIED-ABSENT | session-inspector.ts:46/:75 dynamic-import split-layout (cycle-break) — mock is a real dependency edge |
| C3D-01..23 | P3 | docs/* | PRUNE_SCAN_LIMIT 2000→200; group members 8→12; SCROLLBACK name/value; pre-rename vibeyard identities (dirs/paths/bin/env/module); §29 phantom channels + 3 missing; row bounds missing (topFiles cache, TOKEN_SCAN_READ_BYTES, MAX_PROJECT_FILES git branch, DISMISSED_CAP); consent memo/in-flight contract; MCP tombstone; seq identity + prune + watch-chain + read-backoff docs; ~60 drifted cites across 5 docs; 8 stale (N ln) claims | FIXED | slice F docs |
| C3L-01 | — | file-viewer.ts:1123 | alleged maxOutputBytes loop off-by-one | VERIFIED-ABSENT | file is 255 lines; no maxOutputBytes in src |
| C3L-02 | P3 | file-viewer.ts loadDiff call sites | 3 fire-and-forget loadDiff().catch missing; closeSessionIfFileMissing await outside try/catch → unhandled rejection, blank pane | FIXED | leftovers: loadDiffGuarded wrapper, existing failure state |
| C3L-03 | — | chrome-import-modal.ts:137 | alleged unguarded import promise | VERIFIED-ABSENT | import handler awaits in try/catch, surfaces in modal (L174-179) |
| C3L-04 | — | quick-open.ts:130 | alleged async close missing await + uncancelled search | VERIFIED-ABSENT | hideQuickOpen sync; latestSearchToken++ is the repo cancel idiom; timer cleared |
| C3L-05 | P3 | file-viewer/chrome-import-modal/quick-open innerHTML sites | live innerHTML on data-bearing lines (diff line, note template, item template) | FIXED | leftovers: textContent/replaceChildren/createElement refactors, unused escapeHtml imports removed |

### Cycle 3 gate

- vitest: full suite green at integration — 211 files / 3241 passed, 4 skipped (was 3216; +25 net: bomb-repro, gate, teardown-notification, batch-mutator, resize-latch tests)
- tsc (main + preload + renderer): 0 errors; one integration fix in state.setPreferences (Object.assign — union-key writes are untypeable)
- git diff --check: clean; worktree clean at end of cycle
- commits: 266f342 (main indexing/readiness/watcher) → 6278dfe (IPC gates) → 7378e6d (inspector/board) → b336eea (sharing) → d2dc22a (widgets/prefs/views) → d372acb (dead menu IPC + mocks) → c019eff (docs) + this ledger commit
- totals: 65 findings this cycle (4 scouts + 5 leftovers) — 61 FIXED, 4 VERIFIED-ABSENT (phantom claims caught by verify-before-fix discipline)
- process: pi-lens auto-gates replayed stale pre-edit captures throughout the cycle; triaged by fresh LSP probes per slice instead of chasing the gate; sidebar xss-innerhtml history dispositions (esc()'d static templates) committed with slice B
- open by design: UI3-3 ring/epoch deep fix (unchanged); S1-07/S1-08 accepted (unchanged)

## Cycle 4 (2026-10-22 ~13:40 UTC, 3 scouts @ HEAD c62d821)

Scouts: C4Github (github module main+renderer), C4Team (team/swarm surface), C4Shell (app shell, updater, launcher, notifications). 28 findings: 5 P2, 23 P3. Ids: github keeps C4G-*, team renumbered C4TM-*/C4T-01, shell renumbered C4S-* (all three scouts emitted C4G).

| id | sev | file | mechanism | verdict | fix |
| --- | --- | --- | --- | --- | --- |
| C4G-01 | P2 | github-unread.ts:23 | unread ids never pruned when items vanish (merged/closed upstream, state=open poll) → project-tab dot lit forever | FIXED | slice G: prune on exhaustive fetch |
| C4G-02 | P2 | github-widgets.ts:269 | every widget self-registers visibilitychange → window-show fans out (tabs×2) gh-CLI spawns, unthrottled | FIXED | slice G: 30 s staleness gate |
| C4G-03 | P3 | github-widgets.ts:42 | PRs-widget 'Mark all read' clears shared project set incl. issues, stamps unseen items seen | FIXED | slice G: honest relabel + locales |
| C4G-04 | P3 | github-cli.ts:98 + widget poll | opaque gh errors, fixed 60 s cadence on rate-limit/auth (secondary search limit 30/min) | FIXED | slice G: classify + exp backoff cap 30 min |
| C4G-05 | P3 | github-widgets.ts:58 | detectAttempted/resolvedRepo never invalidated on remote add/repoint (tab lifetime) | FIXED | slice G: clear on git:changed |
| C4G-07 | P3 | discussions-badge.ts:51 | no inFlight on hourly poll; hide/show stacking fetches | FIXED | slice G: inFlight flag |
| C4G-08 | P3 | team/github-fetcher.ts:16 | fetches without timeout; hung loadInFlight promise = picker 'Loading…' forever | FIXED | slice G: AbortSignal.timeout(15 s) |
| C4TM-01 | P2 | team/predefined-picker.ts:51/395 | hand-rolled overlays never take focus → keystrokes + Enter fall through to the live PTY (CI-18 class) | FIXED | slice T: capture/restore focus + search autofocus |
| C4TM-02 | P3 | team/chat-control.ts:43 | un-latched Chat button → double-click spawns two member sessions | FIXED | slice T: SR2-b latch |
| C4TM-03 | P3 | state.ts:780 addTeamMember | upstream frontmatter id collision unguarded → delete one persona removes both | FIXED | slice T: unique-suffix on add |
| C4TM-04 | P3 | predefined-picker.ts:196 | success path writes post-dispose (CI-11 residue) | FIXED | slice T: disposed guard |
| C4TM-05 | P3 | tab-group-state.ts:199 | normalizeTabGroups never trims to TAB_GROUP_MAX_MEMBERS → oversized persisted group blocks all merges silently | FIXED | slice T: trim in normalize |
| C4TM-06 | P3 | member-modal.ts:82 → spawn argv | systemPrompt uncapped → E2BIG spawn death for every provider launch of that persona | FIXED | slice T: 64 KiB cap, modal hard error |
| C4TM-07 | P3 | state.ts:830 setTeamPredefinedCache | full suggestion corpus (prompt bodies) persisted into state.json forever, re-stringified per persist | FIXED | slice T: 24 h eviction + 200 cap |
| C4TM-08 | P3 | state.ts:834 | dead notifyTeamChanged public API | FIXED | slice T: delete |
| C4T-01 | P3 | team-state.ts:141 | session ordinal counts live sessions → reused numbers, duplicate tab labels | FIXED | slice T: max-suffix +1 |
| C4S-01 | P3 | appearance-section.ts:91 | save() up to 3 setPreference emits (C3RP-11 class, section missed) | FIXED | slice S: setPreferences batch |
| C4S-02 | P2 | menu.ts:95 | debug role:'toggleDevTools' claims Ctrl+Shift+I → session-inspector shortcut dead on win/linux | FIXED | slice S: accelerator:'' |
| C4S-03 | P3 | menu.ts:98 | Ctrl+Alt+R reload accelerator steals AltGr+R on non-US layouts | FIXED | slice S: Ctrl+Shift+F5 |
| C4S-04 | P3 | about-section.ts:38 | per-click updater listener pairs survive modal close → stale callbacks + listener growth | FIXED | slice S: destroy-time unsub |
| C4S-05 | P3 | update-banner.ts:54 | download failure while 'Downloading…' → banner pinned until next 4 h check | FIXED | slice S: error state + locale key |
| C4S-06 | P3 | auto-updater.ts:79 | 4 h interval + 10 s timeout never cleared; checks fire mid-teardown (quit-confirm hang, macOS) | FIXED | slice S: disposer in before-quit |
| C4S-07 | P2 | main.ts:399 | close-confirm has no watchdog: hung renderer → quit preventDefault'ed forever; kill orphans PTYs, skips flushState | FIXED | slice S: 15 s watchdog → direct teardown path |
| C4S-08 | P3 | main.ts:61 | no render-process-gone handler: crashed renderer = blank window, no recovery outside debug mode | FIXED | slice S: reload on non-clean gone |
| C4S-09 | P3 | notification-desktop.ts:72 (+sound:48) | status-edge notifications unsuppressed: flapping CLI = banner+chime per edge, unbounded Notification Center | FIXED | slice S: 30 s per-session spacing |
| C4S-10 | P3 | bin/finevibe.js:306 + about-section.ts:6 | hardcoded vibeyard URLs (renamed repo; launcher message advertises the P1-7-banned default feed) | FIXED | slice S: derive from RELEASES_URL / finevibe URLs |
| C4S-11 | P3 | bin/finevibe.js:69 | https.get without socket timeout: stalled connection hangs launcher forever, retries unreachable | FIXED | slice S: setTimeout(30 s, destroy) |
| C4S-12 | P3 | store.ts:408 | STATE_DIR created 0755 while payload files are 0600 (P2-101) | FIXED | slice S: mode 0o700 |

### Cycle 4 gate

- vitest: full suite green at integration - 213 files / 3280 passed, 4 skipped (was 211/3241; +2 suites, +39 tests)
- tsc (main + preload + renderer): 0 errors; git diff --check clean
- commits: 8e87ae9 (github) -> 65590ba (team) -> 64e3be7 (shell/updater/launcher) + this ledger commit
- totals: 28 findings (5 P2, 23 P3), all FIXED; no phantom claims this cycle
- open by design: UI3-3 ring/epoch deep fix (unchanged); S1-07/S1-08 accepted (unchanged)
- pi-lens auto-gates: recurring snapshots replayed stale pre-cycle captures all cycle (e.g. file-viewer L445 on a 255-line file, pre-C3L-05 lines); triaged once at HEAD by grep evidence (static skeletons / esc()d templates), single disposition recorded; not chased per-gate

## Cycle 5 (2026-10-22 ~14:15 UTC, 2 scouts @ HEAD 456f525) - OPEN, next session

Time-box reached (15:00 UTC): 19 findings (4 P2, 15 P3) recorded OPEN, NOT fixed. Fix order suggestion: P2s, then C5G-05/C5G-08 (unbounded), then rest.

| id | sev | file:line | mechanism | verdict |
| --- | --- | --- | --- | --- |
| C5R-01 | P2 | split-layout.ts:327 | remote-terminal sessions persist; restored tab has no pane (instances live only during share) -> blank resurrected P2P tab every restart, no connect path, no Disconnect button | OPEN |
| C5R-02 | P2 | peer-host.ts:309 + peer-guest.ts:172 | ICE 'disconnected' (Chromium self-recovers in seconds) tears down authenticated share permanently - no re-handshake path; host+guest both die on a NAT rebind | OPEN |
| C5G-01 | P2 | git-panel.ts:246 | loadFiles has no generation guard - slow getFiles of previous project/worktree resolves last, paints stale repo list (display-only) | OPEN |
| C5G-02 | P3 | git-status.ts:297 | project-removed prunes caches but not manualOverride map - one entry per removed project forever | OPEN |
| C5G-03 | P3 | git-panel.ts:66 | stage/unstage/discard handlers uncaught async - git failure = unhandled rejection + silent stale panel (siblings alert) | OPEN |
| C5G-04 | P3 | board-dnd.ts:115 | CI-04 pointerId filter only on cancel; move/up accept any pointer - second-finger touch commits/ghost-drags mid-gesture | OPEN |
| C5G-05 | P3 | main/git-status.ts:35 | getGitStatus execFile no maxBuffer: porcelain >1 MiB (~20k entries, swarm untracked flood) -> NOT_A_REPO, panel says 'No changes' | OPEN |
| C5G-06 | P3 | file-tree.ts:64 + file-watcher.ts:71 | watchFolder chokidar watches uncapped (git-watcher has MAX_WATCHES 2000) -> inotify exhaustion, errors swallowed | OPEN |
| C5G-07 | P3 | board-view.ts:181 | boardEl singleton re-parented per renderBoard - two visible kanban panes: any board event blanks the non-active pane (C3R-04 fixed teardown, not dual visibility) | OPEN |
| C5G-08 | P3 | board-state.ts:131 | addColumn/addTask/addTag uncapped, persisted per-project -> runaway CLI flow grows state.json unbounded (Appendix A claims caps collected) | OPEN |
| C5G-09 | P3 | FEATURES §2 file-tree row | claims git badges + persisted expand state; code has neither (module Map, cleared on removal) | OPEN |
| C5G-10 | P3 | pty-manager.ts:768 | getPtyCwdWindows no-op on Windows -> session worktree detection inert there (C2R-06 path); macOS symlinked-cwd prefix compare misses | OPEN |
| C5R-03 | P3 | share-manager.ts:134 | guest join never wires onAuthFailed/onEnd (host twin wired at share-dialog.ts:258) - auth death leaves join dialog 'waiting' forever, 30 s watchdog silent | OPEN |
| C5R-04 | P3 | agentmemory-manager.ts:157 | closeLogFd block-scoped inside try; synchronous spawn() throw leaks the log fd (async path covered) | OPEN |
| C5R-05 | P3 | project-terminal.ts:434 | '+ New Terminal' uncapped - N shells x (PTY + xterm + 5000-line scrollback), exited kept until explicit close | OPEN |
| C5R-06 | P3 | session-inspector-timeline.ts:586 | nested children appended to expanded running agent group without g.refresh() - 'N actions' badge + duration frozen until span close | OPEN |
| C5R-07 | P3 | peer-host.ts:295 | guest input payload unvalidated - non-string payloads -> node-pty TypeError -> unbounded console.warn stream per frame | OPEN |
| C5R-08 | P3 | win32-terminal-keys.ts:58 | AltGr encoded LEFT_ALT (0x2) not RIGHT_ALT_PRESSED (0x4); CAPS/NUM lock bits never reported | OPEN |
| C5R-09 | P3 | session-inspector-utils.ts:53 | tool payload slice(0,2000) can split a surrogate pair -> U+FFFD tail (chunkByUtf8Bytes documents the correct idiom) | OPEN |
