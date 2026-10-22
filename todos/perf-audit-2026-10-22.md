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
| S3-05 | P2 | sidebar session-added/removed | full render wipes Files panel + file-tree cache per tab open/close | AGENT | TabBarSidebarSlice |
| S3-06 | P2 | state batchRemoveSessions | deferRender honored only by split-layout; Close All = 2N full rebuilds | AGENT | TabBarSidebarSlice |
| S3-08 | P2 | terminal-pane destroyTerminal | search bar DOM + subscription retained per closed searched tab | FIXED | destroySearchBar first (0147167) |
| S4-01 | P1 | session-inspector event handler | 2000-cap array rotation forces the 500-row full rebuild every 200 ms tick on long agent sessions | FIXED (bounded) | full-rebuild fallback floored at 2 s with self-re-arming retry (0147167); rotation-aware append left as the deeper fix |
| S4-02 | P2 | board-view boardChangeKey | key omitted title/prompt/notes — renames never re-rendered cards | FIXED | FNV-1a text digest in the key (0147167) |
| S3-02-host | P2 | terminal-pane fitTerminal | host resize never forwarded to guests (onResize hook dead) | FIXED | forwardResize on every real resize (0147167) |
| S4-04 | P2 | ipc-handlers fs:listDirs | out-of-home path types fire modal confirm dialog per keystroke prefix | PARENT | after IpcAsyncFixes lands (file owned) |
| PA-07+ | P3 | ipc-handlers enumerateCache | global git:changed invalidation + stale in-flight writeback (no generation) | PARENT | after IpcAsyncFixes lands |
| SR2-a | P2 | tab-bar/index.ts | add/close double strip rebuild (session-added + structural kind) | AGENT | TabBarSidebarSlice |
| SR2-b | P2 | sidebar clone flow | `cloning` guard never armed; Enter re-enters cloneRepo | AGENT | TabBarSidebarSlice |
| SR2-c | P3 | sidebar path-autocomplete | per-keystroke fs.listDirs, stale responses win | AGENT | TabBarSidebarSlice |
| SR2-d | P3 | tab-arrows | locale switch never re-translates arrow labels | AGENT | TabBarSidebarSlice |
| SR2-e | P3 | tab-list/sidebar rename | events during open rename dropped, dead tab clickable | AGENT | TabBarSidebarSlice |
| SR2-f | P3 | sidebar+tab-bar | duplicate document dismissers run twice | AGENT | TabBarSidebarSlice |
| scout2-P2 | P2 | profiles.ts | home ROOT accepted as profile configDir (CLI writes into ~) | FIXED | reject homeRel === '' (33839b7) |
| S1-07/S1-08 | P2 | pi/codex session watchers | 2 s poll cadence, sync listing reads | ACCEPTED | both watchers: per-tick cost bounded (cached statSync per watched dir; codex day-dirs mtime-skipped; 1 s min-spacing floor); poll is the documented correctness guarantee |

## Gate

- vitest: full suite green pre-commit at 08aa404 (2958 tests, 4 provider mocks fixed) + targeted green at 33839b7
- tsc (main/preload/renderer): clean at both commits (agent files excluded)
- git diff --check: clean
- commits: 08aa404 (parent slice), 33839b7 (scout-2 slice); integration commits pending agent merges
