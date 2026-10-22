# Skills repository — feature plan (2026-10-22)

> **Status: DESIGN, not implemented.** User request 2026-10-22: finevibe should offer a
> SKILLS repository. Queue row: [`PENDING.md`](PENDING.md) §6 **SKILLS-1**. All `file:line`
> pointers verified against the tree of 2026-10-22 (HEAD `fa14a07` + cycle-7 slice);
> they drift — `node dev/audit/pointer-check.js todos` style re-anchoring on implementation.

## 0. The nine requirements

| REQ | User wording | Plan section |
|---|---|---|
| R1 | Configurable as a section in settings | §3, §4-R1 |
| R2 | Configure a git repository URL | §4-R2 |
| R3 | Check out that repo | §4-R3 |
| R4 | List all skills available | §4-R4 |
| R5 | Offer to place a skill into a selectable coding tool | §4-R5, §6 |
| R6 | Sanity-check the skill via a finevibe session on install | §4-R6 |
| R7 | Periodic pull to catch skill changes | §4-R7 |
| R8 | User PUSH of skill changes to the repo | §4-R8 |
| R9 | GitHub **or self-managed** compatible | §4-R2, §5 |

## 1. Ground truth — what exists, what is absent

**Exists (reuse, do not rebuild):**

| Primitive | Location |
|---|---|
| Git CLI invocation: `execFile('git', argv, {cwd, timeout})`, no shell; `execGit`/`execGitWithOutput` shared helpers | `src/main/git-status.ts:204-220`; all mutations (stage/unstage/branch) follow it; branch argv gated by `requireValidBranch` + `git check-ref-format --branch` (`:251-260`) |
| Gated clone: URL re-validated in main, dest gate, `git clone -- <url> <dest>`, 10-min network bound (`GIT_CLONE_TIMEOUT_MS`) | `ipc-handlers.ts:911-946` (`fs:cloneRepo`), preload `fs.cloneRepo` (`preload.ts:45,247`), clone UI + tests (`sidebar.ts:582-707`, `sidebar-clone.test.ts`) |
| URL validator: scp/ssh/https forms, credential/port rejection, folder-safe `repoName` — **host allowlist github.com/codeberg.org only** | `src/shared/git-url.ts:7-9,30-66` |
| Skill-shape reader: `readSkillsFromDir` — subdirs containing `SKILL.md` + frontmatter name/description, dotdirs skipped; Claude adds plugin-skill merging | `src/main/provider-config-utils.ts:47-63`; `src/main/claude-cli.ts:84-138,782-865` (user `<configDir>/skills`, project `.claude/skills`) |
| Skills dirs already **watched** per provider → `config:changed` → renderer live refresh (provider-tools-widget lists Skills today) | `src/main/config-watcher.ts:63-68,85-94,108-113`; `provider-tools-widget.ts:118-122,261-265,279-281` |
| Agent-file install template: `writeAgentFile(dir, slug, content)`, slug gate `^[A-Za-z0-9._-]+$`, provider `agentsDir/installAgent/removeAgent`, IPC fan-out `provider:installAgent` with `isManagedMcpConfigDir` gate | `src/main/providers/agent-files.ts:5,14-36`; `providers/provider.ts:131-136`; `ipc-handlers.ts:1501-1537` |
| Programmatic PTY spawn: `resolveLaunchSpec` → `spawnPty` (node-pty, cwd param, env partition, profile chain); `writePty`/`killPty`; provider `buildArgs` puts `initialPrompt` as trailing positional | `src/main/pty-manager.ts:382-459,627,655`; `claude-provider.ts:102-121` |
| Transcript read-back: `getTranscriptPath` per provider; pi-compat `readTranscriptTailSync`/`transcriptStatusFromTail`/`readSessionExitReasonSync`; hook-status files | `claude-provider.ts:167-187`; `pi-compatible-transcripts.ts:71-91,142,330`; `hook-status.ts:9-10` |
| Periodic-job template: init returns disposer, `setInterval` + startup delay, config-regex disables on malformed config, before-quit clear | `src/main/auto-updater.ts:5-6,34-40,42-86`; single-flight precedent `agentmemory-manager.ts:181-198`; backoff cap precedent `github-widgets.ts:21-22` (30 min) |
| Settings pipeline: `Preferences` additive-optional keys, spread-merge hydration, registry-driven Preferences sections (`Section` union + section factory + `SECTIONS` + i18n) | `src/shared/types.ts:419-474`; `state/persistence.ts:25-98`; `preferences/section.ts:1,28-37`; `preferences-modal.ts:21-31`; async-action section precedent `preferences/agentmemory-section.ts:38-47,69-83` |

**Absent (this feature ships it):**

- git **pull / push / commit / fetch** code — `git:stageFile`/`unstageFile`/branch ops are the only writes (`ipc-handlers.ts:1766-1842`).
- **Self-managed remote** support — every non-GitHub/Codeberg host fails `CHECKOUT_HOSTS` (`git-url.ts:7-9`).
- Git **auth** integration — no credential helper, no `GIT_TERMINAL_PROMPT`, git spawns inherit `process.env` verbatim; a credential prompt can hang a spawn (the P2-24 class, `git-status.ts:370-373`).
- **Headless/one-shot** provider runner — all spawns are interactive PTY; `codex exec` is documented incompatible with the PTY terminal (`docs/provider-contracts.md:34`).
- **`skillsDir()`/`installSkill()` on any provider** — skills are read + watched only; Gemini/Pi have no skills concept at all, OMP skills live in `~/.omp/agent/{skills,managed-skills}` per omp itself — unverified from finevibe code, probe required (§6).
- Periodic git poller — `git-watcher.ts` is fs-event-only.

## 2. Architecture

```
renderer                            main
────────                            ────
preferences → skills-section  ──invoke──►  skills:checkout / list / install /
  (remote row, skill list,                  uninstall / sanityCheck / pull /
   sync row, push row)                      push / repoStatus / setRemote
        ▲                                   │
        └── skills:changed (push event) ────┤  (config:changed precedent,
                                             │   config-watcher.ts:17-23)
                              skills-repo.ts — clone/scan/install/copy-guards,
                              execGitWithOutput + GIT_TERMINAL_PROMPT=0
                              skills-sync.ts  — periodic pull (auto-updater shape)
                              skills-sanity.ts— staged PTY session + transcript verdict
                                             │
                     ~/.finevibe/skills-repo/          (managed checkout)
                     ~/.finevibe/skills-check/<slug>/  (staged sanity cwd, 30-d retention
                                             │           shape: launch-session-dir.ts)
                     <provider skillsDir>/<slug>/      (install target, §6 matrix)
```

New files: `src/main/skills-repo.ts`, `src/main/skills-sync.ts`, `src/main/skills-sanity.ts`,
`src/renderer/components/preferences/skills-section.ts`; provider `skillsDir`/`installSkill`/
`removeSkill` members on `CliProvider` mirroring `agentsDir`/`installAgent`
(`providers/provider.ts:131-136`); preload `skills` namespace (`preload.ts` api mirror).

## 3. Data model

`Preferences` additive optional key (additive-key convention per `defaultProjectsFolder?`,
`planModeDefaults?`; nested object ⇒ per-key merge in `hydrateLoadedState`, the
`sidebarViews` pattern `state/persistence.ts:30-38`):

```ts
skillsRepo?: {
  url: string;                      // validated on save (R2/R9); empty = feature off
  autoPull?: boolean;               // R7, default true
  pullIntervalMinutes?: number;     // default 240, floor 15
  sanityCheckBeforeInstall?: boolean; // R6, default true (spends model quota — opt-out must be explicit)
  sanityCheckBeforePush?: boolean;  // R8 gate, default false
}
```

Defaults in **both** `store.ts` `DEFAULT_PREFERENCES` (`:39`) and `state.ts` `defaultPreferences` (`:150`).
Runtime status (`headCommit`, `lastPullAt`, `lastPullError`, `lastPushAt`, `dirtyCount`) is
**main-owned** — persisted to `~/.finevibe/skills-repo-status.json`, *not* the Preferences
blob (renderer owns that blob wholesale; main grafts only `statusLineConsent*`,
`store.ts:126-138` — do not add a second renderer-write race). The repo path itself is
never stored: derived constant `<userData>/skills-repo` (a stored path would need
`validateGateRoot` trust handling, `store.ts:63-113,174-265`).

## 4. Requirements → design → evidence

### R1 — Settings section
Registry-driven: add `'skills'` to the `Section` union (`preferences/section.ts:1`), new
`skills-section.ts` exporting `createSkillsSection(ctx): SectionController` (model:
`agentmemory-section.ts` async actions with `ctx.isActiveSection` guards +
in-flight button-disabled state; `profiles-section.ts` nested-dialog CRUD), one
`SECTIONS` entry (`preferences-modal.ts:21-31`), `preferencesNav.skills` + `skills.*`
namespace in **both** locale files (1:1 keys, English fallback `i18n.ts:55-67`). Nothing
else — menu, keyboard, save fan-out, locale refresh are registry-driven. Layout: remote
row (URL input + status chip: Not configured / `@<sha>` / Error), skills list (name +
description + per-tool install state), sync row (auto-pull toggle + interval
`createCustomSelect` 15m/1h/4h/24h, Last pull / Last error, Pull now), push row
(N changes, message input, Commit & push). Re-apply on `state-loaded`/`preferences-changed`
(locale contract, `docs/ui-conventions.md:1`). Save via `appState.setPreferences`
batch (single persist/emit, `state.ts:543-551`).

### R2 + R9 — URL configuration, GitHub *and* self-managed
New pure validator in `src/shared/git-url.ts`: `detectSkillsRepoUrl(value)` sharing the
existing parser shape (`:30-66`) with a deliberate policy delta:

- Same: https/ssh/scp-`git@` forms only; reject embedded credentials (`:47-50` rationale
  — argv is visible in logs/process lists), reject `ext::`/`file://`, require ≥2 path
  segments + folder-safe last segment, `--` terminator + `execFile` argv, no shell
  (clone-handler comment `ipc-handlers.ts:904-910`).
- **Delta: no host allowlist.** The settings field *is* the user's trust decision; main
  re-validates **shape**, not host. Allow a port (self-hosted Gitea/GitLab run on
  non-standard ports; unlike the checkout allowlist, a port here doesn't escape an
  allowlisted service). Self-signed TLS on self-managed HTTPS: git fails under default
  `http.sslVerify` — surface git's stderr verbatim, ship **no** sslVerify-bypass toggle.
- Every skills channel that touches a remote re-runs the validator against the *stored*
  value (the pattern of `fs:cloneRepo` re-validating at `:916-917`), so a hand-edited
  `state.json` can't aim git at a hostile URL.

### R3 — Checkout
`skills:checkout(url)` handler cloning to the managed dir `<userData>/skills-repo`
(no picker — managed-destination precedent: `launch-session-dir.ts` userData trees;
home-tree gate passes by construction, `ipc-handlers.ts:919-922`). Reuses the
`fs:cloneRepo` handler shape wholesale: absent-or-empty dest, `git clone -- url dest`,
`GIT_CLONE_TIMEOUT_MS` bound, ENOENT→"git is not installed", killed→timeout, stderr-tail
error mapping (`:923-940`). Changing the URL = `skills:setRemote` → `git remote set-url
origin <validated-url>` + `git fetch`. Cloned repo is **never** auto-registered as a
project; "Open as project" button calls `appState.addProject` (user action).

### R4 — List skills
`skills:list()` scans the checkout for `<dir>/SKILL.md` at two layouts: repo root
`<slug>/SKILL.md` and `skills/<slug>/SKILL.md` (both layouts are community-standard);
reader = existing `readSkillsFromDir` (`provider-config-utils.ts:47-63`) per layout root,
dedup by name (user-precedence pattern `codex-config.ts:84-102`). Descriptor:
`{ slug, name, description, relPath, tools: Record<ProviderId, 'installable'|'installed'|'overwrites'|'unsupported'> }` —
tool column from the §6 matrix + a per-provider skills-dir existence probe (read path
already exists via `provider:getConfig`, gated `ipc-handlers.ts:1362-1414`). Refresh:
section re-render + `skills:changed` push after every pull/push/checkout
(`config:changed` fan-out precedent, `config-watcher.ts:17-23`).

### R5 — Install into a selectable coding tool
Provider contract extension mirroring the agent-file trio: `skillsDir?(configDir?)`,
`installSkill(slug, srcDir)`, `removeSkill(slug)` on `CliProvider`
(`provider.ts:131-136` shape), implemented where the matrix (§6) says installable —
`writeSkillDir` in `agent-files.ts` style: recursive copy with **untrusted-repo-content
guards** — per-entry `lstat` symlink refusal (the reveal rule,
`ipc-handlers.ts:2074-2077`: "a symlink must never be followed here"), every relative
path canonicalized and required to stay inside `<skillsDir>/<slug>` (the
`writeAgentFile` slug-gate rationale, `docs/security-boundaries.md:9,31` — the cloned
repo is attacker-writable content, treat it as renderer-supplied input), per-file name
gate `^[A-Za-z0-9._-]+$` on the slug, `SKILL.md` required.

`skills:install(slug, providerId, configDir?)`: slug gate → `configDir` gated by
`isManagedMcpConfigDir` (profile chain, the `provider:installAgent` gate
`ipc-handlers.ts:1501-1530` — a profiled project runs as that login, so install lands in
the profile's tree, not `~/.claude`) → R6 sanity gate → copy → the existing
`config-watcher` skills-dir watches fire `config:changed` → provider-tools-widget and the
skills section refresh **for free** (`config-watcher.ts:63-68,85-94,108-113`).
Overwrite needs a confirm dialog (`showConfirmDialog`, profiles-section pattern);
unsupported tools render a disabled row + tooltip (the `isPlanModeSupported`
never-silently-ignore convention, `docs/provider-contracts.md:21`).

### R6 — Sanity check via a finevibe session
No headless runner exists (§1); build it on the **interactive PTY path, visible to the
user** — that is also the consent story: the check spends model quota, so a real session
tab, not a hidden pipe.

1. **Structural gate first** (free, always runs): `SKILL.md` parses, frontmatter `name`
   matches the slug, copy-guard walk (§5) over the source dir.
2. **Import probe**: stage a throwaway cwd `<userData>/skills-check/<slug>-<ts>/`
   (30-day retention sweep, `launch-session-dir.ts` shape), copy the skill to the
   **project-scope** skills location for the probe (`<cwd>/.claude/skills/<slug>` /
   `<cwd>/.codex/skills/<slug>` / `<cwd>/.github/skills/<slug>` — the exact project
   scopes those CLIs read, `claude-cli.ts:782-865`, `codex-config.ts:84-102`,
   `copilot-config.ts:46-49`). Spawn via `resolveLaunchSpec`+`spawnPty` **in main**
   (main-owned cwd ⇒ the `pty:create` `isWithinKnownProject` gate is not bypassed — the
   gate protects renderer-supplied paths, `docs/security-boundaries.md:33`; the sanity
   runner is a main-side caller like every per-spawn hook install) with the selected
   `providerId` + effective profile `configDir`, `initialPrompt` = fixed main-built
   sentence asking the CLI to acknowledge the named skill.
3. **Verdict**: `onExit` + transcript tail (`getTranscriptPath` + tail read,
   pi-compat `transcriptStatusFromTail`/`readSessionExitReasonSync`
   `pi-compatible-transcripts.ts:142,330`); timeout → `killPty`, verdict `timeout`.
   Pass ⇒ proceed to install; fail ⇒ install blocked, transcript excerpt shown with
   "install anyway" override (user's call, never silent).
4. Single-flight (one sanity session at a time, `agentmemory-manager.ts:181-198`
   precedent); tools whose skills concept is `[absent]`/unverified (§6) get the
   structural gate only, labeled honestly.

### R7 — Periodic pull
`skills-sync.ts`, `initSkillsRepoSync(): () => void` at boot (auto-updater shape:
`CHECK_INTERVAL_MS` 4 h default from `skillsRepo.pullIntervalMinutes`, 10 s startup
delay, disposer on before-quit, `auto-updater.ts:5-6,42-86`). Each tick: feature enabled
&& repo present → single-flight → `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=` env (the
P2-24 hang class, `git-status.ts:370-373`; today's spawns inherit `process.env`
verbatim — this job sets them explicitly) → `git pull --ff-only` via
`execGitWithOutput` with a **network-class timeout** (clone's 10 min is the precedent;
the 5 s local default is wrong here) → status file write + `skills:changed` push.
Diverged branch (ff-only refuses): record `lastPullError`, back off to the 30-min cap
(`github-widgets.ts:21-22` precedent), surface in the section; **never** rebase/merge
automatically. Repo dir registered with `git-watcher` so manual edits (repo opened as a
project) flip the push row's dirty count live (`git:watchProject` PROJECT-tier rule,
`ipc-handlers.ts:1797-1812` — the skills-repo root joins as a main-owned managed root,
the `gitWatchedRoots` set `requireGitRoot` admits, `:53-56`).

### R8 — Push
Push row enables on dirty paths under the scanned skill layouts (`getGitStatus` scoped
client-side, `git-status.ts:39-44`). `skills:push(commitMessage, slugs[])`:
`git add -- <skill paths>` (main-derived from `slugs`, each through the
`requireGitFilePath` shape — refuse `''`/`.`/`x/..`, `ipc-handlers.ts:91+`; renderer
supplies **no paths**) → optional R6 gate per changed skill → `git commit -m <message>`
→ `git push origin HEAD:<branch>` with branch taken from the repo's own HEAD (validated
through `requireValidBranch`, `git-status.ts:251-260`), push timeout like pull.
Pre-flight `git ls-remote --exit-code origin HEAD` (same env hardening) surfaces auth
failures *before* committing; on push rejection ("remote ahead") → offer Pull, never
auto-rebase. Non-skill dirt is listed and excluded, never committed.

## 5. Security analysis (binding constraints)

1. **New write class.** Skills into tool config dirs is a new sanctioned writer; the
   closest precedent is `provider:installAgent` + consent gates
   (`docs/security-boundaries.md:31`). Every rule that guards `writeAgentFile`/MCP writes
   applies verbatim: slug allowlist, `isManagedMcpConfigDir` for `configDir`, canonical
   containment via `canonicalPath` (case/separator/junction folding, `:31`), lstat-not-stat
   symlink refusal (`:41` class). The cloned repo is **untrusted content** — copy guards
   run on every install, not just at checkout.
2. **Remote URL.** Main re-validates stored URL on every remote-touching op; argv arrays
   with `--` terminators, `execFile` only, `GIT_TERMINAL_PROMPT=0` on every network op.
   No credential-in-URL ever; the user's ambient credential manager / ssh-agent is the
   auth (documented in the section UI: "FineVibe uses your git's credentials — configure
   them with git/`gh auth login` outside the app").
3. **Sanity session = prompt-injection surface.** Repo content reaches a model running
   under the user's account. Mitigations: staged cwd contains nothing else (no project
   mounts), session is visible (the user watches it), timeout-kill, structural gate
   first. Accepted risk, recorded here; no hidden sessions.
4. **Gates untouched.** No new project roots by default; the managed checkout is app
   userData; `store:save` trust rules unchanged (status lives outside the blob, §3).

## 6. Per-tool install matrix (R5/R6)

| Tool | Install target | Verified in-tree | Sanity probe (project scope) |
|---|---|---|---|
| Claude Code | `<configDir|~/.claude>/skills/<slug>/` | yes — read `claude-cli.ts:127-138,835-847`, watched `config-watcher.ts:85-94` | `.claude/skills` yes |
| Codex CLI | `~/.codex/skills/<slug>/` (no profiles — `CODEX_HOME` stripped at spawn, `codex-provider.ts:99-110`) | yes — `codex-config.ts:84-102`, watched `:108-113` | `.codex/skills` yes |
| GitHub Copilot | `~/.copilot/skills/<slug>/` | yes — `copilot-config.ts:29-31`, watched `config-watcher.ts:63-66` | `.github/skills` yes |
| Gemini CLI | — | `[absent]` — `gemini-config.ts:25` skills always empty | structural gate only; **VERIFICATION-PENDING** (probe installed binary for a skills dir before writing it off) |
| Pi | — | `[absent]` — `pi-provider.ts:133-137` reads `mcp.json` only | structural gate only; **VERIFICATION-PENDING** |
| Oh my Pi | `~/.omp/agent/skills/<slug>/` (harness has skills/managed-skills concepts) | **VERIFICATION-PENDING** — unprobed from finevibe; confirm dir + format on a live `omp` binary (`--help` exits on unknown flags, so acceptance = proof, `provider-contracts.md:34`) | omp session in staged cwd |

Matrix ships as a provider capability (`skillsDir?` present ⇔ installable); UI rows derive
from it, never from a hardcoded list (the "do not assume all providers support X"
rule, `docs/provider-contracts.md:5`).

## 7. Phases

| Phase | Scope | Exit gate |
|---|---|---|
| **P1** — config + checkout + list | R1, R2, R3, R4, R9: `skillsRepo` prefs + hydration merge, `detectSkillsRepoUrl`, `skills-repo.ts` (checkout/list/status), skills section (remote + list + i18n en/zh), preload+IPC surface | clone a GitHub **and** a self-managed (localhost Gitea) URL; list renders with per-tool column; validator suite green |
| **P2** — install + sanity | R5, R6: `skillsDir`/`installSkill`/`removeSkill` + `writeSkillDir` guards, tool picker, sanity runner + verdict UI, probe the three VERIFICATION-PENDING rows on live binaries and update §6 | install a skill to Claude with sanity pass; fail path shows excerpt + override; uninstall removes dir; watcher refresh observed |
| **P3** — pull + push | R7, R8: `skills-sync.ts`, pull-now, dirty detection, commit+push flow, pre-flight `ls-remote`, backoff | pull advances HEAD on a test-repo commit; push from dirty repo lands upstream; auth failure surfaces pre-commit; diverged repo → Pull offer, no auto-rebase |
| **P4** — optional | Skills overview widget (mirror `provider-tools-widget` registration, `widget-registry.ts:28-129`), project-scope installs, multi-repo | — |

Every phase: `gate.sh 3` green (build + renderer typecheck + vitest ×3 + diff-check +
pointer check), colocated tests, docs move in the same commit (§9).

## 8. Tests (colocated, repo conventions)

- `skills-repo.test.ts` — validator (self-managed host+port, credentials, schemes,
  `--upload-pack`/`ext::` rejection), two-layout scan + dedup, copy guards (symlink,
  traversal, slug gate), pull ff-only/timeout/auth error mapping. Git mocked via the
  wholesale `child_process` spy — the `fs:cloneRepo` canary pattern,
  `ipc-handlers.test.ts:166-169,1984-2051`.
- `skills-sync.test.ts` — disposer clears timers, single-flight, backoff cap, disabled
  early-return (`auto-updater.test.ts` precedent).
- `skills-sanity.test.ts` — staged-dir layout, verdict mapping from mocked
  exit/transcript-tail, timeout kill, structural gate rejects malformed SKILL.md.
- IPC gates tests (`ipc-handlers.test.ts` additions) — every skills channel rejects
  malformed slug/configDir/url **before** any spawn (canary assertion shape at `:1985-1989`).
- `skills-section` + `preferences-modal.test.ts` — locale keys 1:1 in en/zh; section
  registry; `state/persistence.test.ts` — `skillsRepo` nested merge.
- Provider `skillsDir`/`installSkill` in each colocated provider suite.

## 9. Docs to update on implementation (same commits)

`docs/provider-contracts.md` (skillsDir contract + §6 matrix as the capability table),
`docs/ui-conventions.md` (skills section rows + clone-URL contract delta for self-managed),
`docs/security-boundaries.md` (new sanctioned writer + self-managed remote policy +
sanity-session injection note), `docs/FEATURES.md` (feature row: behavior, owning modules,
numeric limits: clone 10 min / pull-push timeout / interval floor 15 min / 30-min backoff
cap / 30-d sanity-dir retention).

## 10. Risks / open questions

1. **Cross-tool skill portability.** The `SKILL.md` + frontmatter shape is shared by
   Claude/Codex/Copilot readers in-tree, but skill *content* can be tool-specific.
   v1 installs content verbatim — no format conversion; the sanity probe is the honesty
   mechanism. A conversion layer is a separate feature if demand shows.
2. **Push auth on Windows.** Credential Manager GUI prompts under `GIT_TERMINAL_PROMPT=0`
   fail fast with mapped stderr → map to "configure git credentials" guidance; ssh
   transport requires a running ssh-agent in the app's inherited env.
3. **Sanity cost.** A real CLI session per install spends quota; default-on is the
   user's stated requirement ("upon 5, it should run a sanity check"), override +
   disable toggle keep it the user's call.
4. **Repo layout drift.** Two layouts scanned in v1; a repo using `plugins/`
   marketplace layout (`claude-cli.ts:84-113`) is not skill-listed — document in the
   section's help row.
5. **`skills-check` dirs and the pty gate.** If the sanity runner ever moves to a
   renderer-initiated spawn, the staged dir must be added to the main-owned gate roots
   first — record now so a future refactor doesn't loosen `pty:create`.
6. Single repo per user in v1 (`skillsRepo` singular). Multi-repo is P4+.
