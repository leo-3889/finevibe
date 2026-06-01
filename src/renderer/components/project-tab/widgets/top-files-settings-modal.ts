import { createModalShell, createModalButton } from '../../modal-shell.js';
import { bindModalDismiss } from '../../modal-manager.js';
import type { OverviewWidget } from '../../../../shared/types.js';
import {
  DEFAULT_TOP_FILES_CONFIG,
  TOP_FILES_LIMIT_MAX,
  TOP_FILES_LIMIT_MIN,
  resolveTopFilesConfig,
  type TopFilesConfig,
} from './top-files-types.js';

export function showTopFilesSettings(
  widget: OverviewWidget,
  onSave: (patch: Partial<TopFilesConfig>) => void,
): void {
  const shell = createModalShell({ id: 'top-files-settings-modal', title: 'Top Files Settings' });

  const { limit: currentLimit } = resolveTopFilesConfig(widget.config as Partial<TopFilesConfig> | undefined);

  const form = document.createElement('div');
  form.className = 'widget-settings-form';

  const limitField = document.createElement('div');
  limitField.className = 'widget-settings-field';

  const limitLabel = document.createElement('label');
  limitLabel.textContent = 'How many files to show';
  limitLabel.htmlFor = 'top-files-settings-limit';
  limitField.appendChild(limitLabel);

  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.id = 'top-files-settings-limit';
  limitInput.min = String(TOP_FILES_LIMIT_MIN);
  limitInput.max = String(TOP_FILES_LIMIT_MAX);
  limitInput.value = String(currentLimit);
  limitField.appendChild(limitInput);

  const limitHelp = document.createElement('div');
  limitHelp.className = 'widget-settings-help';
  limitHelp.textContent = `Top K files by estimated token count (${TOP_FILES_LIMIT_MIN}–${TOP_FILES_LIMIT_MAX}).`;
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
      TOP_FILES_LIMIT_MIN,
      Math.min(TOP_FILES_LIMIT_MAX, isNaN(raw) ? DEFAULT_TOP_FILES_CONFIG.limit : raw),
    );
    onSave({ limit: clamped });
    close();
  });
  shell.actions.appendChild(save);

  shell.overlay.style.display = 'flex';
  const teardownDismiss = bindModalDismiss({ overlay: shell.overlay, onClose: close });
  limitInput.focus();
  limitInput.select();

  function close(): void {
    shell.overlay.style.display = 'none';
    teardownDismiss();
  }
}
