import type { ProjectRecord } from '../../../state.js';
import { createModalShell, createModalButton } from '../../modal-shell.js';
import { bindModalDismiss } from '../../modal-manager.js';
import { renderSessionHistory, closeSessionHistory } from '../../session-history.js';

const INSTANCE_KEY = 'dialog';
const CLEANUP_PROP = '__sessionsDialogCleanup';

type CleanupHolder = HTMLElement & { [CLEANUP_PROP]?: () => void };

export function showSessionHistoryDialog(project: ProjectRecord): void {
  const shell = createModalShell({
    id: 'sessions-history-dialog',
    title: 'Session History',
    wide: true,
  });

  // If the dialog was already open, tear down its listeners before re-wiring.
  (shell.overlay as CleanupHolder)[CLEANUP_PROP]?.();

  shell.body.innerHTML = '';
  shell.body.classList.add('session-history-dialog');
  shell.actions.innerHTML = '';

  let teardownDismiss = () => {};
  function close(): void {
    closeSessionHistory(project.id, INSTANCE_KEY);
    shell.overlay.style.display = 'none';
    teardownDismiss();
    delete (shell.overlay as CleanupHolder)[CLEANUP_PROP];
  }

  renderSessionHistory(project, shell.body, INSTANCE_KEY);

  const closeBtn = createModalButton('Close', false);
  closeBtn.addEventListener('click', close);
  shell.actions.appendChild(closeBtn);

  shell.overlay.style.display = 'flex';
  teardownDismiss = bindModalDismiss({ overlay: shell.overlay, onClose: close });
  (shell.overlay as CleanupHolder)[CLEANUP_PROP] = close;
}
