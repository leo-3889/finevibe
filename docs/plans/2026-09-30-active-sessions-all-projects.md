# Plan: show all open sessions of all projects in sidebar "Active Sessions"

**Date:** 2026-09-30 · **Status:** implemented

## Goal

The sidebar "Active Sessions" section must list **every open CLI session in every project**, regardless of live status. Live status remains visible (glyph) and drives ordering, but never hides a row.

## Current behavior

`src/renderer/components/active-sessions-panel.ts` already iterates all `appState.projects` × `project.sessions` (a session record exists only while its PTY is live — removed on exit at `src/renderer/index.ts:170`). Three mechanisms still hide open sessions:

1. **Status filter** — `selectActiveSessions` drops sessions whose status is not in the configured `activeSessionStatuses` set. Default set is `working + input + completed`, so open sessions in `waiting` (freshly started, awaiting confirmation) are invisible.
2. **Unknown-status drop** — `getStatus` returns `idle` for sessions never initialized in `session-activity.ts` (e.g. restored sessions before the terminal re-attaches, providers whose status source has not reported yet). For providers that report status, those rows are dropped.
3. **Capability asymmetry** — `reportsStatusOf` (hook/poll capability) decides whether the filter applies at all, so identical sessions render differently per provider.

The section is intentionally hidden with ≤1 project (`projects.length > 1` guard) — keep that.

## Changes

### 1. `src/renderer/components/active-sessions-panel.ts`
- `selectActiveSessions(projects, statusOf)` — remove `activeStatuses` and `reportsStatusOf` parameters. Include every `isCliSession` session; status is used only for the glyph and sort key.
- Sort: `STATUS_PRIORITY` order, then `projectName`, then `sessionName` (deterministic tie-break).
- Delete `ACTIVE_STATUS_KEYS`, `DEFAULT_ACTIVE_SESSION_STATUSES`, `resolveActiveStatuses` and the now-unused `getProviderCapabilities` import.
- `renderActiveSessions`: drop `resolveActiveStatuses` and the capability lookup; keep the `sidebarViews.activeSessions` toggle and the `projects.length > 1` guard.

### 2. `src/shared/types.ts`
- Remove `Preferences.activeSessionStatuses` (lines ~408–417). No migration: stale values in persisted `state.json` are simply never read.

### 3. `src/renderer/components/preferences/appearance-section.ts`
- Remove the "Active Session Statuses" checkbox block, the `ActiveStatuses` type, the `statusCheckboxes` save block, and the `DEFAULT_ACTIVE_SESSION_STATUSES` import. Keep the `activeSessions` sidebar-view toggle.

### 4. Locales
- `src/renderer/locales/en.json` and `zh-CN.json`: delete `appearance.activeSessionStatuses` and the per-status label keys it references.

### 5. Tests
- `active-sessions-panel.test.ts`: replace status-filter cases with "all open sessions across projects are listed regardless of status (including `waiting` and never-initialized `idle`)"; keep/extend ordering assertions.
- Check `appearance-section` tests for status-checkbox coverage and remove accordingly.

## Out of scope

- The `sidebarViews.activeSessions` show/hide toggle and the single-project hide rule.
- Status production (hooks, transcript polling) — unchanged.
- Session history / archives — unchanged.

## Verification

- `npm run build`
- `npx tsc -p tsconfig.renderer.json --noEmit`
- `npm test`
- `git -c core.safecrlf=false diff --check`
- Manual: with two projects open, start sessions in both (including one left at the prompt → `waiting`/`completed`); all appear in the panel; clicking a row switches project + tab.
