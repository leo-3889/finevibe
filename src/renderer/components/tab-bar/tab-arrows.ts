// DOM glue for the tab strip's scroll arrows: reads the strip's boxes, pushes
// them through the pure decisions in tab-scroll.ts, and writes the result to
// the two buttons. The buttons live at the leading edge of #tab-bar (index.html).

import { t, onLocaleChange } from '../../i18n.js';
import { tabListEl } from './dom.js';
import { tabsOverflow, arrowsEnabled, scrollStep } from './tab-scroll.js';

// Resolved on demand, not at module load: render() calls syncTabArrows() as
// its tail hook, and tab-list.test.ts mounts a fixture with only #tab-list.
// No group in the document, no arrows to sync — the module is inert there.
function arrowRefs(): { arrowsEl: HTMLElement; btnLeft: HTMLButtonElement; btnRight: HTMLButtonElement } | null {
  const arrowsEl = document.getElementById('tab-scroll-arrows');
  const btnLeft = document.getElementById('tab-scroll-left') as HTMLButtonElement | null;
  const btnRight = document.getElementById('tab-scroll-right') as HTMLButtonElement | null;
  return arrowsEl && btnLeft && btnRight ? { arrowsEl, btnLeft, btnRight } : null;
}

/**
 * Show/hide the group and enable/disable each button from the strip's current
 * geometry. Idempotent and cheap — the class flip is a no-op when unchanged and
 * `disabled` assignment does not mutate when the value is the same — so the
 * scroll listener and the ResizeObserver can both call it raw.
 */
export function syncTabArrows(): void {
  const refs = arrowRefs();
  if (!refs) return;
  const visible = tabsOverflow(
    tabListEl.scrollWidth,
    tabListEl.clientWidth,
    !refs.arrowsEl.classList.contains('hidden'),
  );
  refs.arrowsEl.classList.toggle('hidden', !visible);
  const { canLeft, canRight } = arrowsEnabled(
    tabListEl.scrollLeft,
    tabListEl.scrollWidth,
    tabListEl.clientWidth,
  );
  refs.btnLeft.disabled = !canLeft;
  refs.btnRight.disabled = !canRight;
}

function scrollTabsBy(dir: -1 | 1): void {
  tabListEl.scrollBy({ left: dir * scrollStep(tabListEl.clientWidth), behavior: 'smooth' });
}

/** Labels, re-translated on every locale change (SR2-d). */
function applyArrowLabels(): void {
  const refs = arrowRefs();
  if (!refs) return;
  for (const [btn, key] of [
    [refs.btnLeft, 'tab.scrollLeftTooltip'],
    [refs.btnRight, 'tab.scrollRightTooltip'],
  ] as const) {
    const label = t(key);
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
}

/** Labels and clicks; visibility is syncTabArrows' alone (see render()'s hook). */
export function initTabArrows(): void {
  const refs = arrowRefs();
  if (!refs) return;
  applyArrowLabels();
  // SR2-d: the labels used to be translated once at init and froze in the
  // boot-time locale — a mid-session language switch left English tooltips.
  onLocaleChange(applyArrowLabels);
  for (const [btn, dir] of [[refs.btnLeft, -1], [refs.btnRight, 1]] as const) {
    btn.addEventListener('click', () => scrollTabsBy(dir));
  }
}
