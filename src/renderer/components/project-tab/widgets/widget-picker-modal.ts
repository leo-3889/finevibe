import { createModalShell, createModalButton } from '../../modal-shell.js';
import { bindModalDismiss } from '../../modal-manager.js';
import { listWidgetTypes } from './widget-registry.js';
import type { OverviewWidget, OverviewWidgetType } from '../../../../shared/types.js';

export function showWidgetPicker(existing: OverviewWidget[], onPick: (type: OverviewWidgetType) => void): void {
  const shell = createModalShell({ id: 'widget-picker-modal', title: 'Add Widget', wide: true });
  shell.body.innerHTML = '';
  shell.actions.innerHTML = '';

  let teardownDismiss = () => {};
  function close(): void {
    shell.overlay.style.display = 'none';
    teardownDismiss();
  }

  const grid = document.createElement('div');
  grid.className = 'widget-picker-grid';
  shell.body.appendChild(grid);

  const countByType = new Map<string, number>();
  for (const w of existing) countByType.set(w.type, (countByType.get(w.type) ?? 0) + 1);

  for (const meta of listWidgetTypes()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'widget-picker-card';
    const count = countByType.get(meta.type) ?? 0;
    const isAdded = count > 0;
    const lockedOut = isAdded && !meta.allowMultiple;
    if (lockedOut) card.classList.add('disabled');
    if (isAdded) card.classList.add('added');

    const header = document.createElement('div');
    header.className = 'widget-picker-card-header';
    const name = document.createElement('div');
    name.className = 'widget-picker-name';
    name.textContent = meta.displayName;
    header.appendChild(name);
    if (isAdded) {
      const badge = document.createElement('span');
      badge.className = 'widget-picker-added-badge';
      badge.textContent = meta.allowMultiple ? `Added · ${count}` : 'Added';
      header.appendChild(badge);
    }
    card.appendChild(header);

    const desc = document.createElement('div');
    desc.className = 'widget-picker-desc';
    desc.textContent = meta.description;
    card.appendChild(desc);

    if (lockedOut) {
      card.disabled = true;
    } else {
      card.addEventListener('click', () => {
        onPick(meta.type);
        close();
      });
    }

    grid.appendChild(card);
  }

  const cancel = createModalButton('Close', false);
  cancel.addEventListener('click', close);
  shell.actions.appendChild(cancel);

  shell.overlay.style.display = 'flex';
  teardownDismiss = bindModalDismiss({ overlay: shell.overlay, onClose: close });
}
