# Plan: scroll arrows for the tab strip (tab bar overflow)

Date: 2026-10-20 · Status: plan · Owner: TBD

## Request

In the session top bar (the strip holding session / open-file tabs), when the tabs
take more horizontal space than the strip has, show two arrow buttons **at the
beginning of the strip** (both on the left, before the first tab) that scroll the
strip left/right — the same scrolling the user can already do via the native
(near-invisible, 2 px) scrollbar.

## Current behavior (investigated)

Markup: `src/renderer/index.html:37-53` — `#tab-bar` is a flex row of
`#tab-list` (the strip, line 38), `#git-status` (39), `#tab-actions` (40-52).

CSS: `src/renderer/styles/tabs.css:20-34` — `#tab-list` is
`flex: 1; overflow-x: auto; overflow-y: hidden` with a 2 px webkit scrollbar
(`::-webkit-scrollbar { height: 2px }`). Overflow scrolling exists but is
effectively undiscoverable: there is no visible affordance, no arrows, and no
way to scroll without dragging the 2 px thumb (horizontal wheel is not handled).

Scroll mechanics:

- `src/renderer/components/tab-bar/tab-scroll.ts` — DOM-free per-project scroll
  state: `bankScroll()` memorizes the strip offset before a re-render,
  `planScroll()` decides restore + whether the active tab may auto-pull,
  `commitScroll()` records the result, `scrollDelta()` computes the
  bring-into-view delta. Any offset change not made by the auto-scroll is
  treated as a hand-scroll ("stays put once the user has scrolled by hand",
  `tab-scroll.test.ts:62`).
- `src/renderer/components/tab-bar/tab-list.ts:341-483` — `render()` wipes and
  rebuilds `#tab-list`, then restores `plan.scrollLeft` (474) and pulls the
  active tab into view (475-481). Early return while a rename input is open
  (342).
- `src/renderer/components/tab-bar/dom.ts` — shared refs (`tabListEl`).
- `.icon-btn` base style: `tabs.css:196-213`.

Gap: nothing signals that the strip scrolls, and dragging a 2 px thumb is the
only manual gesture. Arrow buttons are the fix.

## Change

### 1. Markup — `src/renderer/index.html`

Insert an arrow group as the first child of `#tab-bar`, **before** `#tab-list`
(this is the requested "beginning"; `#git-status`/`#tab-actions` untouched):

```html
<div id="tab-scroll-arrows" class="hidden">
  <button id="tab-scroll-left" class="icon-btn tab-scroll-arrow" aria-label="Scroll tabs left">&#x2039;</button>
  <button id="tab-scroll-right" class="icon-btn tab-scroll-arrow" aria-label="Scroll tabs right">&#x203A;</button>
</div>
```

Glyphs `‹`/`›` follow the existing text-glyph chevron precedent
(`file-tree.ts:211` uses `▸`). Hidden by default; JS owns visibility.

### 2. Pure state — `src/renderer/components/tab-bar/tab-scroll.ts`

Extend the DOM-free module (fits its stated purpose, unit-testable like
`scrollDelta`):

```ts
/** Width the arrow group takes from the strip when visible. */
export const ARROW_RESERVE_PX = 52;

/** Overflow test with hysteresis (see note below). */
export function tabsOverflow(scrollWidth: number, clientWidth: number, arrowsVisible: boolean): boolean;

/** Which arrows can scroll, from the current offset. */
export function arrowsEnabled(scrollLeft: number, scrollWidth: number, clientWidth: number): { canLeft: boolean; canRight: boolean };

/** One arrow click's scroll distance. */
export function scrollStep(clientWidth: number): number; // max(120, round(clientWidth * 0.6))
```

Rules:

- `canLeft = scrollLeft > 0`; `canRight = scrollLeft < scrollWidth - clientWidth - 1`
  (1 px slack absorbs sub-pixel layout, same trick as `scrollDelta`'s tests).
- **Hysteresis, loop prevention**: showing the arrows takes `ARROW_RESERVE_PX`
  away from `#tab-list`. Naive rule "visible ⟺ scrollWidth > clientWidth"
  oscillates in the band where content fits only without arrows (show → shrink
  → overflow → …). Rule: when hidden, show on `scrollWidth > clientWidth + 1`;
  when visible, hide only when `scrollWidth <= clientWidth` measured **with
  arrows on screen** — i.e. content has ≥ `ARROW_RESERVE_PX` of headroom with
  no arrows. Show is eager, hide needs reserve free; no oscillation.

### 3. DOM glue — new `src/renderer/components/tab-bar/tab-arrows.ts`

Small module owning the wiring, mirroring how `dom.ts`/`git-status-bar.ts` are
structured:

- Export refs (`tabScrollArrowsEl`, left/right buttons) — add to `dom.ts` with
  the other shared refs.
- `syncTabArrows()`: reads `tabListEl.scrollWidth/clientWidth/scrollLeft`,
  applies `tabsOverflow` + `arrowsEnabled` → toggles `.hidden` on the group and
  `disabled` on each button. Idempotent and cheap (writes only on change).
- `scrollTabsBy(dir: -1 | 1)`: `tabListEl.scrollBy({ left: dir * scrollStep(tabListEl.clientWidth), behavior: 'smooth' })`.
- `initTabArrows()`: sets `title` + `aria-label` from `t()` (per `tab.closeTooltip`
  precedent, `tab-list.ts:382`), wires clicks to `scrollTabsBy`.

### 4. Wiring — `src/renderer/components/tab-bar/index.ts` (`initTabBar`)

- Call `initTabArrows()`.
- `tabListEl.addEventListener('scroll', syncTabArrows, { passive: true })` —
  covers arrow clicks, native scrollbar drag, auto-scroll on session switch,
  and smooth-scroll settling (end-of-range disables update).
- `new ResizeObserver(syncTabArrows).observe(tabListEl)` — window resize,
  sidebar drag, and the strip width change from the arrows' own show/hide
  (converges thanks to the hysteresis rule).

### 5. Render hook — `src/renderer/components/tab-bar/tab-list.ts`

Call `syncTabArrows()` at the end of `render()` (after `commitScroll`, line
482) — tab add/remove/close/reorder/project-switch all flow through `render()`.
The rename-input early return (342) leaves the strip's content untouched, so
skipping the sync there is correct. No project (349): strip is empty → sync
hides the arrows.

No change needed to the bank/plan/commit sequence: an arrow-induced
`scrollLeft` is banked at the next `render()` exactly like a hand-scroll, so
per-project offset restore keeps working unchanged.

### 6. Styles — `src/renderer/styles/tabs.css`

```css
#tab-scroll-arrows { display: flex; align-items: center; height: 100%; flex-shrink: 0; }
#tab-scroll-arrows.hidden { display: none; }        /* repo convention: per-selector .hidden, no global utility (p2p-sharing.css:145) */
.tab-scroll-arrow { width: 24px; padding: 0; line-height: 1; font-size: 15px; }
.tab-scroll-arrow:disabled { opacity: 0.35; background: none; border-color: transparent; cursor: default; }
```

`.tab-scroll-arrow` adds to `.icon-btn` (tabs.css:196).

### 7. i18n — `src/renderer/locales/en.json` + `zh-CN.json`

Add under `tab`: `scrollLeftTooltip` ("Scroll tabs left") and
`scrollRightTooltip` ("Scroll tabs right"); mirror in zh-CN (fallback to en
works, parity is the convention).

Explicit non-goals: no auto-scroll during tab drag near the strip edges, no
wheel-to-horizontal-scroll translation, no change to the 2 px scrollbar, no
touch/trackpad momentum handling, no scroll-into-view changes in
`tab-scroll.ts`.

## Tests (`tab-scroll.test.ts`, existing vitest style)

Pure helpers, DOM-free:

- `tabsOverflow`: content wider → true (hidden state); content fits → false;
  content fits within the reserve **while arrows visible** → stays true
  (hysteresis); drops below clientWidth → false.
- `arrowsEnabled`: `scrollLeft = 0` → `canLeft` false; at max offset →
  `canRight` false; middle → both true; sub-pixel slack at max.
- `scrollStep`: 120 px floor; grows with client width.
- Bank/plan/commit interaction: an arrow scroll (offset moved outside
  `autoScrollLeft`) is treated as a hand-scroll — reuses the existing
  "stays put once the user has scrolled the strip by hand" pattern; add one
  case naming it as an arrow scroll for regression clarity.

## Docs

- `docs/FEATURES.md` "Tab bar & tab strip" row (line 20): arrows appear on
  overflow at the strip's leading edge, step-scroll, edge-disable; owning
  module list gains `tab-arrows.ts`; drop the strip from that row's UNTESTED
  note for the pure part.

## Verification

```bash
npx tsc -p tsconfig.renderer.json --noEmit
npm test -- src/renderer/components/tab-bar
git diff --check
npm start   # smoke: open one project, add ~10 sessions so tabs overflow →
            # arrows appear at the strip start; clicks step-scroll; left arrow
            # disabled at offset 0, right disabled at the far end; shrink the
            # window with few tabs → arrows hidden, no flicker on resize;
            # switch projects mid-scroll → offset restored per project;
            # close tabs until they fit → arrows disappear.
```
