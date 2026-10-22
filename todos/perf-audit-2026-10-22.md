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
