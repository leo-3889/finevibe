import { escapeHtml } from './dom-search-backend.js';
import { pushModal } from './modal-manager.js';
import { t } from '../i18n.js';

let cleanupFn: (() => void) | null = null;
let pendingResolve: ((choice: 'replace' | 'keep') => void) | null = null;

function getOverlay(): HTMLElement {
  let overlay = document.getElementById('statusline-conflict-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'statusline-conflict-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML = '<div class="modal-box statusline-conflict-box"></div>';
  document.body.appendChild(overlay);
  return overlay;
}

export function showStatusLineConflictModal(foreignCommand: string): Promise<'replace' | 'keep'> {
  // Resolve any previous pending invocation before re-showing
  if (pendingResolve) {
    pendingResolve('keep');
    pendingResolve = null;
  }
  cleanupFn?.();
  cleanupFn = null;

  const overlay = getOverlay();
  const box = overlay.querySelector('.statusline-conflict-box')!;

  // Render the whole box per show so a locale switch between prompts is
  // reflected. The copy is statusLine-scoped on purpose: Replace rewrites
  // only the statusLine key in settings.json (installStatusLine), Keep
  // leaves the foreign command in place. Nothing here imports settings —
  // the legacy full import is the separate projects feature.
  box.innerHTML = `
    <div class="modal-title">${t('statuslineConflict.title')}</div>
    <div class="modal-body statusline-conflict-body">
      <p class="statusline-conflict-text">
        ${t('statuslineConflict.intro')}
      </p>
      <div class="statusline-conflict-command">
        <div class="statusline-conflict-command-label">${t('statuslineConflict.currentLabel')}</div>
        <code>${escapeHtml(foreignCommand)}</code>
      </div>
      <p class="statusline-conflict-text statusline-conflict-warning">
        ${t('statuslineConflict.warning')}
      </p>
    </div>
    <div class="modal-actions">
      <button id="statusline-conflict-keep" class="btn-secondary">${t('statuslineConflict.keepButton')}</button>
      <button id="statusline-conflict-replace" class="btn-primary">${t('statuslineConflict.replaceButton')}</button>
    </div>`;

  overlay.style.display = '';

  return new Promise((resolve) => {
    pendingResolve = resolve;
    const keepBtn = overlay.querySelector('#statusline-conflict-keep') as HTMLButtonElement;
    const replaceBtn = overlay.querySelector('#statusline-conflict-replace') as HTMLButtonElement;

    const close = (choice: 'replace' | 'keep') => {
      overlay.style.display = 'none';
      cleanupFn?.();
      cleanupFn = null;
      pendingResolve = null;
      resolve(choice);
    };

    const handleKeep = () => close('keep');
    const handleReplace = () => close('replace');

    const unregisterEsc = pushModal({ onEscape: handleKeep });
    keepBtn.addEventListener('click', handleKeep);
    replaceBtn.addEventListener('click', handleReplace);

    cleanupFn = () => {
      unregisterEsc();
      keepBtn.removeEventListener('click', handleKeep);
      replaceBtn.removeEventListener('click', handleReplace);
    };

    requestAnimationFrame(() => keepBtn.focus());
  });
}
