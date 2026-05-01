let cardEl: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

function ensureCard(): HTMLDivElement {
  if (cardEl) return cardEl;
  const el = document.createElement('div');
  el.className = 'hover-card hidden';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  cardEl = el;
  return el;
}

function show(target: HTMLElement, content: string): void {
  const card = ensureCard();
  card.textContent = content;
  card.classList.remove('hidden');

  const rect = target.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 8;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let top = rect.bottom + margin;
  let left = rect.left + rect.width / 2 - cardRect.width / 2;
  if (top + cardRect.height > viewportH - margin) {
    top = rect.top - cardRect.height - margin;
  }
  if (left + cardRect.width > viewportW - margin) {
    left = viewportW - cardRect.width - margin;
  }
  if (left < margin) left = margin;

  card.style.top = `${Math.max(margin, top)}px`;
  card.style.left = `${left}px`;

  if (!escHandler) {
    escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', escHandler);
  }
}

function hide(): void {
  if (cardEl) cardEl.classList.add('hidden');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

export function hideHoverCard(): void {
  hide();
}

export function attachHoverCard(target: HTMLElement, content: string): void {
  target.addEventListener('mouseenter', () => show(target, content));
  target.addEventListener('focusin', () => show(target, content));
  target.addEventListener('mouseleave', hide);
  target.addEventListener('focusout', hide);
}
