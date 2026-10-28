import { createModalShell, createModalButton } from '../../modal-shell.js';
import { bindModalDismiss } from '../../modal-manager.js';

/**
 * Row 28 (code-cleanup audit): the single-numeric-limit widget settings modal.
 * `sessions-settings-modal.ts` and `top-files-settings-modal.ts` were 0.61
 * identical over 58 lines — the same form (one labelled number input, help
 * line, Cancel/Save with clamp-to-range) with different strings and bounds.
 * The two callers keep their own public signatures and pass the differences.
 */
export interface LimitSettingsOptions {
  /** Modal shell id; the input gets `<id>-limit`. */
  id: string;
  title: string;
  label: string;
  help: string;
  min: number;
  max: number;
  /** Used when the input parses to nothing sensible. */
  fallback: number;
  currentValue: number;
  onSave: (clamped: number) => void;
  cancelLabel: string;
  saveLabel: string;
}

export function showLimitSettingsModal(opts: LimitSettingsOptions): void {
  const shell = createModalShell({ id: opts.id, title: opts.title });
  shell.body.innerHTML = '';
  shell.actions.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'widget-settings-form';

  const field = document.createElement('div');
  field.className = 'widget-settings-field';

  const label = document.createElement('label');
  label.textContent = opts.label;
  const inputId = `${opts.id}-limit`;
  label.htmlFor = inputId;
  field.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = inputId;
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.value = String(opts.currentValue);
  field.appendChild(input);

  const help = document.createElement('div');
  help.className = 'widget-settings-help';
  help.textContent = opts.help;
  field.appendChild(help);

  form.appendChild(field);
  shell.body.appendChild(form);

  const close = (): void => {
    shell.overlay.style.display = 'none';
    teardownDismiss();
  };

  const cancel = createModalButton(opts.cancelLabel, false);
  cancel.addEventListener('click', close);
  shell.actions.appendChild(cancel);

  const save = createModalButton(opts.saveLabel, true);
  save.addEventListener('click', () => {
    const raw = parseInt(input.value, 10);
    const clamped = Math.max(opts.min, Math.min(opts.max, isNaN(raw) ? opts.fallback : raw));
    opts.onSave(clamped);
    close();
  });
  shell.actions.appendChild(save);

  shell.overlay.style.display = 'flex';
  const teardownDismiss = bindModalDismiss({ overlay: shell.overlay, onClose: close });
  input.focus();
  input.select();
}
