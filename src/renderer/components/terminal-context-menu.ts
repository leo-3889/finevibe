import type { Terminal } from '@xterm/xterm';
import { isMac } from '../platform.js';
import { copyText, pasteIntoTerminal } from './terminal-utils.js';
import { t } from '../i18n.js';

let activeMenu: HTMLElement | null = null;

function makeItem(label: string, shortcut?: string): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'tab-context-menu-item';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  item.appendChild(labelSpan);
  if (shortcut) {
    const hint = document.createElement('span');
    hint.className = 'shortcut-hint';
    hint.textContent = shortcut;
    item.appendChild(hint);
  }
  return item;
}

function onDocumentClick(): void {
  hideTerminalContextMenu();
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hideTerminalContextMenu();
}

export function showTerminalContextMenu(
  x: number,
  y: number,
  terminal: Terminal,
  writeToPty: (data: string) => void,
  // Snapshot of the selection taken at right-mousedown by the pane wiring.
  // A TUI that enables SGR mouse reporting (pi-bolt: 1000;1002;1006) makes
  // xterm forward the right-mousedown as an escape-sequence report via
  // coreService.triggerDataEvent(report, true), which fires onUserInput — and
  // SelectionService clears the selection on every user input, BEFORE the
  // contextmenu event. Without the snapshot the menu opens with Copy greyed
  // out for a selection the user just made.
  snapshotSelection?: string
): void {
  hideTerminalContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // A live selection wins (right-click inside one keeps the current behavior,
  // incl. macOS word-select); fall back to the mousedown snapshot for the
  // report-forwarding clear above. Copy stays disabled when both are empty.
  const selectionText = terminal.hasSelection() ? terminal.getSelection() : (snapshotSelection ?? '');

  const copyItem = makeItem(t('contextMenu.terminal.copy'), isMac ? '⇧⌘C' : 'Ctrl+Shift+C');
  if (selectionText === '') {
    copyItem.classList.add('disabled');
  } else {
    const text = selectionText;
    copyItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTerminalContextMenu();
      terminal.focus();
      copyText(text);
    });
  }
  menu.appendChild(copyItem);

  const pasteItem = makeItem(t('contextMenu.terminal.paste'), isMac ? '⌘V' : 'Ctrl+V');
  pasteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTerminalContextMenu();
    terminal.focus();
    // The click is not a keystroke, so no paste event exists: read the clipboard
    // through main, which also turns a clipboard image into an attachment path.
    void pasteIntoTerminal(terminal, writeToPty).catch(() => {});
  });
  menu.appendChild(pasteItem);

  const sep1 = document.createElement('div');
  sep1.className = 'tab-context-menu-separator';
  menu.appendChild(sep1);

  const selectAllItem = makeItem(t('contextMenu.terminal.selectAll'));
  selectAllItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTerminalContextMenu();
    terminal.focus();
    terminal.selectAll();
  });
  menu.appendChild(selectAllItem);

  document.body.appendChild(menu);
  activeMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
}

export function hideTerminalContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeydown);
  }
}
