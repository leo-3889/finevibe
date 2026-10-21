# New Session modal — focus fix + team persona + custom prompt (plan)

Status: planned, not implemented.
Date: 2026-10-20.
Scope: (1) Ask AI composer focus when the New Session modal opens from it;
(2) a team-persona select row below Name; (3) a custom-prompt textarea row below the persona row.

## 1. Ask AI composer loses focus when New Session opens (fix)

Repro: select text in a file pane → Ask AI composer → click `▼`
("Send to custom session", `file-prompt.ts:198-201` → `submitToCustomSession():298`)
→ `promptNewSession()` opens the modal.

Root cause: `showModal` steals focus to the first text input
(`src/renderer/components/modal.ts:149-159`) and `closeModal`/`cleanup`
(`modal.ts:52-55, 260-269`) never restore it. After Create or Cancel, focus lands on
`body`: the composer textarea (which is still open with its text intact on Cancel)
loses keyboard focus and the user cannot keep typing.

Fix — generic modal focus restoration in `modal.ts` (standard dialog pattern):

- [ ] `showModal()` — record `document.activeElement` before `overlay.classList.remove('hidden')`.
- [ ] `cleanup()` — if the recorded element is still connected and not `body`,
      `focus()` it after the overlay hides. Guard with `requestAnimationFrame` to run
      after the `hidden` class flip.
- [ ] No change needed in `file-prompt.ts` for this path: the composer already stays
      open on Cancel (`dismiss()` runs only in the `onCreated` callback, `file-prompt.ts:301-304`),
      so restoring focus brings the composer back alive with its text.

Out of scope (intentional): the tab-bar `New session ▾` caret dismissing the composer
via the document-capture `onDocMouseDown` (`file-prompt.ts:348-354`) — standard
popover-dismiss-on-outside-click behavior; the user's repro is the in-composer `▼`.

## 2. Team persona row (below Name)

`promptNewSession()` builds `FieldDef[]` in `src/renderer/components/tab-bar/session-menu.ts:95-111`;
the modal renders fields in array order → insert the persona select at index right
after `session-name` (before `session-args`).

Data source: `appState.team` members (`src/renderer/state/team-state.ts`,
`TeamMember` in `src/shared/types.ts:153`). Options:
`[{ value: '', label: None }, ...members.map(m => ({ value: m.id, label: `${m.name} — ${m.role}` }))]`
with `type: 'select'` (custom-select; native `<select>` is banned by UI conventions).

Gating and provider interaction — mirror the `profile` field precedent (`session-menu.ts:84-93, 133-147`):

- [ ] Show the row only when `appState` has ≥1 team member (mirrors `anyProviderHasProfiles`).
- [ ] New `setPersonaFieldProvider(providerId)`: hide the row when the selected provider is
      not team-capable (`getTeamCapableProviderIds()` in
      `src/renderer/provider-availability.ts:64-67`); wire from the provider field's
      `onSelectChange` alongside the existing `setProfileFieldProvider` call.
- [ ] Pinned members override provider/profile (`resolvePinnedTeamProfile`,
      `team-state.ts:84`): when the selected member's pin forces a provider, reflect it —
      disable the provider/profile selects with a tooltip, like the member-modal precedent
      (`components/team/member-modal.ts:31-35`). Simplest acceptable v1: keep selects
      enabled; the pin wins at launch (matches `startTeamChat` semantics,
      `team-state.test.ts:236-239`) and the tooltip explains it.

Launch path — reuse the existing team-chat machinery, do NOT invent a second injection:

- [ ] `appState.startTeamChat(projectId, member, overrideProviderId)`
      (`src/renderer/state.ts:791-814`) is the persona launch entry: it resolves the
      backend (`resolveTeamChatBackend`), builds the session with
      `pendingSystemPrompt = member.systemPrompt` via `buildTeamChatSession`, and consumes
      it at spawn (`consumePendingSystemPrompt:816`).
- [ ] In the modal's `onConfirm` (`session-menu.ts:149-174`): when
      `values['persona']` is set, resolve `member = appState.getTeamMemberById(...)`
      (board-card precedent `board/board-card.ts:189-193`) and call
      `startTeamChat(project.id, member, providerId)` instead of `appState.addSession`.
      `startTeamChat` returning `undefined` (no team-capable provider) →
      `setModalError('persona', ...)`; do not silently fall back to a persona-less session
      (unlike board-card's "task must run" fallback — here the user explicitly picked a persona).
- [ ] Name/args/env on the persona path: extend `startTeamChat` with
      `opts?: { name?: string; args?: string; envVars?: string }` forwarded into
      `buildTeamChatSession`/the session record; the member-derived name
      (`"CMO - Session 2"`) stays the default when the user left the name field at its
      placeholder. Persist `keep-args`/`keep-env` project defaults as today.

## 3. Custom prompt row (below persona row)

- [ ] `session-menu.ts` fields: after `persona`, add
      `{ id: 'session-prompt', type: 'textarea', label: t('tab.newSessionModal.promptLabel'), placeholder: ..., rows: 3 }`.
- [ ] On Create, deliver via `setPendingPrompt(session.id, prompt)` — the same mechanism
      `file-prompt.ts:293` uses: it converts to the PTY `initialPrompt` at spawn
      (`terminal-pane.ts:272-276`), so it works for a persona (team-chat) session and for
      a plain session alike. The persona's `pendingSystemPrompt` is a separate slot
      (system side); the custom prompt is the user's first message — no composition needed.
- [ ] Empty prompt = current behavior (no `setPendingPrompt` call).

## 4. i18n
- [ ] `src/renderer/locales/en.json` + `zh-CN.json`, `tab.newSessionModal` block (~line 113):
      `personaLabel: "Team Persona"`, `personaNone: "None"`,
      `personaNotCapable: "{name} can't run team personas"`,
      `promptLabel: "Prompt"`, `promptPlaceholder: "Add a custom prompt for this persona…"`.

## Decisions taken

- Persona row order = persona, then prompt (user-requested stacking: Name → Persona → Prompt → Arguments …).
- Reuse `startTeamChat` + `pendingSystemPrompt` + `setPendingPrompt`; zero new prompt-injection paths.
- Modal focus restore is generic (any modal restores to the opener), not Ask-AI-specific.
- Hard error (not fallback) when a chosen persona can't run on the chosen backend — explicit user intent.

## Verification

- [ ] Unit: `npx vitest run src/renderer/state/team-state.test.ts src/renderer/components/modal.test.ts src/renderer/components/tab-bar/session-menu.test.ts` (the last two are new files)
  - `startTeamChat` opts: custom name/args/env land on the session record.
  - modal focus: `showModal` then `closeModal` restores `document.activeElement` to a connected pre-modal input.
- [ ] `npm run build`; `npm test`; `npx tsc -p tsconfig.renderer.json --noEmit`; `git diff --check`.
- [ ] Runtime smoke (`npm start`):
  1. Ask AI → type instruction → `▼` → modal opens → Cancel → composer has text and keyboard focus.
  2. Create → composer dismissed, session receives the Ask AI prompt (unchanged).
  3. Team has members → modal shows Persona row below Name; pick CMO + prompt →
     new tab named per member, system prompt applied, prompt sent as first message.
  4. Switch provider to a non-team-capable CLI → Persona + Prompt rows hidden.
  5. No team members → Persona/Prompt rows absent; modal identical to today.
- [ ] Docs: `docs/FEATURES.md` (New Session modal row, team section), `docs/ui-conventions.md`
      if the modal-field stacking needs a note. `CHANGELOG.md` is release-generated — untouched.
