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
| S1-03 | P1 | state.ts persist + store.ts throttle | beforeunload flush discarded (300 ms throttle, trailing timer dies with process) | FIXED | saveStateSync + flushPersist; renderer side 08aa404; store:saveSync IPC wiring pending IpcAsyncFixes merge |
| S1-04 | P2 | ipc-handlers pty:create log | launch args (tokens) logged | FIXED | redactLaunchArgs shared + spawn-log redaction (08aa404) |
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
| S4-04 | P2 | ipc-handlers fs:listDirs | out-of-home path types fire modal confirm dialog per keystroke prefix | PARENT | after IpcAsyncFixes lands (file owned) |
| PA-07+ | P3 | ipc-handlers enumerateCache | global git:changed invalidation + stale in-flight writeback (no generation) | PARENT | after IpcAsyncFixes lands |
| SR2-a | P2 | tab-bar/index.ts | add/close double strip rebuild (session-added + structural kind) | FIXED | single handleSessionChanged path (0a1f70a) |
| SR2-b | P2 | sidebar clone flow | `cloning` guard never armed; Enter re-enters cloneRepo | FIXED | armed at entry (test caught a re-confirm through the await window), try/finally (0a1f70a) |
| SR2-c | P3 | sidebar path-autocomplete | per-keystroke fs.listDirs, stale responses win | FIXED | 100 ms debounce + seq guard + rejection caught (0a1f70a) |
| SR2-d | P3 | tab-arrows | locale switch never re-translates arrow labels | FIXED | applyArrowLabels on onLocaleChange (0a1f70a) |
| SR2-e | P3 | tab-list/sidebar rename | events during open rename dropped, dead tab clickable | FIXED | dirty flag + replay on commit/cancel; sidebar self-heals (verified, no change) (0a1f70a) |
| SR2-f | P3 | sidebar+tab-bar | duplicate document dismissers run twice | FIXED | pair kept in initTabBar only (0a1f70a) |
| scout2-P2 | P2 | profiles.ts | home ROOT accepted as profile configDir (CLI writes into ~) | FIXED | reject homeRel === '' (33839b7) |
| S2-05 | P2 | codex-session-watcher Linux | recursive fs.watch on ~/.codex/sessions = one inotify watch per dir (nodejs/node#139) | FIXED | non-recursive root+YYYY/MM/DD chain, idempotent per-tick re-arm, rollover retire, error re-arm slot release (764e674, 3 new tests) |
| S1-07/S1-08 | P2 | pi/codex session watchers | 2 s poll cadence, sync listing reads | ACCEPTED | both watchers: per-tick cost bounded (cached statSync per watched dir; codex day-dirs mtime-skipped; 1 s min-spacing floor); poll is the documented correctness guarantee |
| UI3-1 | P1 | file-viewer loadGeneration | global gen makes concurrent diff loads discard each other; losers pinned stale (loaded=false) forever | AGENT | ScoutUI3Fixes (per-instance gen) |
| UI3-2 | P1 | preferences-modal Enter handler | Enter in a nested modal also confirms+closes Preferences | AGENT | ScoutUI3Fixes (stack guard) |
| UI3-3 | P2 | inspector append at cap | cap rotation kills the PA-14 append path (== S4-01) | MITIGATED | 2 s floor (0147167); ring/epoch deep fix open |
| UI3-4 | P2 | quick-open searchFiles | out-of-order listFiles responses; Enter opens the wrong file | AGENT | ScoutUI3Fixes (token pattern) |
| UI3-5 | P2 | file-tree reconcile | superseded burst's insertion pass re-inserts deleted rows as ghosts | AGENT | ScoutUI3Fixes (container gen) |
| UI3-6 | P2 | modal-shell focus | ModalCloser modals never take focus — keystrokes reach the PTY behind the overlay | AGENT | ScoutUI3Fixes (port modal.ts focus) |
| UI3-7 | P2 | inspector row keys | timestamp:type:tool collisions expand parallel tool-call twins together | AGENT | ScoutUI3Fixes (+index) |
| UI3-8 | P2 | board-dnd | pointercancel leaves drag armed; next pointerup commits phantom moveTask | AGENT | ScoutUI3Fixes (cancel on pointercancel) |
| UI3-9 | P2 | mcp-inspector refreshLists | missing destroy guard renders into dead pane | AGENT | ScoutUI3Fixes |
| UI3-10 | P2 | session-export zip failure | failed export leaves generator + transcript fd open (Windows unlink EPERM) | AGENT | ScoutUI3Fixes (destroy generator) |
| UI3-11 | P2 | ipc-handlers fs:topFilesByTokens | no dedup/abort; stacked full repo scans | PARENT | after IpcAsyncFixes lands |
| UI3-12 | P2 | board tag input | Escape (blur) commits the half-typed tag | AGENT | ScoutUI3Fixes (committed flag) |
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

- vitest: full suite green pre-commit at 08aa404 (2958 tests, 4 provider mocks fixed) + targeted green at 33839b7
- tsc (main/preload/renderer): clean at both commits (agent files excluded)
- git diff --check: clean
- commits: 08aa404 (parent slice), 33839b7 (scout-2 slice); integration commits pending agent merges
