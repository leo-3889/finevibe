import { shortcutManager, displayKeys } from '../shortcuts.js';
import { createModalShell, createModalButton } from './modal-shell.js';

interface IndicatorRow {
  visual: () => HTMLElement;
  label: string;
  description: string;
}

let cleanupFn: (() => void) | null = null;

function dot(color: string, animate?: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = 'help-dot';
  el.style.background = color;
  if (animate) el.style.animation = 'pulse 1.5s ease-in-out infinite';
  return el;
}

function badge(text: string, color: string, bgColor?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'help-badge';
  el.textContent = text;
  el.style.color = color;
  if (bgColor) el.style.background = bgColor;
  return el;
}

function mono(text: string, color?: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'help-mono';
  el.textContent = text;
  if (color) el.style.color = color;
  return el;
}

function buildSection(title: string, rows: IndicatorRow[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'help-section';

  const header = document.createElement('div');
  header.className = 'help-section-header';
  header.textContent = title;
  section.appendChild(header);

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'help-row';

    const visualEl = document.createElement('div');
    visualEl.className = 'help-visual';
    visualEl.appendChild(row.visual());

    const labelEl = document.createElement('div');
    labelEl.className = 'help-label';
    labelEl.textContent = row.label;

    const descEl = document.createElement('div');
    descEl.className = 'help-desc';
    descEl.textContent = row.description;

    rowEl.appendChild(visualEl);
    rowEl.appendChild(labelEl);
    rowEl.appendChild(descEl);
    section.appendChild(rowEl);
  }

  return section;
}

function buildShortcutSections(): HTMLElement[] {
  const sections: HTMLElement[] = [];
  const grouped = shortcutManager.getAll();

  for (const [category, shortcuts] of grouped) {
    const rows: IndicatorRow[] = [];
    let gotoHandled = false;

    for (const shortcut of shortcuts) {
      // Collapse goto-session-1..9 into a single "N" row to avoid 9 near-identical entries
      if (shortcut.id.startsWith('goto-session-')) {
        if (!gotoHandled) {
          gotoHandled = true;
          const first = displayKeys(shortcutManager.getKeys('goto-session-1'));
          const last = displayKeys(shortcutManager.getKeys('goto-session-9'));
          rows.push({
            visual: () => mono(`${first} - ${last}`),
            label: 'Go to Session N',
            description: 'Switch to session by number',
          });
        }
        continue;
      }

      rows.push({
        visual: () => mono(displayKeys(shortcut.resolvedKeys)),
        label: shortcut.label,
        description: '',
      });
    }

    sections.push(buildSection(`Shortcuts: ${category}`, rows));
  }

  return sections;
}

export function showHelpDialog(): void {
  cleanupFn?.();
  cleanupFn = null;

  const { overlay, body, actions } = createModalShell({
    id: 'help-overlay',
    title: 'Help',
    wide: true,
  });
  body.innerHTML = '';
  actions.innerHTML = '';

  const confirmBtn = createModalButton('Done', true);
  confirmBtn.id = 'help-confirm';
  actions.appendChild(confirmBtn);

  const container = document.createElement('div');
  container.className = 'help-container';

  container.appendChild(buildSection('Tab Status Dot', [
    { visual: () => dot('#e94560', true), label: 'Working', description: 'Claude is actively generating a response' },
    { visual: () => dot('#f4b400'), label: 'Waiting', description: 'Claude is not actively working' },
    { visual: () => dot('#34a853'), label: 'Completed', description: 'Claude has finished the task' },
    { visual: () => dot('#e67e22', true), label: 'Input', description: 'Claude is waiting for user input' },
    { visual: () => dot('#606070'), label: 'Idle', description: 'Session is inactive (CLI exited)' },
  ]));

  container.appendChild(buildSection('Tab Badges', [
    { visual: () => badge('Session 1', '#e94560'), label: 'Unread', description: 'Background session needs attention' },
  ]));

  container.appendChild(buildSection('Status Bar', [
    { visual: () => mono('$1.23 · 5k in / 2k out'), label: 'Cost details', description: 'Detailed cost with token counts' },
    { visual: () => mono('[====------] 50%'), label: 'Context usage', description: 'How full the context window is' },
    { visual: () => mono('[=======---] 75%', '#f4b400'), label: 'Context warning', description: 'Context usage above 70%' },
    { visual: () => mono('[=========‐] 95%', '#e94560'), label: 'Context critical', description: 'Context usage above 90%' },
  ]));

  container.appendChild(buildSection('Git Status', [
    { visual: () => mono('⎇ main', '#a0a0b0'), label: 'Branch', description: 'Current git branch' },
    { visual: () => mono('+3', '#34a853'), label: 'Staged', description: 'Files staged for commit' },
    { visual: () => mono('~2', '#f4b400'), label: 'Modified', description: 'Modified tracked files' },
    { visual: () => mono('?1', '#606070'), label: 'Untracked', description: 'New untracked files' },
    { visual: () => mono('!1', '#e94560'), label: 'Conflicted', description: 'Files with merge conflicts' },
    { visual: () => mono('↑2 ↓3', '#606070'), label: 'Ahead/Behind', description: 'Commits ahead/behind remote' },
  ]));

  for (const section of buildShortcutSections()) {
    container.appendChild(section);
  }

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
