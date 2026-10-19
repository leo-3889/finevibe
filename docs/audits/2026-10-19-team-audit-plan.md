# Vibeyard team audit + rename — GOAL spec + execution plan (2026-10-19)

This file is a **goal specification**. A future agent starts it by creating a goal from §0, executes §1–§14 autonomously with a team (max 4 workers), and marks the goal complete only when the completion contract (§0.3) is fully verified against observable evidence.

## 0. GOAL definition

### 0.1 Objective (verbatim text for `goal` tool `create`)

> Run the Vibeyard team program defined in `2026-10-19-team-audit-plan.md` (in-repo at `docs/audits/` until Phase 0 moves it to `<llm>/plans/`; that is the canonical path thereafter) to completion: (1) execute four parallel read-only audits — code cleanup, performance (measured), architecture, and the unpushed-commit merge map — writing every artifact into the uncommitted LLM docs base folder `<llm>/`; (2) consolidate findings into an approved backlog and obtain the user's clarification answers at the single gate (§4); (3) fully implement the LLM/human documentation separation (Wave E, §7A): LLM-only docs leave the repository for `<llm>/` and are NEVER committed again; (4) fully implement the approved remediation waves on integration branch `audit-2026-10-19` (≤4 workers, wave gate green after every merge, nothing pushed); (5) fully implement the application naming change on `feat/rename` per §8, including userData migration, launcher/updater, full source sweep, repo surface, and packaged smoke; (6) close with the final gate and a report appended to `<llm>/AUDIT_STATUS.md`. Full autonomy between gates; hard rules in §2 are inviolable.

`goal create` with no token budget; `goal get` at every session resume. Multi-session: the goal persists; resume protocol is §9.

### 0.2 Goal lifecycle rules

1. **Start:** first action of the run is `goal create` with §0.1; before any work, verify the goal exists (`goal get`) and read the state file (§9) if present.
2. **Autonomy:** no user interaction except the two gates — §4 clarification gate and §6 scope approval — plus per-push approval if pushing is ever requested. Everything else: decide, act, record.
3. **Never complete early:** `goal complete` ONLY when every §0.3 criterion is verified in the current tree (§14 rule: evidence, not intent). Budget pressure, turn pressure, or elapsed time are never completion grounds.
4. **Never drop:** `goal drop` is forbidden. If Q1 (new name) is unanswered when phase 4 begins, ask once, then keep the goal active and finish everything reachable; the goal stays **open** until the rename ships — state that explicitly in the final report.
5. **Blocked ≠ complete:** an item marked blocked in the state file (>30 min stall, §9) never blocks the rest of the queue and never justifies completion.
6. **Scope change:** the user overriding a plan decision mid-run → update §0.1's objective via a new goal only through the user; record the delta in the state file and keep executing.

### 0.3 Completion contract — all rows verified, with pointers to evidence

| # | Criterion | Verified by |
|---|---|---|
| G1 | Four audit docs exist in `<llm>/audits/` with evidence per finding: `2026-10-19-{cleanup,performance,architecture,merge-map}.md`; performance doc contains PO-06 measurement tables (tab/history 1/10/50/200) | files present; tables readable |
| G2 | Consolidated backlog exists at `<llm>/audits/2026-10-19-consolidated-backlog.md` and user scope approval is recorded verbatim in the state file | state file §"answers" |
| G3 | Every approved P0/P1/P2 backlog item is either committed on `audit-2026-10-19` or marked blocked with evidence in the state file | `git log`, state file wave table |
| G4 | Merge plan (W4) executed locally: merges applied, fully-merged branches deleted per approval, stash@{0} disposition recorded | state file Wave M row; `git branch -vv` |
| G5 | Wave gate (§10) green after every integration merge; final gate green on the integration tip; counts recorded | state file gate table |
| G6 | Rename complete on merged tip: `git grep -i vibeyard` returns only the §8.N6 allow-list; identity sites per §1 renamed; migration test green; `npm start` smoke observed (window title, new userData dir, updater feed) | grep output, test run, smoke notes |
| G7 | `<llm>/AUDIT_STATUS.md` final report appended: exact test counts, gate hashes, blocked items, remaining open items (incl. AUDIT_STATUS item 5 live integration) | doc section |
| G8 | State file closed with final wave table; `todo` list fully resolved; no orphan worktrees (`git worktree list` clean) | files/commands |
| G9 | Doc separation (Wave E, §7A) complete: `git ls-files docs/ personas/ .claude/` lists human-facing docs ONLY; `<llm>/` holds the full moved LLM set + rules README; inbound links repaired; CLAUDE.md pointer present; full gate green | `git ls-files`, `ls <llm>/`, gate output |

### 0.4 Executor profile

One coordinator agent, full autonomy, **max 4 workers concurrently**, expected 7–11 h across sessions. Durable state lives only in the state file (§9) — agent memory is not state.

Execution order (phases detailed in §3–§8):

1. Audit: code cleanup
2. Audit: performance optimizations
3. Audit: software architecture optimizations
4. Audit: unpushed-commit merge map
5. **User clarification gate** (one time, before any implementation)
6. Full implementation: LLM/human documentation separation (Wave E, §7A)
7. Full implementation: audit remediation waves
8. Full implementation: application naming change
9. Final gate + report

---

## 1. Ground truth at plan time (2026-10-19)

Re-verify every line at Phase 0; the tree moves.

- **Current branch:** `rebuild`, **no upstream configured**.
- **Uncommitted work on `rebuild`:** ~68 modified files (main + renderer + shared + docs + vitest.config.ts + tsconfig.main.json), 8 untracked source/test files (`agentmemory-manager.ts`, `webview-guest-pin.ts`, `launch-session-dir.test.ts`, `prerequisites.test.ts`, `preferences/agentmemory-section.ts`, …), untracked `dev/`, and `stash@{0}` "agentmemory WIP + 2026-10-18 audit tree (pre-merge 2026-10-19)".
- **Branches:** `main` = `fork/main: ahead 47` (unpushed); `rebuild` (tip `2b25b34`, strictly ff-merged with `main`); merged remediation branches `audit/G1…G9` (not on any remote); `feat/multi-provider-status-and-profile-scoping` (pushed to `fork`).
- **Remotes:** `origin` = `elirantutia/vibeyard` (upstream, push target exists), `fork` = `leo-3889/vibeyard`.
- **Naming surface:** 844 case-insensitive `vibeyard` occurrences across 198 files. `src/`: 674 occurrences / 171 files. Identity-bearing sites: `package.json` (`name`, `bin.vibeyard`, `build.appId=com.vibeyard.app`, `build.productName=Vibeyard`, 4× `artifactName`, `publish.owner/repo=elirantutia/vibeyard`), `bin/vibeyard.js` (15×), `VIBEYARD_RELEASE_REPO` env override (`auto-updater.ts:37`, npm launcher), userData consumers (`ipc-handlers.ts:818` partition prefix `vibeyard-browser-iso-`), locales en/zh-CN, `.github/workflows/package-ubuntu.yml`, issue templates, `build/vibeyard-black.png`, all docs.
- **Known open work items** (from `docs/AUDIT_STATUS.md`): PO-06 watcher cost never measured; item 5 live/packaged integration never exercised; pi/omp/codex/gemini `getTranscriptPath` id guards NOT fixed; launch-dir rule dedup lands "with the working-tree commit".
- **Host constraints:** default Vitest pool times out forks workers on this machine and silently reports unrun files as green — **always** `npx vitest run --maxWorkers=4`. pi-lens disarmed (killed sessions on 2026-10-18); do not reinstall. No hot reload.
- **Doc surface (separation input, §7A):** tracked LLM-only docs: `docs/AUDIT_STATUS.md`, `docs/audits/2026-10-10-full-audit.md`, `docs/OMP_SESSION_DROPS_2026-10-03.md`, `docs/OMP_SESSION_VANISH_2026-10-18.md`, `personas/` (14 files), `.claude/commands/` (3), `.claude/skills/` (2). Human-facing: `README.md`, `README.upstream.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `CLAUDE.md`, `HOOKS.md`, `docs/{FEATURES,packaging,performance,provider-contracts,security-boundaries,session-lifecycle,ui-conventions}.md`. Inbound refs to LLM-only docs live in `docs/performance.md` + `docs/security-boundaries.md` (repaired by Wave E). This plan file is untracked → plain move, no commit.

## 2. Hard rules (every phase, every worker)

1. **NEVER** `git push`, create PRs/issues, rewrite pushed history, delete stashes, touch `dev/`, or edit `CHANGELOG.md` history. Pushes require explicit per-push user approval.
2. Audit phases are **read-only**: no source edits, no git mutations. Only the coordinator commits/merges.
3. Workers MUST NOT run build/lint/tests/formatters mid-wave; the coordinator runs the wave gate once after merging (§10).
4. File ownership is disjoint per wave; `package.json`, `vitest.config.ts`, `tsconfig*`, `src/shared/types.ts`, `src/shared/constants.ts`, and every file in the uncommitted tree are **coordinator-owned** unless explicitly assigned.
5. Every finding carries evidence: `file:line` for static claims, measurement numbers for perf claims. No evidence → finding is dropped at consolidation.
6. Tests never pin the old app name after the rename wave (§8.N4).
7. Do not duplicate closed items: read `docs/AUDIT_STATUS.md` first; the 2026-10-10/10-18 cleanups already removed dead exports, IPC shims, dead locale keys, `tab-bar.ts` monolith.
8. **LLM artifacts live outside the repository.** Any LLM-facing document (audit report, work queue, session/incident note, plan, state file, agent persona, agent command/skill) is written ONLY under the base folder `<llm>/` (§7A) — never in the repo, never committed. Repo `docs/` is human-facing; the sole in-repo LLM pointer is the one CLAUDE.md line.

## 3. Phase 0 — coordinator preflight (~30–45 min)

0. `goal create` with the §0.1 objective (only if `goal get` shows no active goal — a resumed session keeps the existing goal and its answers).
1. Snapshot state: `git status --short`, `git branch -vv`, `git stash list`, `git log --oneline fork/main..main | wc -l`, `git log --oneline fork/main..rebuild` → write to state file (§9).
2. Baseline gate on the committed tree (run from a clean worktree `../vibeyard-baseline` so the dirty tree is untouched): `npx vitest run --maxWorkers=4`, 4× `tsc --noEmit` (`tsconfig.json`, `.renderer`, `.preload`, `.main`), `npm run build`, `git diff --check`. Record exact file/test counts and failures in the state file. Any pre-existing failure is tagged `pre-existing` and excluded from wave-failure attribution.
3. Baseline decision (asked in §4 Q2): commit the WIP on `rebuild` (suggested: one `wip:` commit per coherent area so the working tree becomes clean; `dev/` and stashes untouched). Workers never edit against a dirty tree.
4. Create the integration branch `audit-2026-10-19` off `rebuild` tip (Q3 may redirect this).
5. Dispatch §4 questions. **Phases 1–4 audits may run while answers are pending; phases 6–7 MUST NOT start before the gate is answered.**
6. Create the LLM docs base folder `<llm>/` (Q8 default `../vibeyard-llm/`, a sibling of the repo root — physically outside git) with `plans/ audits/ notes/ state/ personas/ commands/ skills/` and a README stating the rules. Move this plan file to `<llm>/plans/` (untracked → plain move) and start the state file at `<llm>/state/2026-10-19-team-state.md`. All artifact paths below resolve under `<llm>/` after this step.

## 4. Clarification gate — ask once, before implementation (blocking for phases 6–7)

| # | Question | Default if no answer |
|---|---|---|
| Q1 | **New application name?** Product name, npm package name, bin name, appId (`com.vibeyard.app`), artifact prefix, env var `VIBEYARD_RELEASE_REPO`, target GitHub repo. This is the hard blocker of phase 7. | naming phase stays blocked; everything else proceeds |
| Q2 | Commit the dirty working tree on `rebuild` as the clean baseline? (Recommended: yes, per-area commits.) | audits proceed read-only; implementation phases blocked on baseline |
| Q3 | Integration branch = `audit-2026-10-19` off `rebuild`? | yes |
| Q4 | Commit granularity: one commit per finding (`fix(scope): …`, conventional) vs per wave. | per finding |
| Q5 | Confirm push policy: nothing is pushed; user pushes at the end. | no push |
| Q6 | Rename continuity: migrate existing installs' `userData` dir (old→new copy-on-first-launch shim), keep `vibeyard` npm bin alias, keep updating from the old GitHub release feed for one release? | yes / yes / yes for one release |
| Q7 | Out of scope confirm: `CHANGELOG.md` history, `README.upstream.md`, author metadata, git history (names in old commits) stay as-is. | yes, as-is |
| Q8 | LLM docs base folder = sibling `../vibeyard-llm/` (outside the repo, never committed), holding audit queue, audits, incident notes, personas, `.claude/` tooling? | yes, sibling `../vibeyard-llm/` |

Record answers verbatim in the state file. Re-ask only questions that gate a phase about to start.

## 5. Phase 1 — four parallel audits (W1–W4, read-only, ~2–3 h)

Dispatch all four in one `tasks[]` batch (exactly 4 workers — the cap). Each writes exactly one deliverable: `<llm>/audits/2026-10-19-<slug>.md` (base folder — never the repo; §2 rule 8). Finding format (mandatory):

```
### <ID> <one-line title>            [P0|P1|P2|P3]
Evidence: file:line (quote) / measurement table
Impact / Proposed change / Blast radius (files, callsites via LSP references) /
Risk / Test mapping (existing tests to update, test to add) / Effort (S|M|L)
```

Severity: **P0** correctness/security data-loss; **P1** measured perf or user-visible bug; **P2** cleanup; **P3** architecture/refactor.

### W1 — code cleanup (`…-cleanup.md`)
- Dead code: unreferenced exports (LSP `references` per export, not grep), unreachable branches, superseded files/modules, dead IPC handlers (preload↔ipc-handlers parity check both directions), dead locale keys in `en.json`/`zh-CN.json`, unused deps/devDeps (scan imports vs `package.json` deps), unused npm scripts.
- Duplication: repeated helpers across providers/watchers (e.g. path-join id guards, date gating), duplicated test fixtures that mask drift.
- Stale tests: assertions pinning behavior newer commits changed (precedent: the context-menu Paste test), tautological/wiring-only tests, tests that can never go red.
- Hygiene inventory: `TODO|FIXME|HACK|XXX` with owner-ability tag, `console.log` in src, `.only`/`.skip` in tests, `tsconfig.test.json`-style orphans, stray `dev/` contents (inventory only — off-limits to touch).
- Cross-check `docs/FEATURES.md` claims vs code; list doc drift.
- Explicit non-goals: the 2026-10-18 cleanup list (§2.7).

### W2 — performance (`…-performance.md`)
Measure first; every perf finding MUST carry numbers from this machine.
- **PO-06 (mandatory, first):** in a built app (`npm run build && electron .` headless-observable, or a harness script driving main-process functions), measure pi/omp watcher registration delay, polling CPU, RSS, and watcher-handle counts at tab/history sizes 1 / 10 / 50 / 200. This closes AUDIT_STATUS open item 4.
- Codex watcher: verify the `(path, mtimeMs, size)` meta cache (256 cap) under a realistic `~/.codex/sessions` tree; measure decompression count per scan.
- Store persistence: renderer 200 ms throttle + main fsync-on-rename — measure write count/bytes per minute under a simulated persist burst; quit-flush ordering.
- Session deep search + transcript scan: wall time on a large history fixture; check the 512-entry LRU and search cancellation.
- Startup: main-process time to first window (instrumented dev run), `require` graph weight, auto-updater first fetch.
- Bundle: esbuild `--metafile` sizes per entry; top-20 modules.
- Deliverable: measurement tables, then ranked optimizations with expected delta; explicitly mark "measured — no action needed" rows so the queue shrinks.

### W3 — architecture (`…-architecture.md`)
- Layering: main↔renderer boundary violations (renderer importing main code; preload surface size); IPC channel inventory (name, payload type, handler, preload exposure) — flag untyped/`any` payloads and channels with no renderer consumer.
- Provider abstraction symmetry: the six providers' shared contract (`validatePrerequisites`, `getTranscriptPath` guards — pi/omp/codex/gemini unguarded, list exact callsites, spawn arg building, transcript parsing) → propose the single shared mechanism, not per-provider patches.
- Watcher family (codex/pi/omp/pi-compatible/claude): shared polling/attribution core vs five bespoke implementations; feasibility and migration path for a common core.
- Module hotspots: top-15 `wc -l` in src, cyclomatic hotspots, circular imports.
- Persistence design: store.ts responsibilities (load/flush/recovery/migration) — extraction plan.
- Test architecture: forks-worker startup timeouts (why 10 workers die here), jsdom suite cost, integration-vs-unit split.
- i18n: hardcoded strings bypassing locales (count, top files).
- Each recommendation: target design, migration steps, files touched, rollback.

### W4 — unpushed-commit merge audit (`…-merge-map.md`)
Read-only git analysis (no merges, no rebases).
- Enumerate every local branch + stash vs remotes: ahead/behind/patch-equivalent (`git cherry`, `git patch-id` across branches to find duplicate commits — audit/G* branches were ff-merged, so their tips live inside `main`/`rebuild`).
- Authoritative unpushed inventory: `fork/main..main` (47), `fork/main..rebuild`, `main..rebuild` / `rebuild..main` (expect 0/0 after ff-merge — verify), `audit/G1…G9` (merged? `git branch --merged`), feat branches, stash@{0..2} contents (`git stash show -p --stat`).
- For each branch/stash: fully-merged (safe delete) / partially-merged (list unique commits, decide rebase-vs-drop) / unmerged-work (stash@{0} = the agentmemory WIP: classify its files, they overlap the uncommitted tree — reconcile with Q2 baseline).
- Deliverable: merge plan table — source → target (`audit-2026-10-19` / `rebuild` / `main`), method (`--ff-only` preferred per repo precedent, rebase, squash, delete), expected conflicts with file list, verification step. Execution is a Phase 3 wave (coordinator-performed, one at a time, gate after each).
- Flag: `main` vs `rebuild` divergence risk; branch-deletion list requires Q5 confirmation before any push, deletions are local-only.

## 6. Phase 2 — consolidation + approval (~30–45 min, coordinator only)

1. Read all four audit docs; dedupe (W1 dead-code ∩ W3 IPC inventory; W2 cache ∩ W3 watcher core); drop unevidenced findings.
2. Produce `<llm>/audits/2026-10-19-consolidated-backlog.md`: ordered queue P0→P3, each with wave assignment, owner, file set, dependency edges, and the merge-plan rows from W4.
3. Present to the user: summary table + go/no-go per batch + any Q1 answers still missing. **No implementation without this approval.** Explicitly ask which batches are IN for this run (default: P0+P1+P2 and the merge plan; P3 refactors and phase 7 follow the Q1 answer).

## 7. Phase 3 — remediation waves (≤4 workers per wave, ~2–4 h)

Mechanics per wave:
1. Coordinator cuts worker branches off the integration tip: `w/<wave><n>-<slug>`; one `git worktree add ../vibeyard-w<n> w/<wave><n>-<slug>` per worker.
2. Dispatch ≤4 tasks; each task = findings with **disjoint file sets** (from the backlog assignment), full slice context, constraints re-stated, target = commits on its worker branch (conventional, per finding per Q4).
3. Workers self-verify with **targeted suites only** (`npx vitest run <their test files>`) — full gate is forbidden mid-wave.
4. Coordinator merges worker branches serially into the integration branch (expect zero overlap; on conflict, coordinator resolves), runs the full gate (§10). Gate red → attribute per worker commit, re-dispatch the failing finding (do not hand-fix worker code beyond the trivial).
5. Record in state file: commits, gate numbers, re-queues.

Wave plan (re-sliced by file sets at consolidation; wave order is fixed):
- **Wave E (first, §7A):** LLM/human doc separation. Docs-only, zero src risk; runs before Wave A so every later artifact lands in `<llm>/`.
- **Wave A:** P0 correctness/security. Must include the four unguarded `getTranscriptPath` sites, the launch-dir dedup (needs the committed `ipc-handlers.ts` from Q2), and every P0 from W1–W3.
- **Wave M:** W4 merge plan execution (coordinator only, sequential): apply approved merges, delete fully-merged audit/G* branches locally, fold stash@{0} per Q2. Gate after each merge.
- **Wave B:** P1 measured-performance fixes from W2 (watcher core changes stay in Wave D if they are architectural, not tunings).
- **Wave C:** P2 cleanup (dead exports, dupes, stale tests, doc drift). Highest parallelism: slice by top-level dir (`src/main`, `src/renderer`, `src/shared`+`src/preload`, human `docs`+`.github` only — LLM-only files are gone after Wave E and must not be recreated in the repo).
- **Wave D:** P3 architecture, strictly serial (one worker per refactor, gate between): IPC typing pass → provider transcript-guard shared mechanism → watcher core (only if W2 numbers justify) → store extraction.

## 7A. Wave E — LLM / human documentation separation (~45 min, coordinator + 1 worker)

Principle: the repository ships **human-facing documentation** (what the app is, how to use, extend, package it). Agent working documents (queues, audits, session notes, personas, agent tooling) never enter the repo: they live in the base folder `<llm>/` = `../vibeyard-llm/` (Q8), a sibling of the repo root, so they are physically uncommittable.

**E1 — classification (fixed; no worker discretion):**

| Move to | Repo source | Why LLM-facing |
|---|---|---|
| `<llm>/AUDIT_STATUS.md` | `docs/AUDIT_STATUS.md` | self-described "work queue for a local LLM" |
| `<llm>/audits/` | `docs/audits/**` (incl. `2026-10-10-full-audit.md`) | agent audit reports |
| `<llm>/notes/` | `docs/OMP_SESSION_DROPS_2026-10-03.md`, `docs/OMP_SESSION_VANISH_2026-10-18.md` | incident/debug narratives |
| `<llm>/personas/` | `personas/**` (14 files) | agent personas |
| `<llm>/commands/` + `<llm>/skills/` | `.claude/commands/**`, `.claude/skills/**` | agent tooling |
| **stays in repo** | `README.md`, `README.upstream.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `CLAUDE.md`, `HOOKS.md`, `docs/FEATURES.md`, `docs/packaging.md`, `docs/performance.md`, `docs/provider-contracts.md`, `docs/security-boundaries.md`, `docs/session-lifecycle.md`, `docs/ui-conventions.md` | user/contributor contract docs |

Borderline rule: behavior contract → stays in the contract doc; narrative/debug history → moves. A borderline row decided by the W3 architecture audit gets its rationale in the state file.

**E2 — move:** `git rm` each tracked LLM-only file in ONE commit (`docs: move LLM working docs out of the repository`); plain filesystem move for untracked (this plan, state file). Filenames/dates preserved.

**E3 — repair inbound links:** `git grep -n "AUDIT_STATUS\|docs/audits\|OMP_SESSION_\|personas/"` over the repo. Contract docs `performance.md` / `security-boundaries.md` restate the needed behavior inline — repo docs stay self-contained and NEVER link into `<llm>/` (a user's disk has no such path). CLAUDE.md gains one pointer line: agent working docs live in the base folder next to the repo. CLAUDE.md is the single sanctioned LLM pointer.

**E4 — repair `<llm>/` internal links:** LLM docs cross-reference (AUDIT_STATUS ↔ audits ↔ notes ↔ contract docs); rewrite relative paths for the new layout, contract-doc links → `../vibeyard/docs/...`.

**E5 — verify (= G9):** `git ls-files docs/ personas/ .claude/` lists human-facing set only; the E3 grep returns only the CLAUDE.md pointer line; full gate §10 green.

**E6 — forward rule:** every dispatch context carries: artifacts → `<llm>/audits/`, state → `<llm>/state/`, and §2 rule 8. If any agent tooling needs project-local `.claude/` at runtime, copy from `<llm>/` into the untracked `dev/.claude/` (copy only; `dev/` contents remain off-limits).

**History note:** git history keeps the deleted files (no history rewrite, §2.1) — separation is prospective, and the final report states that plainly.

## 8. Phase 4 — application naming change (~1.5–2.5 h, needs Q1)

Dedicated branch `feat/rename` off the integration tip (merge into integration only after §8.N6 is green). Full implementation, not an audit.

- **N1 Identity (coordinator, one commit):** `package.json` — `name`, `bin`, `build.appId`, `build.productName`, 4× `artifactName`, `publish.owner/repo`, mac `NSMicrophoneUsageDescription` string; `build/vibeyard-black.png` → new filename (git mv); icons copied to new name if needed.
- **N2 Launcher/updater (coordinator, same wave):** `bin/vibeyard.js` → new bin name (package.json `bin` updated), internal 15 occurrences, release-repo defaults, `VIBEYARD_RELEASE_REPO` → new env var with **one-release back-compat read of the old name** (per Q6); `auto-updater.ts` feed logic + env override; `npm-launcher.test.ts` + `auto-updater.test.ts` updated in the same commit.
- **N3 Runtime data paths + migration:** every userData-derived path (browser partitions `vibeyard-browser-iso-*`, per-launch session dirs, store `state.json`, export/hook/partition dirs, deep-search dirs — enumerate via `app.getPath` callsites, not grep alone). Per Q6: first-launch migration shim (copy old userData → new dir once, marker file, keep old dir), old partition-prefix string flows from a constant. Test: disk-backed migration test (precedent: `store.integration.test.ts`).
- **N4 Source sweep (up to 4 parallel workers, dir-sliced):** classify the 674 src occurrences: (a) user-visible strings → locales + window/menu titles, (b) symbols/identifiers → `lsp rename` per symbol, never text-rename across files, (c) comments/test fixtures → ast_edit/grep waves, (d) env var names → coordinated with N2. Test fixtures renamed to the new name; **zero tests may pin the old name** after this wave.
- **N5 Repo surface (1 worker):** human-facing set only (§7A E1): README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, HOOKS.md, CLAUDE.md, `docs/*` headers, `.github/` templates + `package-ubuntu.yml`, `.gitignore`. History docs now live in `<llm>/` — sweep them in a separate base-folder pass (same classification, not part of the repo gate); recorded hashes/titles in history docs are never rewritten.
- **N6 Verification:** full gate (§10) + `npx electron-builder --win --dir --publish never` smoke (no upload, no signing) + `git grep -i vibeyard` → must return **only** the allow-list: historical docs (per Q7), `README.upstream.md`, migration shim strings, author repo URLs; plus `grep -ri vibeyard <llm>/` after the base-folder pass. Launch `npm start` once; observe window title, userData dir created at the new path, updater feed, browser-tab partition creation.
- Sequencing: N1+N2 first (one commit, coordinator), then N3, then N4∥N5, then N6. Any collision with a running remediation wave is resolved by finishing the wave first — rename is serialized against everything.

## 9. Coordination, state, recovery

- **State file:** `<llm>/state/2026-10-19-team-state.md` (created at Phase 0 step 6, outside the repo), coordinator-owned, updated at every phase boundary and after every wave merge: phase status, gate numbers, wave table (worker → branch → worktree path → findings → commits), user answers, decisions/deltas to this plan. Any new session resumes **only** from this file + this plan, after `goal get` confirms the active goal (§0.2).
- Dispatch: one `tasks[]` batch per wave; shared context (`# Goal`, `# Contract`: paths, file ownership, severity format, hard rules) in `context`, per-worker slice in `task`. Workers message the coordinator via `write agent://<id>`; coordinator broadcasts invariants via `write agent://all`.
- Crash recovery: uncommitted worktree work is discarded and re-dispatched (commits on worker branches survive); worktrees pruned by the coordinator at wave end.
- Stall policy: any item blocking >30 min (flaky suite, unreproducible measurement) → mark blocked in state file with evidence, continue the queue; report at phase boundary.
- `todo` tool mirrors phases in the coordinator session.

## 10. Gate (every merge into the integration branch)

```bash
npx vitest run --maxWorkers=4          # expect ≥ baseline counts, exit 0
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.renderer.json --noEmit
npx tsc -p tsconfig.preload.json --noEmit
npx tsc -p tsconfig.main.json --noEmit
npm run build
git diff --check
```

Known host flake: forks-worker startup timeouts — rerun the specific file in isolation before calling a wave red (precedent in AUDIT_STATUS 2026-10-18/19).

## 11. Deliverables checklist (= §0.3 completion contract, operational view)

- [ ] `<llm>/audits/2026-10-19-{cleanup,performance,architecture,merge-map}.md` (performance with measurement tables)
- [ ] `<llm>/audits/2026-10-19-consolidated-backlog.md` + user scope approval recorded
- [ ] Remediation commits on `audit-2026-10-19`, green full gate per wave
- [ ] Wave E: repo tracks human-facing docs only; `<llm>/` holds the LLM set + rules README; CLAUDE.md pointer; links repaired (G9)
- [ ] Merge plan executed (local only), branch-deletion list recorded
- [ ] Final report appended to `<llm>/AUDIT_STATUS.md` (exact test counts, hashes of every gate, remaining open items incl. item 5 live integration)
- [ ] State file `<llm>/state/` closed with final wave table

## 12. Explicit non-goals / off-limits
No push/PR/issues; no history rewrite on pushed branches; stashes untouched (triage in W4 report only); `dev/` untouched; CHANGELOG history and git history untouched (moved LLM docs remain in history — separation is prospective, per §7A); **`<llm>/` contents are NEVER committed** (§2.8); no new binary assets without Q1 answer (icon set ships with the answer); no packaged publishing; no pi-lens; no dependency upgrades outside a named finding.

## 13. Time budget

| Phase | Est. |
|---|---|
| 0 preflight + baseline gate | 0.5 h |
| 3 wave E (doc separation) | 0.5 h |
| 1 audits ×4 parallel | 2–3 h |
| 2 consolidation + gate | 0.5 h |
| 3 waves A/M/B/C | 2–4 h |
| 3 wave D (serial refactors) | 1–2 h (IN only if approved) |
| 4 rename | 1.5–2.5 h |
| final gate + report | 0.5 h |

Overrun policy: never compress Phase 0, the clarification gate, or any wave gate. Cut by deferring P3/queue tail to the final report, never by skipping verification.

## 14. Evidence rule (completion predicate)

Every §0.3 criterion is satisfied only by an observed artifact in the current tree: a file, a command output, a test run, a smoke observation recorded in the state file. "Worker reported done", "commit message says", "should pass" are not evidence. The coordinator re-runs each verifying command itself immediately before `goal complete`.
