import type { SelectorOption } from './types.js';

export function buildSelectorOptions(
  selectors: SelectorOption[],
  activeSelector: SelectorOption | undefined,
  onActivate: (sel: SelectorOption) => void
): HTMLElement {
  const container = document.createElement('div');
  const optionEls: HTMLElement[] = [];

  for (let i = 0; i < selectors.length; i++) {
    const sel = selectors[i];
    const row = document.createElement('div');
    row.className = 'inspect-selector-option';
    if (sel === activeSelector) row.classList.add('active');

    const badge = document.createElement('span');
    badge.className = `selector-badge selector-badge-${sel.type}`;
    badge.textContent = sel.type;

    const valueSpan = document.createElement('span');
    valueSpan.className = 'selector-value';
    valueSpan.textContent = sel.value;

    row.appendChild(badge);
    row.appendChild(valueSpan);
    optionEls.push(row);
    container.appendChild(row);

    row.addEventListener('click', () => {
      optionEls.forEach((el) => el.classList.remove('active'));
      optionEls[i].classList.add('active');
      onActivate(sel);
    });
  }

  return container;
}
