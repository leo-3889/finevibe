# Plan mode → New Session "detail" page + per-coding-tool configuration

Status: planned, not implemented.
Date: 2026-10-20.
Scope: move the "Plan mode" control into the New Session modal below
"Keep args for future sessions", gate it by coding tool (greyed out when unsupported), and add a
per-provider plan-mode configuration that drives the checkbox-less quick-send paths.

Answers to the three questions, from the code:
1. **Move to the detail page below "Keep args for future sessions"?** Yes. That page is
   `promptNewSession()` (`src/renderer/components/tab-bar/session-menu.ts:62-179`); it renders
   `FieldDef[]` in array order (`modal.ts:88-103`), and a `type: 'checkbox'` field already exists
   right at the target position (`keep-args`, session-menu.ts:98-103). Pure insertion.
2. **Coding-tool dependent, greyed out when unsupported?** Yes. The modal's provider select
   already exposes `onSelectChange` (drives `setProfileFieldProvider`, session-menu.ts:84-93,
   121); mirror it with `setPlanModeFieldProvider()`. Support = `capabilities.planModeArg`
   (Claude `--permission-mode plan`, Copilot `--mode plan`, Gemini `--approval-mode=plan`;
   Codex/Pi/OMP none today).
3. **Per-coding-tool configuration?** Yes — required, not optional decoration. The quick-send
   paths (Ask AI "Send to AI", Inspect/Draw/Flow direct Send, Kanban run) spawn a plan session
   **without** a modal; once the checkbox moves out of those composers, a per-provider setting is
   the only honest source for the value. Precedent exists: `Preferences.defaultProfiles?:
   Partial<Record<ProviderId, string>>` (shared/types.ts:419) with per-provider rows in
   Preferences (`preferences/profiles-section.ts:76-92`, ids `pref-default-profile-<providerId>`).

## Current state (verified 2026-10-20)

- `planModeArg` matrix: claude ✅ / copilot ✅ / gemini ✅ / codex ❌ / pi ❌ / omp ❌ — see
  `todos/ask-ai-plan-mode-provider-support-plan.md` for evidence and the Codex/OMP probe gates.
- Plan-mode checkboxes live in 5 surfaces: Ask AI composer (`components/file-prompt.ts:167`),
  browser-tab Inspect/Draw/Flow (`browser-tab/pane.ts:279,341,401`), Kanban task modal
  (`board/board-task-modal.ts:259-263` — the only capability-aware one).
- The New Session modal has **no** plan-mode row, and its `▼` consumers (Ask AI
  "Send to custom session" `file-prompt.ts:301`, Draw `draw-mode.ts:116`, Inspect/Flow
  `session-integration.ts:47,72`, readiness fix `readiness-widget.ts:89`) silently drop plan
  mode. `docs/FEATURES.md:23` claims the modal has a "plan-mode row" — false today (doc drift;
  this plan makes it true).
- `FieldDef` (`modal.ts:4-15`): `checkbox` + `onChange` supported; **no field-level `disabled`**
  (only select options). Disabled state must be applied post-render via
  `document.getElementById('modal-<id>')` — exactly the `setProfileFieldProvider` pattern.
- Routing trap: `addPlanSession` (`state.ts:462-474`) calls `addSession` **without `envVars`**.
  The modal collects env vars; routing modal submits through `addPlanSession` would drop them.

## Design

### 1. New Session modal row (the move)

- [ ] `src/renderer/components/tab-bar/session-menu.ts` — insert after the `keep-args` field
      (array index 3, before `session-env`):
      `{ label: t('tab.newSessionModal.planModeLabel'), id: 'plan-mode', type: 'checkbox' }`.
      Field order with provider select prepended: Provider → Name → Args → **Keep args** →
      **Plan mode** → Env → Keep env → Profile.
- [ ] Initial checked = per-provider config (below), default `true`; initial gate state computed
      from `effectiveProvider` (session-menu.ts:113-114), then re-applied in
      `onSelectChange` alongside `setProfileFieldProvider(value)` → also call
      `setPlanModeFieldProvider(value)`.
- [ ] `setPlanModeFieldProvider(providerId)`:
      `const caps = getProviderCapabilities(providerId); const supported = !!caps?.planModeArg;`
      `input.disabled = !supported;` on disable → `checked = false`;
      set `title` on the `.modal-field` wrapper (tooltip via i18n, reuse the board-modal
      semantics: "Provider does not support plan mode"). Visible-but-disabled everywhere,
      matching `board-task-modal.ts:259-263` — the established pattern.
- [ ] CSS: native `input:disabled` already greys the box; add `.modal-field-checkbox.disabled`
      (label opacity, mirrors `.custom-select-item.disabled` in `styles/modals.css:181`) so the
      label dims with the box.
- [ ] Submit (`session-menu.ts:149-174`): if `values['plan-mode'] === 'true'` **and**
      `caps.planModeArg` → spawn args = user args + planModeArg. Do **not** route through
      `addPlanSession` (it drops envVars and re-resolves the provider, overriding the modal's
      explicit pick). Compose via the shared helper (below).
- [ ] Persistence edge case: `keepArgs` writes `project.defaultArgs` (session-menu.ts:165).
      Persist the **raw args field** (without the plan flag) and append `planModeArg` only to
      this session's spawn args — ticking Plan mode must not pin `--permission-mode plan` into
      every future session.

### 2. Per-coding-tool configuration

- [ ] `src/shared/types.ts` — `Preferences.planModeDefaults?: Partial<Record<ProviderId, boolean>>`
      (documented: provider used by a quick "Send to AI"; absent = `true` for
      plan-capable providers, i.e. today's behavior — no upgrade surprise; unsupported providers
      are always off, `buildPlanSessionArgs` drops the flag anyway).
- [ ] UI: **General section** ("Coding tools" area, next to the `defaultProvider` select,
      `preferences/general-section.ts:76-79,144`) — one checkbox row per available provider,
      provider-registry order (same iteration style as profiles-section.ts:70-92),
      `pref-plan-mode-<providerId>`; unsupported providers render disabled + tooltip, so the
      setting page doubles as the support matrix. Persist via `setPreference('planModeDefaults',
      {...})` on change (not save()) — per-provider rows write immediately, like
      `setProviderDefaultProfile` does.
- [ ] `en.json` + `zh-CN.json` —
      `tab.newSessionModal.planModeLabel`, `planModeUnsupportedTooltip` (shared),
      `general.planModeHeading` + per-provider row label reuses provider displayName.

### 3. Surface consolidation (what "move" implies)

Quick surfaces lose their inline checkbox; their value becomes
`planModeDefaults[resolvePlanProvider(...)] ?? true` (`resolvePlanProvider` already implements
override → project default → active session → prefs → claude,
`state/specialized-sessions.ts:5-12`).

- [ ] `components/file-prompt.ts` — remove `createPlanModeRow()` row from the Ask AI composer
      (:167-168, :207, :247, :290-291); `submit()` passes the config-derived value to
      `addPlanSession`. `▼` now gets plan mode **for free** through the modal row.
- [ ] `browser-tab/pane.ts` + `types.ts` + `session-integration.ts` + `draw-mode.ts` — remove the
      three quick checkboxes (rows, `inspectPlanModeCheckbox`/`drawPlanModeCheckbox`/
      `flowPlanModeCheckbox` fields, `checked` reads at `session-integration.ts:36,61`,
      `draw-mode.ts:97`); direct Sends pass the config-derived value; `▼` paths unchanged (modal
      owns it now).
- [ ] `dom-utils.ts` — `createPlanModeRow` keeps its Kanban consumer; no deletion.
- [ ] Kanban task modal — **keeps** its per-task checkbox (explicit per-card override, provider
      select + gating already shipped); refactor its inline gate to the shared helpers;
      initial `planMode` for new tasks = config value for the selected provider.
- [ ] Shared helpers in `state/specialized-sessions.ts`:
      `isPlanModeSupported(providerId)` (`!!getProviderCapabilities(id)?.planModeArg`) and
      `resolvePlanModePreference(prefs, providerId)` (`supported && (prefs.planModeDefaults?.[id] ?? true)`);
      used by modal, prefs UI, board modal, and all quick sends — one support truth.
- [ ] Coordination with open plans: `todos/new-session-persona-prompt-plan.md` inserts a Persona
      row **after `session-name`** → no collision with this index-3 insert;
      `todos/ask-ai-focus-setting-plan.md` adds `promptNewSession(onCreated?, opts)` — this plan's
      modal changes touch the same field array; land order: focus plan → persona plan → this.
- [ ] Supersedes Phase 1 of `todos/ask-ai-plan-mode-provider-support-plan.md` (composer
      checkbox gating): the composer checkboxes are removed entirely, so the "lying checkbox"
      surfaces disappear. **Carries over unchanged:** the Codex/OMP startup-flag probes (their
      result flips `planModeArg`, which auto-enables the modal row, the config row, and quick
      sends — no further UI work), and the Pi permanent non-goal citation.

## Edge cases

- Provider select hidden when only one coding tool is available (`providers.length <= 1`,
  session-menu.ts:115) → gate/initial value computed from `effectiveProvider` at build time.
- Provider not installed → its select option is disabled; plan row still gated by
  `planModeArg` capability, availability is orthogonal.
- Modal opened from Ask AI ▼: the composed prompt must not change; plan mode only affects spawn
  args.
- `planModeDefaults[provider] = true` for a provider lacking `planModeArg`: harmless
  (`isPlanModeSupported` short-circuits; `buildPlanSessionArgs` drops the flag) — the config row
  is disabled so it can't be set.
- Kanban tasks with `task.planMode === undefined` (pre-existing rows): `board-card.ts:194` treats
  undefined as falsy → unchanged; do not migrate stored task rows to the config default.
- Team-assigned tasks hide the plan row (team chat discards it, `board-task-modal.ts:361-383`) —
  untouched.

## Tests & verification

- [ ] New `session-menu.test.ts` (none exists; FEATURES.md:22-23 marks the modal UNTESTED):
      fields include `plan-mode` after `keep-args`; provider switch to Pi → `#modal-plan-mode`
      disabled + unchecked; to Claude → enabled; submit with plan+Claude → `addSession` args
      contain `--permission-mode plan` **and** `project.defaultArgs` excludes it; env vars still
      forwarded.
- [ ] `specialized-sessions.test.ts` — `isPlanModeSupported` / `resolvePlanModePreference`
      (absent pref → true for supported, false for unsupported).
- [ ] `file-prompt.test.ts`, `browser-tab/session-integration.test.ts`, `draw-mode.test.ts` —
      drop the removed-checkbox fixtures; assert quick send passes
      `resolvePlanModePreference(...)` result.
- [ ] `board-task-modal` behavior tests unchanged (gate already covered); add initial-value-from-
      config assertion for create mode.
- [ ] `preferences-modal` test — per-provider rows render, unsupported disabled, toggle persists
      `planModeDefaults`.
- [ ] `npx vitest run` touched files; `npx tsc -p tsconfig.renderer.json --noEmit`;
      `npm run build`; `git diff --check`.
- [ ] Runtime smoke (`npm start`): project default = Pi → modal row greyed + tooltip, Ask AI
      sends normal session; = Claude → row ticked, spawned session carries
      `--permission-mode plan`, session keeps typed env vars; General → Claude row off → Ask AI
      spawns normal session; Kanban create modal unaffected.

## Out of scope

- Mid-session plan-mode toggling; plan flags on resume (startup-only flags).
- Codex/OMP startup-flag discovery mechanics (own probe plan, carried over).
- Ask AI composer focus behavior (`todos/ask-ai-focus-setting-plan.md`).
- Project-level plan-mode default (config is global-per-provider; project overrides stay with
  explicit args).
