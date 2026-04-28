import { createModalShell, createModalButton } from '../modal-shell.js';
import { buildSection, badge, mono } from '../help-shared.js';
import { createDefaultBoard } from '../../state.js';
import type { ColumnBehavior } from '../../../shared/types.js';

let cleanupFn: (() => void) | null = null;

const BEHAVIOR_DESCRIPTION: Record<ColumnBehavior, string> = {
  inbox: 'New tasks land here. Tasks from deleted columns also fall back here.',
  none: 'Plain user-managed column. No automation. Only these columns can be added or deleted.',
  active: 'Tasks auto-move here when you click Run and a session spawns.',
  terminal: 'Tasks auto-move here when their session completes.',
};

function buildDefaultColumnsSection(): HTMLElement {
  const section = document.createElement('div');
  section.className = 'help-section';

  const header = document.createElement('div');
  header.className = 'help-section-header';
  header.textContent = 'Default Columns';
  section.appendChild(header);

  for (const col of createDefaultBoard().columns) {
    const rowEl = document.createElement('div');
    rowEl.className = 'help-row';

    const visualEl = document.createElement('div');
    visualEl.className = 'help-visual';
    visualEl.appendChild(badge(col.title));

    const descEl = document.createElement('div');
    descEl.className = 'help-desc';
    descEl.textContent = BEHAVIOR_DESCRIPTION[col.behavior];

    rowEl.appendChild(visualEl);
    rowEl.appendChild(descEl);
    section.appendChild(rowEl);
  }

  return section;
}

export function showBoardHelpDialog(): void {
  cleanupFn?.();
  cleanupFn = null;

  const { overlay, body, actions } = createModalShell({
    id: 'board-help-overlay',
    title: 'About the Board',
    wide: true,
  });
  body.innerHTML = '';
  actions.innerHTML = '';

  const confirmBtn = createModalButton('Done', true);
  confirmBtn.id = 'board-help-confirm';
  actions.appendChild(confirmBtn);

  const container = document.createElement('div');
  container.className = 'help-container';

  container.appendChild(buildDefaultColumnsSection());

  container.appendChild(buildSection('Column Management', [
    { visual: () => mono('right-click'), label: 'Add column',    description: 'Right-click a column header to add a new column after it. New columns always have behavior "none".' },
    { visual: () => mono('dbl-click'),   label: 'Rename column', description: 'Double-click a column title to rename it.' },
    { visual: () => mono('delete'),      label: 'Delete column', description: 'Only "none" columns can be deleted, and never the last column. Tasks fall back to the Backlog (inbox).' },
  ]));

  container.appendChild(buildSection('Card Actions', [
    { visual: () => mono('▶'),     label: 'Run',       description: 'Spawns a session with the task prompt and moves the card to the Running column.' },
    { visual: () => mono('⟲'),     label: 'Resume',    description: 'Restores a previous session for the task using its saved CLI session id.' },
    { visual: () => mono('»'),     label: 'Focus',     description: 'Brings the task\'s active session to the front.' },
    { visual: () => mono('click'), label: 'Edit',      description: 'Opens the task modal to edit title, prompt, notes, tags, and plan mode.' },
    { visual: () => mono('right-click'), label: 'Delete', description: 'Right-click a card to delete it.' },
    { visual: () => badge('Plan'), label: 'Plan mode', description: 'When enabled in the task modal, Run spawns a plan-only session (provider permitting).' },
  ]));

  container.appendChild(buildSection('Tags & Search', [
    { visual: () => mono('search'), label: 'Search',  description: 'Filters tasks by title or prompt (case-insensitive substring).' },
    { visual: () => badge('#tag'),  label: 'Tags',    description: 'Click a tag pill to toggle a filter. Multiple tags AND together with the search.' },
    { visual: () => mono('+ tag'),  label: 'Add tag', description: 'Add new tags from the tag row; right-click a tag to recolor or delete it.' },
  ]));

  container.appendChild(buildSection('Drag & Drop', [
    { visual: () => mono('drag'),       label: 'Move card',     description: 'Drag a card across columns to change its column or order.' },
    { visual: () => mono('right-click'), label: 'Reorder columns', description: 'Right-click a column header to move it left or right (columns do not drag).' },
  ]));

  body.appendChild(container);
  overlay.style.display = '';

  const close = () => {
    overlay.style.display = 'none';
    cleanupFn?.();
    cleanupFn = null;
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  confirmBtn.addEventListener('click', close);
  document.addEventListener('keydown', handleKeydown);

  cleanupFn = () => {
    confirmBtn.removeEventListener('click', close);
    document.removeEventListener('keydown', handleKeydown);
  };
}
