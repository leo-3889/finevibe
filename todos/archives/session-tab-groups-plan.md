# Plan: session tab groups (hover-to-group, rename, ungroup)

Date: 2026-10-21 · Status: DONE — shipped de83f5d (items 68-71), verified in-tree 2026-10-22.
Archived. · Owner: TBD

## Request

Session tabs in the top bar can be regrouped into **groups** when one tab is hovered
over another. A **Rename group** right-click option and an **Ungroup** right-click
option must be available. The group name is **auto-set**.

Related plan: `todos/tab-strip-scroll-arrows-plan.md` touches the same `render()`
tail and `tabs.css`; the two are independent apart from that (see Conflicts).

## Current behavior (investigated)

Markup: `src/renderer/index.html:37-41` — `#tab-bar` (36 px strip) contains
`#tab-list`, which is the scrolling element.

Render: `src/renderer/components/tab-bar/tab-list.ts:341-483` — `render()` banks the
strip offset, wipes `tabListEl.innerHTML` (347), appends **one flat `.tab-item` per
`project.sessions` entry** (352-468), restores the per-project offset and pulls the
active tab into view (470-482). Early return while a rename input is open (342).
Each tab carries `dataset.sessionId` (368). There is **no group concept anywhere**
(`grep -rn "tabGroup|groupId|ungroup" src` → no matches).

Drag reorder: `tab-list.ts:416-464` — HTML5 DnD, `effectAllowed/dropEffect = 'move'`
(417, 424), `dataTransfer` carries the session id, `dragover` splits the target tab at
`midX` into `drag-over-left` / `drag-over-right` (426-433), `drop` converts the half
into an index and calls `appState.reorderSession()` (440-456), `dragend` sweeps every
indicator (458-464). Same convention in `sidebar.ts:301-347`.

Context menu: `tab-list.ts:118-339` — items are `div.tab-context-menu-item`
(`' disabled'` when inapplicable), label from `t('contextMenu.tab.…')`, handler
`e.stopPropagation(); hideTabContextMenu(); <action>()`; shell API
`hideTabContextMenu` / `setActiveContextMenu` / `positionMenu` (`tab-bar/menu.ts:7-27`),
menu appended to `document.body`, dismissed by document click / Escape
(`tab-bar/index.ts:77-78`). `renamable` excludes `kanban` / `project-tab` / `team` (126).

Rename: `startRename()` (79-116) swaps `.tab-name` for an `<input>` with
`maxLength = MAX_SESSION_NAME_LENGTH` (84); Enter commits through
`appState.renameSession(project.id, session.id, newName, true)` (97), Escape reverts,
blur commits. `split-layout.ts:149` reads `#tab-list .tab-name input` to avoid stealing
rename focus.

State: `state.ts:1349-1355` `reorderSession` = find-guard → pure helper
`reorderSessionInProject` (`state/layout-state.ts:53-64`, which resyncs
`layout.splitPanes` after the splice) → `this.persist()` → `this.emit('session-changed')`.
`initTabBar` (`tab-bar/index.ts:58-64`) already subscribes `render` to
`state-loaded`/`project-changed`/`session-added`/`session-removed`/`session-changed`/
`layout-changed`, so a `session-changed` mutation re-renders the strip with no new
plumbing. `renameSession` (1188-1209) truncates at `MAX_SESSION_NAME_LENGTH = 60` (75)
and guards non-renamable tab types (1193).

Close funnel: `session-close.ts:43-49` → `appState.removeSession` (`state.ts:871-912`),
which prunes inline: history finalize (875-896), `project.sessions` (899),
`sessionIndex` (900), nav (901), `activeSessionId` (902-906), `layout.splitPanes` (908).
Batch closes loop the same method (`batchRemoveSessions` 1266-1271).

Persistence: `ensureProjectDefaults` (`state/persistence.ts:72-86`) is the canonical
per-project normalizer for optional fields (`project.board` at 74, stale board
`sessionId` cleared at 75); `serializeForSave` (106-114) strips prompt/env fields only,
so a new optional field persists verbatim. `layout.splitPanes` is deliberately **not**
filtered at load — staleness is handled at removal.

Auto naming: `state/session-naming.ts` — `{num}` template keys → anchored regex
(`toPattern` 11-15), one pattern per locale via `allTranslations` (`patternsFor` 26-33),
`parseNumberedName` (36-42), `nextNumberFor` (51-57, counts names across
`sessions` + `sessionHistory` so numbering survives closes), `defaultSessionName`
(65-67). `en.json` `tab.newSession.defaultName` = `"Session {num}"`.

Ids: no wrapper helper — `crypto.randomUUID()` inline at every creation site
(`session-factory.ts:9,23,50,62,73,84,95,108`, `board-state.ts:45`, `grid.ts:246`),
stubbed in tests.

Order consumers: `gotoSession(index)` (`state.ts:1239-1242`) and `cycleSession`
(1228-1234 → `cycleSessionId`, `layout-state.ts:21-24`) read `project.sessions`
directly; `CmdOrCtrl+1..9` / `CmdOrCtrl+Shift+[/]` (`shortcuts.ts:30-40`,
`keybindings.ts:55-59`). No DOM-based tab traversal exists.

Gaps this plan closes: no grouping, and the tab-list DOM/menu is documented as
UNTESTED (`docs/FEATURES.md:21`, `403`).

## Contract (shared by all slices)

Data — `src/shared/types.ts` (near `TagDefinition` 297-300; `ProjectRecord` 308-334):

```ts
/** Named cluster of adjacent session tabs in the tab strip. */
export interface TabGroupRecord {
  id: string;
  name: string;
  /** Member session ids, kept in project.sessions order. */
  sessionIds: string[];
  /** Index into the tab-group color palette. */
  colorIndex: number;
}
```

`ProjectRecord` gains `tabGroups?: TabGroupRecord[]` — the existing optional-field
style (`board?`, `overviewLayout?`, `githubLastSeen?`), so old `state.json` files need
no migration.

Invariants, enforced in state and asserted in tests:

1. a session id appears in at most one group;
2. every member id exists in `project.sessions`;
3. `sessionIds.length >= 2`, otherwise the group dissolves;
4. members stay contiguous in `project.sessions` order (run-splitting on reorder);
5. `sessionIds.length <= TAB_GROUP_MAX_MEMBERS` (12);
6. `colorIndex` in `0..TAB_GROUP_COLOR_COUNT-1` (6), lowest free index at creation;
7. `name.length <= MAX_SESSION_NAME_LENGTH` (60);
8. `project-tab` / `kanban` / `team` tabs are never groupable (mirrors the
   `renameSession` guard at `state.ts:1193` and `renamable` at `tab-list.ts:126`);
9. `project.tabGroups` order is irrelevant — rendering derives order from
   `project.sessions`.

No `nameIsCustom` flag: the auto name is assigned at creation and never rewritten, so a
manual rename survives by construction and membership edits never rename a group under
the user's cursor.

## Change

### 1. Pure state — new `src/renderer/state/tab-group-state.ts`

`layout-state.ts` style: takes `ProjectRecord`, mutates in place, returns a value,
no persistence, no events.

```ts
export const TAB_GROUP_COLOR_COUNT = 6;
export const TAB_GROUP_MAX_MEMBERS = 12;
export const TAB_GROUP_DWELL_MS = 450;

export function isGroupableTab(session: SessionRecord): boolean;
export function findGroupForSession(project: ProjectRecord, sessionId: string): TabGroupRecord | null;
export function groupTabsInProject(project: ProjectRecord, draggedSessionId: string, targetSessionId: string): string | null;
export function ungroupInProject(project: ProjectRecord, groupId: string): boolean;
export function renameTabGroupInProject(project: ProjectRecord, groupId: string, name: string): boolean;
export function pruneSessionFromTabGroups(project: ProjectRecord, sessionId: string): void;
export function normalizeTabGroups(project: ProjectRecord): void;
```

`groupTabsInProject` returns the new/existing group id, `null` for a no-op
(reject: equal ids, unknown id, either tab not groupable, target group full):

- both ungrouped → new group of both, ordered by `project.sessions` index, auto name,
  lowest free color;
- dragged grouped + target ungrouped → dragged's whole group relocates adjacent to the
  target and absorbs it;
- target grouped + dragged ungrouped → dragged joins the target's group at the boundary
  nearest the drag;
- both grouped, different groups → dragged's group merges into the target's and is
  dissolved;
- same group → no-op.

`normalizeTabGroups` (idempotent): drop member ids absent from `project.sessions`; drop
ids duplicated across groups; split each group into maximal **contiguous** runs of
`project.sessions` — runs ≥ 2 survive (extra runs get `defaultGroupName` + lowest free
color), runs of 1 dissolve; drop groups below 2; clamp/deduplicate `colorIndex`. Dragging
a tab out of a group's middle therefore detaches it and splits the rest, which is the
behaviour the drop zones make visible.

### 2. Auto name — `src/renderer/state/session-naming.ts`

Reuse the numbered-name engine; add:

```ts
export const GROUP_NAME_KEY = 'tab.group.defaultName';
/** Next group number; counts existing group names, like nextNumberFor. */
export function nextGroupNumber(project: ProjectRecord): number;
export function defaultGroupName(project: ProjectRecord): string; // t(GROUP_NAME_KEY, { num })
```

`en.json` `"Group {num}"`, `zh-CN.json` `"分组 {num}"`. Group ids are plain
`crypto.randomUUID()`.

### 3. Mutators — `src/renderer/state.ts`

Canonical shape (see `reorderSession` 1349-1355): find-guard → pure helper →
`this.persist()` → `this.emit('session-changed')`. No new `EventType` member:
`initTabBar` already renders on `session-changed`. No-op ⇒ no persist, no emit.

```ts
groupSessions(projectId: string, draggedSessionId: string, targetSessionId: string): void;
renameTabGroup(projectId: string, groupId: string, name: string): void;  // truncate at MAX_SESSION_NAME_LENGTH
ungroupTabGroup(projectId: string, groupId: string): void;
```

### 4. Lifecycle + persistence

- `removeSession` (`state.ts:871-912`): call `pruneSessionFromTabGroups(project, sessionId)`
  beside the `splitPanes` filter (908). `removeSession` is the single funnel for every
  close path (`batchRemoveSessions` 1266-1271, `removeProject` 440-456), and group
  membership is persisted state, so it is pruned inline — **not** via a `session-removed`
  subscriber, the pattern used only for module-local `Map`/`Set` side tables
  (e.g. `session-unread.ts:66-69`).
- `ensureProjectDefaults` (`state/persistence.ts:72-86`): `normalizeTabGroups(project)`
  per project, next to the `project.board` default (74).
- `reorderSessionInProject` (`layout-state.ts:53-64`): `normalizeTabGroups(project)`
  right after the existing `splitPanes` resync (58-62) — same resync idiom, keeps
  contiguity after every reorder path (drag, `moveLeft`/`moveRight` menu items).
- `serializeForSave` (106-114): unchanged; groups persist verbatim.

### 5. Render — `src/renderer/components/tab-bar/tab-list.ts`

`render()` walks `project.sessions` in order; a maximal run of consecutive tabs sharing a
group id is wrapped:

```html
<div class="tab-group tab-group-color-2">
  <div class="tab-group-label" data-group-id="…">
    <span class="tab-group-dot"></span>
    <span class="tab-group-name">Group 1</span>
    <span class="tab-group-count">3</span>
  </div>
  <div class="tab-item in-group" data-session-id="…">…</div> <!-- × N -->
</div>
```

Ungrouped tabs are appended to `#tab-list` exactly as today.

- Tabs keep `.tab-item` **and** `dataset.sessionId` (368): `updateTabStatus` (487, 492)
  patches the status dot via `.tab-item[data-session-id=…]` from `tabListEl`, and every
  existing tab-bar query (`split-layout.ts:149`, `.tab-close` 387/412, `.tab-name`
  80/81/342/388) is a descendant query, so nesting is safe.
- The group label **must not** contain `.tab-name` — that selector is the rename-focus
  guard at `split-layout.ts:149`.
- `.tab-item` is `height: 100%` (`tabs.css:41`), so `.tab-group` needs
  `display: flex; align-items: stretch; height: 100%`.
- `#tab-list` stays the scrolling element; the auto-scroll math (474-482) is rect-based
  (`getBoundingClientRect`) and nesting-tolerant; `tab-scroll.ts` is DOM-free by design
  and needs no change.
- Status dots, unread, sharing, provider badges, `tabNamePrefix` (42-62) and
  `tabTitle` (64-76) stay per-tab and untouched.

### 6. Hover-to-group affordance — same file (416-464)

Keep the existing zones and add a center zone:

- outer thirds → reorder, unchanged (`drag-over-left` / `drag-over-right`);
- center zone → group. One module-level dwell timer, `hover-card.ts`'s clear+set idiom
  (`hover-card.ts:3-4` `HOVER_DELAY_MS = 600`, `hide` 48-58, `scheduleShow` 60-66): on
  `dragover` in the center zone, `clearTimeout` + `setTimeout(…, TAB_GROUP_DWELL_MS)`;
  when it fires, add `.drag-over-group` to the target tab — and to every tab of the
  target's group when the target is already grouped.
- Cancel the timer on `dragleave` and sweep `.drag-over-group` in `drop` and in the
  `dragend` sweep (458-464), next to `.drag-over-left, .drag-over-right`.
- `drop`: center zone → `appState.groupSessions(project.id, draggedId, session.id)`;
  outer thirds → the existing `reorderSession` path, untouched.
- All group affordances are skipped while a rename input is open (existing guard 342).

Grouping commits on **drop**, not on timer fire: `render()` wipes
`tabListEl.innerHTML` (347), so mutating state mid-drag destroys the drag source and
leaves a dangling drag. The dwell is the hover feedback the request asks for; the drop is
the commit.

### 7. Group menu — same file

- `.tab-group-label` `contextmenu` (same `e.preventDefault()` shape as 406-409) →
  **Rename group**, separator, **Ungroup**.
- `showTabContextMenu` gains the same two items, after a separator, when the tab is in a
  group (so a user can rename/ungroup from any member tab). Items are disabled and
  omitted per the existing idiom (127-136); label from `t()`; handler
  `e.stopPropagation(); hideTabContextMenu(); <action>()`; menu built with
  `setActiveContextMenu` + `positionMenu`.
- `startGroupRename(labelEl, project, group)` mirrors `startRename` (79-116):
  `input.maxLength = MAX_SESSION_NAME_LENGTH`, Enter → `appState.renameTabGroup`,
  Escape → revert + `render()`, blur → commit, empty input keeps the old name.
- Ungroup → `appState.ungroupTabGroup(project.id, groupId)`.

Shortcuts: the group-rename input is a text field inside the tab bar, so shortcut
suppression follows `docs/ui-conventions.md:10` — the existing `.tab-name input`
field-guard semantics, extended to the group label's input.

### 8. Styles — `src/renderer/styles/tabs.css` + `src/renderer/styles/base.css`

Group rules next to the drag classes (`tabs.css:414-425`): `.tab-group`,
`.tab-group-label`, `.tab-group-dot`, `.tab-group-name`, `.tab-group-count`,
`.tab-item.in-group`, `.tab-group-color-0..5`, `.drag-over-group` (inset `box-shadow`,
matching `drag-over-left/-right` at 419-424). Label is truncated with an ellipsis;
the full name goes in its `title`.

`base.css` gains `--tab-group-1..6` in all three theme blocks (`:root` 28-62,
`[data-theme="dark"]` 76+, `[data-theme="light"]` 105+). Tints use
`color-mix(in srgb, var(--tab-group-N) 22%, transparent)` (idiom: `kanban.css:119`).
No hard-coded colors (`docs/ui-conventions.md:4`).

### 9. i18n — `src/renderer/locales/en.json` + `zh-CN.json`

- `contextMenu.tab.renameGroup`, `contextMenu.tab.ungroup` (block at `en.json:146-161`,
  14 existing keys).
- `tab.group.defaultName` (`"Group {num}"`), `tab.group.tooltip` (`{name}`/`{count}`),
  `tab.group.renameTooltip` in the `tab.*` block (83-131), next to
  `newSession.defaultName`.
- Mirror every key in `zh-CN.json`. No locale-parity test exists (`i18n.test.ts` covers
  interpolation/fallback only; `docs/FEATURES.md:391` tracks the key-count gap), and
  zh-CN falls back to English, so mirroring is the convention.
- `defaultName` must keep the `{num}` placeholder — `session-naming.ts` turns it into the
  numbered-name pattern.

No literals in `tab-list.ts`.

## Non-goals

Collapse/expand (a collapsed active tab returns a zero rect and breaks the auto-scroll
math at `tab-list.ts:478-480`), dragging a group as a unit, per-group close-all,
user-picked colors (auto palette only), a color picker, keyboard commands for groups,
and any group behavior in the split/swarm layouts. `CmdOrCtrl+1..9` and
`CmdOrCtrl+Shift+[/]` stay `project.sessions`-index based (`state.ts:1228-1242`,
`layout-state.ts:21-24`): a group is a view label, not an addressing unit.

## Decomposition

Contract above is frozen; slices 1-3 then run in parallel (slice 2/3 read the contract
for slice 1's API, not its code).

| Slice | Files | Deliverable |
| --- | --- | --- |
| 1 state | `shared/types.ts`, `state/tab-group-state.ts` (new), `state/session-naming.ts`, `state.ts`, `state/layout-state.ts`, `state/persistence.ts` + tests | data model, helpers, mutators, close-pruning, hydrate sanitising |
| 2 UI | `components/tab-bar/tab-list.ts`, `styles/tabs.css`, `styles/base.css`, `components/tab-bar/tab-list.test.ts` (new) | group rendering, dwell affordance, group menu, styles, DOM tests |
| 3 strings/docs | `locales/en.json`, `locales/zh-CN.json`, `docs/{FEATURES,ui-conventions,session-lifecycle}.md` | locale keys, contract docs |

Conflicts: slice 2 and the scroll-arrows plan both touch the `render()` tail and
`tabs.css`; land one before the other.

## Tests

`src/renderer/state/tab-group-state.test.ts` (pure literals, `persistence.test.ts:9-25`
fixture style): pair grouping and member order; merge two groups; join a tab to a full
group → no-op; non-groupable tab (project-tab/kanban/team) → no-op; run-split when a
middle tab is dragged out, new run gets a fresh auto name; dissolve at size 1;
`normalizeTabGroups` on dead ids / cross-group duplicates / bad `colorIndex`; auto name
numbering survives close + recreate; rename truncation.

Mutator + pruning tests in `layout-state.test.ts:1-55` style (window store stub,
`crypto.randomUUID` stub, `vi.mock` of `../session-cost.js`, `../session-context.js`,
`../provider-availability.js`, `_resetForTesting` in `beforeEach`, real-mutator
fixtures): `groupSessions` / `renameTabGroup` / `ungroupTabGroup` persist once
(`flushPersist()` + `mockSave` toHaveBeenCalled) and a no-op persists **not**
(`layout-state.test.ts:214-217`); `removeSession` prunes membership and dissolves at
size 1 — needs the `session.transcriptExistsSync` window stub
(`session-mutations.test.ts:9`); `ensureProjectDefaults` sanitises a hostile `tabGroups`
literal (`persistence.test.ts` style).

New `src/renderer/components/tab-bar/tab-list.test.ts` (`// @vitest-environment jsdom`
docblock — vitest defaults to `environment: 'node'`, `vitest.config.ts:21`): a
`split-layout-test-dom.ts:1-12`-style harness (vibeyard bridge stub +
`document.body.innerHTML = '<div id="tab-list"></div>'`) imported **before** the module
under import, `DataTransfer` stub per `terminal-utils.test.ts:66-69`. Cover: a group
renders one `.tab-group` wrapper with label/count and its tabs keep
`[data-session-id]`; group label contextmenu yields Rename group + Ungroup and a tab
contextmenu yields them only for grouped tabs; rename Enter commits / Escape reverts;
ungroup unwraps the tabs; center-zone drop calls `groupSessions`, edge drop calls
`reorderSession`; `updateTabStatus` still patches a grouped tab. Closes part of the
documented tab-list UNTESTED gap (`docs/FEATURES.md:21`, `403`).

## Docs

- `docs/FEATURES.md` §1 table (header at 14): new **Tab groups** row (behavior / modules
  `components/tab-bar/tab-list.ts`, `state/tab-group-state.ts`,
  `state/session-naming.ts` / tests / limits) and extend the **Tab context menu** row
  (21) item list with Rename group / Ungroup; Appendix A limits bullets (371-393,
  `Thing N (file:line).` format): `TAB_GROUP_DWELL_MS`, `TAB_GROUP_MAX_MEMBERS`,
  `TAB_GROUP_COLOR_COUNT`, group name ≤ 60; Appendix B (403) untested-cluster note now
  that tab-list has DOM tests.
- `docs/ui-conventions.md` (lines 4, 8): group label as a tab-bar widget,
  theme-variable-only colors, contracts-updated rule.
- `docs/session-lifecycle.md`: closing a session prunes group membership; groups below
  two members dissolve.

`CHANGELOG.md` is release-workflow generated — not touched.

## Verification

```bash
npx tsc -p tsconfig.renderer.json --noEmit
npm test -- src/renderer/state src/renderer/components/tab-bar src/renderer/i18n.test.ts
git diff --check
npm start   # smoke: hover tab B over the center of tab A → group highlight appears,
            # drop → one group, auto name "Group 1", count 2, colored label;
            # edge drops still reorder; drag C in → count 3, name unchanged;
            # right-click label → Rename group (Enter commits, Escape reverts, empty
            # keeps old name) and Ungroup; right-click a member tab → same two items;
            # drag the middle tab of a 3-group out → group splits/dissolves correctly;
            # close a member → group dissolves at size 1;
            # Close all / Close others → no dangling group after reload (restart app);
            # long strip: scroll + auto-scroll-to-active-tab still correct with groups;
            # CmdOrCtrl+1..9 and CmdOrCtrl+Shift+[/] still select in strip order;
            # rename inside a group works and shortcuts stay suppressed;
            # zh-CN locale → group strings translated; both themes legible.
```
