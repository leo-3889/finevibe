import { createModalShell, createModalButton } from '../../modal-shell.js';
import type { OverviewWidget } from '../../../../shared/types.js';
import {
  DEFAULT_SESSIONS_CONFIG,
  SESSIONS_RECENT_LIMIT_MAX,
  SESSIONS_RECENT_LIMIT_MIN,
  type SessionsConfig,
} from './sessions-types.js';

export function showSessionsSettings(
  widget: OverviewWidget,
  onSave: (patch: Partial<SessionsConfig>) => void,
): void {
  const shell = createModalShell({ id: 'sessions-settings-modal', title: 'Sessions Settings' });
  shell.body.innerHTML = '';
  shell.actions.innerHTML = '';

  const cfg = (widget.config ?? {}) as Partial<SessionsConfig>;
  const current: SessionsConfig = {
    recentLimit:
      typeof cfg.recentLimit === 'number' ? cfg.recentLimit : DEFAULT_SESSIONS_CONFIG.recentLimit,
  };

  const form = document.createElement('div');
  form.className = 'widget-settings-form';

  const limitField = document.createElement('div');
  limitField.className = 'widget-settings-field';

  const limitLabel = document.createElement('label');
  limitLabel.textContent = 'Max recent sessions';
  limitLabel.htmlFor = 'sessions-settings-limit';
  limitField.appendChild(limitLabel);

  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.id = 'sessions-settings-limit';
  limitInput.min = String(SESSIONS_RECENT_LIMIT_MIN);
  limitInput.max = String(SESSIONS_RECENT_LIMIT_MAX);
  limitInput.value = String(current.recentLimit);
  limitField.appendChild(limitInput);

  const limitHelp = document.createElement('div');
  limitHelp.className = 'widget-settings-help';
  limitHelp.textContent = `How many archived sessions to show in the Recent section (${SESSIONS_RECENT_LIMIT_MIN}–${SESSIONS_RECENT_LIMIT_MAX}).`;
  limitField.appendChild(limitHelp);

  form.appendChild(limitField);
  shell.body.appendChild(form);

  const cancel = createModalButton('Cancel', false);
  cancel.addEventListener('click', close);
  shell.actions.appendChild(cancel);

  const save = createModalButton('Save', true);
  save.addEventListener('click', () => {
    const raw = parseInt(limitInput.value, 10);
    const clamped = Math.max(
      SESSIONS_RECENT_LIMIT_MIN,
      Math.min(SESSIONS_RECENT_LIMIT_MAX, isNaN(raw) ? DEFAULT_SESSIONS_CONFIG.recentLimit : raw),
    );
    onSave({ recentLimit: clamped });
    close();
  });
  shell.actions.appendChild(save);

  shell.overlay.style.display = 'flex';
  document.addEventListener('keydown', onKeydown);
  shell.overlay.addEventListener('click', onOverlayClick);
  limitInput.focus();
  limitInput.select();

  function close(): void {
    shell.overlay.style.display = 'none';
    document.removeEventListener('keydown', onKeydown);
    shell.overlay.removeEventListener('click', onOverlayClick);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function onOverlayClick(e: MouseEvent): void {
    if (e.target === shell.overlay) close();
  }
}
