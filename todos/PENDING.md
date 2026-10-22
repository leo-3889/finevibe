# Pending todos — consolidated index (audited 2026-10-22)

Every item in `todos/` was re-verified against the working tree + git history (two parallel scouts; evidence in each row). Fully shipped plans moved to [`archives/`](archives/). This file is the single queue of outstanding work; the registry docs stay live in `todos/` as the deep-detail source.

Tree at audit time: `rebuild` @ `436b1fb` + ~62 uncommitted files (the PA perf-fix batch, +3.5k/−0.5k).

## 0. Certification gate (blocks §2)

- [ ] **Certify + commit the PA fix batch.** PA-01…PA-19, PA-22–PA-26, PA-28, PA-31 are fixed **only in the uncommitted working tree** (24/27 rows carry explicit `PA-NN` comments; no commit SHA exists). Run `dev/audit/gate.sh 3` (build + renderer tsc + vitest ×3 + diff-check + doc pointers) and commit. The named commits fa21cd8 / 6187ec7 / 93b9c33 / 180fc83 touch none of these rows.
- [ ] Clean the lint re-flags in that same batch first (pi-lens: `react-hooks/exhaustive-deps`, `max-lines@300`, `no-string-repeat`, `no-useless-spread` in `state.ts`, `session-archive.ts`, `codex-session-watcher.ts`, `tab-list.ts` and tests).
- [ ] PA-06 (stale-`active` expiry) and PA-12 (activation patch) are structurally verified only — cover with the gate run.

## 1. Full audit 2026-10-20 registry — open rows

Source: [`full-audit-2026-10-20-plan.md`](full-audit-2026-10-20-plan.md). Its in-doc status column is stale: waves A–F shipped (F61 fleet record, exit gate 191 files / 2,857 passed / 4 skipped exit 0 at `85a321d`; branch prune F62 done, 26 branches deleted). Tree-true open: **4 P1 · 11 P2 · 1 P3 + 3 partials + F64**. Full finding text at the registry's cited sections.

### P1 (fix first; each needs a regression test that fails before)

- [ ] **P1-13** (Wave B t8) — failed `claude --version` probe caches `null` for the process (`src/main/claude-version.ts:12-27`) → supported hook events collapse to baseline (`claude-hook-versions.ts:69-78`), `installHooksOnly` strips user hooks, validation `0===0` reports "complete" (`settings-guard.ts:24-27`). Fix: don't cache failed probes; treat unknown version as fail-closed in hook install/validation.
- [ ] **P1-16** (Wave B t7) — `ensureLaunchSessionDir` prunes the base dir **before** mkdir with no exclusion for the pre-existing resume target; 30-day all-timestamp rule can delete the dir a resume is about to use (`src/main/launch-session-dir.ts:71-82`). Fix: exclude the active/newly created target from the prune sweep.
- [ ] **P1-18** (Wave B t8) — `prepareSettings` swallows every JSON parse error (catch comment "File may not exist yet") and persists the collapsed `{}` (`src/main/claude-cli.ts:255-261`); twin collapse `codex-hooks.ts:123`. Fix: distinguish ENOENT from parse error; on parse error abort + surface, never persist `{}`.
- [ ] **P1-21** (Wave B t7, Gemini half) — newest-mtime fallback mis-attributes transcripts: `return candidates[0]?.full ?? null` (`src/main/providers/gemini-provider.ts:225`) intact; pi-side `COMPATIBLE_SESSION_ID_RE` shipped (`pi-compatible-transcripts.ts:373`, `a21b1fa`). Twin **P2-54** open at the same site.

### P2

- [ ] **P2-18** — MCP config writes plain `fs.writeFileSync` (`claude-cli.ts:718,:777`) despite `writeSettingsAtomically` existing at `:291`.
- [ ] **P2-53** — `getClaudeVersion` caches a null probe for the process lifetime (`claude-version.ts:12-27`); fix lands with P1-13.
- [ ] **P2-55** — copilot `reinstallSettings()` → `installCopilotHooks()` with no project path (`providers/copilot-provider.ts:122-123`).
- [ ] **P2-58** — launch-dir naming collision-unchecked; no uniqueness logic in `launch-session-dir.ts`.
- [ ] **P2-60** — `codex-hooks.ts:123` `readJsonSafe ?? {}` collapse + non-atomic write (twin of P1-18).
- [ ] **P2-61** — `cleanupCodexHooks` (`codex-hooks.ts:244-259`) never removes `[features] codex_hooks=true` from `config.toml`.
- [ ] **P2-69** — search index dir never bumped after the cwd fix: still `search-index-v2` (`session-search-index.ts:14`) → stale index reuse.
- [ ] **P2-72** — stub-echo test: `claude-cli.test.ts:45` stub literal vs `:701` `includes('.toolfailure')` — test passes on echo, not behavior (production side fixed at `hook-status.ts:299-316`).
- [ ] **P2-74** — symlink sweep tests skip Windows: `it.runIf(!isWin)` (`launch-session-dir.test.ts:122,172`).
- [ ] **P2-86** — `settings:validate` IPC calls `validateSettings()` with no args (`ipc-handlers.ts:1961`).
- [ ] **P2-98** — copilot `cleanup()` calls `cleanupCopilotHooks()` with no project path (`copilot-provider.ts:97-99`).

### P3

- [ ] **P3-4** — `removeProfile` early-return behind `isProfileInUse` makes the reference-cleanup loops unreachable (`src/renderer/state.ts:825-836`).

### Partials (finish)

- [ ] **P2-11** — `dev/audit/dup-bodies.js src 5` still reports 8 cross-file duplicate bodies (see PA-34, same list).
- [ ] **P2-12** — coverage includes `src/main/**` + `src/preload/**` (`vitest.config.ts:41-44`); `components/**` still excluded.
- [ ] **P2-75** — unconditional construction assertions added (`hook-commands.test.ts:287-300`); the python behaviour suite is still `describe.runIf(pythonAvailable)` (`:349`).

### Tasks

- [ ] **F64** — CHANGELOG regeneration via the release workflow (CHANGELOG.md last content `19bc19f` v0.3.8).

## 2. Perf audit 2026-10-21 — open rows

Source: [`perf-audit-2026-10-21.md`](perf-audit-2026-10-21.md). 27 of 35 rows fixed in the uncommitted batch (§0). Open:

- [ ] **PA-20** — export sidecars read whole: `session-export.ts` `await fs.readFile` over the 7 suffixes (~`:168`); only the transcript streams (`:127`).
- [ ] **PA-21** — `package.json:41` `build:renderer` still `--sourcemap`, no `--minify`; asar glob unchanged.
- [ ] **PA-27** — `docs/performance.md:76` "four 2-second pollers, each a no-op" doc row unchanged (code half shipped with PA-09).
- [ ] **PA-29** — xterm scrollback at library default at all three Terminal sites (no `scrollback` key in src).
- [ ] **PA-30** — `file-tree.ts:18` `entryCache` uncapped.
- [ ] **PA-32** — renderer `sharing/share-manager.ts:23` `onShareChange(cb): void` — no unsubscribe API (leak by construction).
- [ ] **PA-33** — `agentmemory.log` append-only, no rotation (6187ec7 added the tail UI, not rotation).
- [ ] **PA-34** — 8 cross-file duplicate bodies (live `dup-bodies.js` run): `close`×5, `stripDomainHash`×3, `initials`×3, `cleanHooks`×2, `handleKeydown`×2, `escapeHtml`×2, … (= P2-11).
- [ ] **PA-35** — renderer `index.ts:132-138` `interruptWindows` never pruned.

Standing: the S1–S6 live-run protocol (`docs/performance.md:207-217`) has **never** been run in a packaged app; PO-06 watcher cost never measured in the running app. Every number in the audit remains pre-runtime-verification.

## 3. Shipped-plan remainders (sources in `archives/`)

- [ ] **Codex plan mode** — from `archives/ask-ai-plan-mode-provider-support-plan.md` Phase 2. `codex --help` probe on an **installed** codex binary (CLI not present on this machine; probe documented unrunnable at `codex-provider.ts:59-68`, pinned undefined by `codex-provider.test.ts:107`). If a TUI startup flag exists → set `planModeArg`; else scope the startup `/plan` PTY-input fallback (`planModeStartupInput`) as its own plan.
- [ ] **Ask-AI runtime smoke** — per-provider plan-mode checkbox/flag check under `npm start` (Pi → disabled + tooltip; Claude → `--permission-mode plan` in spawn args). User-executed GUI check; not evidenced in-tree.
- [ ] **Clipboard per-OS acceptance** — from `archives/clipboard-paste-latency-plan.md` §8. All code phases shipped (2cfb68c, 8f77536, 8687755); pending on macOS + Linux(X11/Wayland) machines: P0 baseline rows, P4 screenshot-paste freeze < 50 ms, P5 ≥5× pty:data message reduction, Explorer/Finder/Nautilus file-copy rows, Linux middle-click paste, Wayland permission-denial passthrough (gaps recorded `docs/performance.md:189,205`, FEATURES §24).
- [ ] **file-tree docs rows** — from `archives/sidebar-folder-refresh-plan.md` §Docs (code shipped 5a4b9bd): `docs/FEATURES.md:36` must note disk re-read on expand/panel re-open; `docs/performance.md:86` entry-cache row says entries are "freed only on collapse/project removal" — contradicts `refreshFolderCache` eviction (`file-tree.ts:70-73`).

## 4. Open decision (outside the registries)

- [ ] **userData migration for the vibeyard→finevibe rename** — recorded at `c613d03`: the on-tree rename (`4fc533c`) has **no** userData directory migration; upgrading users lose state. Decide: ship a one-time rename migration at startup, or declare the state reset acceptable and document it.

## 5. Standing constraints (not tasks)

- [`fork-rebuildable-on-origin.md`](fork-rebuildable-on-origin.md) — never force-push/rewrite `feat/multi-provider-status-and-profile-scoping` (upstream PR #167) or pre-rename commits; keep `origin elirantutia/vibeyard` fetchable; rebuild recipe inside.
- GitHub #6/#7 (gh-availability TTL, resolved-candidate execFile) were "IN PROGRESS" in the 2026-10-10 audit; absorbed by E59 sibling work (`d72c4ed`) per scout inference — a one-line check of `github-cli.ts` closes it.
