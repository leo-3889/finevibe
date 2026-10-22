# Ask AI "Plan mode" tickbox — per-provider support plan

Status: shipped — Phase 1 truthfulness via de83f5d/180fc83 (superseded by the plan-mode
detail page), OMP flag + matrix via c0d3b8a (items 47-49), verified in-tree 2026-10-22.
Remaining: Codex startup-flag probe + runtime smoke → see [`../PENDING.md`](../PENDING.md) §3. Archived.
Date: 2026-10-20.
Scope: make the "Plan mode" checkbox truthful on every surface that shows it, and extend real
plan-mode support to Codex and Oh my Pi where the CLI allows it. Pi stays unsupported by design.

## Current state

Capability flag: `CliProviderCapabilities.planModeArg` (`src/shared/types.ts:34`).
Applied by `buildPlanSessionArgs` (`src/renderer/state/specialized-sessions.ts:15-23`): when the
resolved provider has no `planModeArg`, the flag is **silently dropped** — the session spawns
normally while the UI showed "Plan mode" ticked.

Provider matrix (verified 2026-10-20):

| Tool     | `planModeArg` in app | Native plan mode | Evidence |
|----------|----------------------|------------------|----------|
| Claude Code | ✅ `--permission-mode plan` | Yes | Claude Code docs |
| GitHub Copilot | ✅ `--mode plan` | Yes | Official CLI reference: `--mode=MODE` choices `interactive, plan, autopilot`; `--plan` shorthand |
| Gemini CLI | ✅ `--approval-mode=plan` | Yes | Official docs: approval mode `plan` (read-only), `general.defaultApprovalMode: "plan"` |
| Codex CLI | ❌ none | Yes (v0.94.0 GA, collaboration mode) | TUI: `/plan`, Shift+Tab. `codex exec --collaboration-mode` is **exec-only**; openai/codex#13377: no TUI startup parameter; the `config/mod.rs` field "Start the TUI in the specified collaboration mode (plan/default)" is dangling (removed) on main |
| Pi | ❌ none | **Never** | Author (mariozechner): "pi does not and will not have a built-in plan mode" (blog + README) |
| Oh my Pi | ❌ none | Yes | TUI `/plan`; config `plan.defaultOnStartup`; `--plan <model>` is the plan-role *model* selector, not plan mode; legacy `--mode plan` flag (per omp#5380) is gone from main's flag table |

UI surfaces that show the checkbox:

| Surface | Capability-aware? |
|---------|-------------------|
| Kanban task modal (`board/board-task-modal.ts:259-263`) | ✅ disables + unchecks + tooltip when provider lacks `planModeArg` |
| GitHub widget / top-files "fix" flows (`project-tab/widgets/github-widgets.ts:311`, `top-files-widget.ts:37`) | ✅ only offer plan-capable providers |
| **Ask AI composer** (`components/file-prompt.ts:167`) | ❌ always enabled, checked; silently no-ops on codex/pi/omp |
| **Browser-tab Inspect** (`browser-tab/pane.ts:279` → `session-integration.ts:61`) | ❌ same |
| **Browser-tab Draw** (`pane.ts:341` → `draw-mode.ts:97`) | ❌ same |
| **Browser-tab Flow** (`pane.ts:401` → `session-integration.ts:36`) | ❌ same |

The resolved provider for all four ❌ surfaces is `resolvePlanProvider`
(override → `project.defaultProvider` → active session's provider → `prefs.defaultProvider` →
`claude`) — so a project whose default is Codex/Pi/OMP gets a lying checkbox on every "Send to AI".

## Decision: SUPPORT, do not remove

- 4 of 6 backends have native plan mode; removal punishes Claude/Copilot/Gemini users.
- The lying checkbox on 4 surfaces is a truthfulness bug, fixable with the pattern the Kanban
  modal already ships (disable + uncheck + tooltip).
- Pi is a documented non-goal (author refuses); Codex/OMP have real plan modes worth wiring.

Rejected alternatives:
- *Prompt-text fallback* ("first produce a plan, do not edit files") for unsupported providers:
  unverifiable, not enforced by the CLI, silently differs per provider → rejected.
- *Hide the row entirely on unsupported providers*: hides why the setting is gone; the Kanban
  precedent (visible, disabled, tooltip) is self-explanatory → rejected.

## Phase 1 — truthfulness (app-only, no provider changes)

- [ ] `src/renderer/state/specialized-sessions.ts` — add pure
      `isPlanModeSupported(providerId): boolean` (`!!getProviderCapabilities(id)?.planModeArg`
      shape; lives beside `buildPlanSessionArgs`, unit-testable without DOM).
- [ ] `src/renderer/state.ts` — expose `resolvePlanProviderId(projectId): ProviderId` wrapping
      `resolvePlanProvider` so surfaces can ask "which provider will this plan session use?"
      with the exact submit-time precedence.
- [ ] `src/renderer/components/file-prompt.ts` — in `openComposer()`: resolve the plan provider;
      when unsupported → `planModeCheckbox.disabled = true; checked = false;`
      `planModeRow.title = <unsupported tooltip>`. Reset to enabled state on the supported path
      (composer DOM is reused across opens, same lifecycle as `checked = true` at :247).
- [ ] `src/renderer/components/browser-tab/pane.ts` — same gate for the three rows
      (`inspectPlanModeRow`, `drawPlanModeRow`, `flowPlanModeRow`), applied wherever the panels
      open (mirror the `checked` reset sites in `session-integration.ts` / `draw-mode.ts`).
- [ ] i18n: reuse `board.taskModal.planModeUnsupportedTooltip` ("Provider does not support plan
      mode", `en.json:246`, `zh-CN.json:246`). Promote to a shared key (e.g. top-level
      `planModeUnsupported`) if the board namespace stays import-unfriendly outside board/.
      Note: `file-prompt.ts` is fully hardcoded English today — keep the tooltip consistent with
      its neighbors (hardcoded English acceptable there; board modal uses `t()`).

Edge cases:
- Provider changes between composer-open and submit (tab switch under an open composer):
  `buildPlanSessionArgs` still drops the flag, and a disabled+unchecked box can only submit
  `planMode=false` — consistent. No re-render loop needed.
- Flow's row is `display:none` by default — gate it anyway; it becomes visible in flow mode.
- Ask AI `▼` "Send to custom session" ignores plan mode entirely (existing `promptNewSession`
  path, `file-prompt.ts:298-305`) — out of scope, unchanged.
- Team-assigned Kanban tasks already hide the row (team chat discards plan mode) — untouched.

## Phase 2 — extend real support (verification-gated, per provider)

Gate: **do not set a `planModeArg` until the exact startup form is observed working on an
installed binary.** Unknown flags make these CLIs exit at startup; a capability flag committed
from docs alone can brick every spawn of that provider. Run the probe on a machine with the CLI
installed (`<bin> --help`), then a real plan-mode spawn smoke.

### Codex
- Plan mode is GA (rust-v0.94.0) as a collaboration mode; TUI toggles with `/plan` / Shift+Tab;
  the startup config field seen in mid-2026 commits is removed on main. `--collaboration-mode`
  exists only on `codex exec` (headless JSON; incompatible with Vibeyard's PTY terminal).
- Probe: `codex --help` for a startup mode flag (and `-c` passthrough, e.g.
  `-c mode=plan` style config override — Codex supports `-c key=value`, already used by this
  provider for `developer_instructions`, `codex-provider.ts:69`).
- If a startup form exists → set `planModeArg` to it; done.
- If none exists → plan for **startup slash input**: plan sessions for codex send `/plan` as the
  first PTY input before the pending prompt. Requires a new capability shape (e.g.
  `planModeStartupInput?: string`) + wiring where the pending prompt is written to the PTY;
  codex's `pendingPromptTrigger` is `startup-arg`, so the pending-prompt plumbing must switch to
  PTY input for those sessions. Size: main-process plumbing + tests — scope it as its own plan
  if the probe fails.

### Oh my Pi
- Plan mode exists (`/plan` in TUI; `plan.defaultOnStartup` config; plan tool-gating).
- Probe: `omp --help` on the installed version — check for a startup plan flag (legacy `--mode
  plan` per omp#5380 is absent from main's flag table; `--plan <model>` selects the plan-role
  model, NOT plan mode — do not confuse them; `--config` takes values whose semantics are
  unverified).
- If a startup flag exists → set `planModeArg`.
- Else, config route: OMP honors `plan.defaultOnStartup` in the agent-dir config, and this
  provider already pins per-profile dirs via `PI_CODING_AGENT_DIR` (`omp-provider.ts:78-82`) —
  a plan session could launch from a plan-pinned profile dir. Heavier; only if the flag probe
  fails and the demand justifies it.

### Pi
- Permanent non-support, documented: the author explicitly rejects built-in plan mode
  (pi-mono blog + README). Phase 1 UI (disabled + tooltip) is the final answer.
- Record in `docs/provider-contracts.md` so future contributors don't re-litigate.

## Phase 3 — tests + docs

- [ ] `src/main/providers/codex-provider.test.ts` / `omp-provider.test.ts` / `pi-provider.test.ts`
      — capability assertions matching the final flags (pi stays `toBeUndefined()`).
- [ ] `src/renderer/state/specialized-sessions.test.ts` — `isPlanModeSupported` true/false/unknown-
      provider; `resolvePlanProviderId` precedence unchanged.
- [ ] `src/renderer/components/file-prompt.test.ts` — composer open with unsupported plan
      provider → checkbox disabled+unchecked+tooltip; supported → enabled+checked.
- [ ] `src/renderer/components/browser-tab/session-integration.test.ts` — plan submit honors the
      gate (checkbox state plumbed through, existing checked:false fixture pattern).
- [ ] `docs/provider-contracts.md` — add the `planModeArg` capability row/matrix (Codex/OMP/Pi
      outcomes + probe results + Pi non-goal citation).
- [ ] `docs/FEATURES.md` — Ask AI row (file panes §3) + browser-tab Inspect/Draw/Flow rows (§6):
      "plan mode applied only for providers with `planModeArg`; checkbox disabled otherwise".
- [ ] `npx vitest run` on touched test files; `npx tsc -p tsconfig.renderer.json --noEmit`;
      `npm run build`; `git diff --check`.
- [ ] Runtime smoke (`npm start`): project default = Pi → Ask AI composer shows disabled tickbox
      with tooltip; = Claude → tickbox on, spawned session carries `--permission-mode plan`
      (visible in session args/inspector). Same probe for Inspect/Draw on a browser tab.

## Out of scope

- Mid-session plan-mode toggling (all four CLIs toggle in-TUI; Vibeyard spawns fresh plan
  sessions by design).
- Plan-mode-aware resume args (`--permission-mode plan` etc. are startup-only flags).
- Ask AI `▼` custom-session path applying plan mode.
- Codex/OMP startup plumbing beyond the probes above (own plan if probes come up empty).
