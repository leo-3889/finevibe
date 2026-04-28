import { appState } from '../state.js';
import { createModalShell, createModalButton } from './modal-shell.js';

interface ReleaseNotes {
  date: string;
  features: string[];
  fixes: string[];
  changes: string[];
}

let cleanupFn: (() => void) | null = null;

export function parseChangelog(markdown: string, version: string): ReleaseNotes | null {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(`^## \\[${escapedVersion}\\]\\s*-\\s*(.+)$`, 'm');
  const match = markdown.match(sectionRegex);
  if (!match) return null;

  const date = match[1].trim();
  const startIndex = match.index! + match[0].length;

  const nextSectionMatch = markdown.slice(startIndex).match(/^## \[/m);
  const sectionText = nextSectionMatch
    ? markdown.slice(startIndex, startIndex + nextSectionMatch.index!)
    : markdown.slice(startIndex);

  const features = extractList(sectionText, 'Features');
  const fixes = extractList(sectionText, 'Fixes');
  const changes = extractList(sectionText, 'Changes');

  if (features.length === 0 && fixes.length === 0 && changes.length === 0) return null;

  return { date, features, fixes, changes };
}

function extractList(section: string, heading: string): string[] {
  const headingRegex = new RegExp(`^### ${heading}$`, 'm');
  const match = section.match(headingRegex);
  if (!match) return [];

  const startIndex = match.index! + match[0].length;
  const nextHeading = section.slice(startIndex).match(/^### /m);
  const block = nextHeading
    ? section.slice(startIndex, startIndex + nextHeading.index!)
    : section.slice(startIndex);

  return block
    .split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(line => line.length > 0);
}

function showWhatsNewDialog(version: string, notes: ReleaseNotes): void {
  cleanupFn?.();
  cleanupFn = null;

  const { overlay, titleEl, body, actions } = createModalShell({
    id: 'whats-new-overlay',
    title: '',
    wide: true,
  });
  titleEl.textContent = `What's New in v${version}`;
  body.innerHTML = '';
  actions.innerHTML = '';

  const confirmBtn = createModalButton('Got it', true);
  actions.appendChild(confirmBtn);

  const container = document.createElement('div');
  container.className = 'whats-new-container';

  const dateEl = document.createElement('div');
  dateEl.className = 'whats-new-date';
  dateEl.textContent = `Released ${notes.date}`;
  container.appendChild(dateEl);

  if (notes.features.length > 0) {
    container.appendChild(buildSection('Features', notes.features));
  }
  if (notes.fixes.length > 0) {
    container.appendChild(buildSection('Fixes', notes.fixes));
  }
  if (notes.changes.length > 0) {
    container.appendChild(buildSection('Changes', notes.changes));
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

function buildSection(title: string, items: string[]): HTMLElement {
  const section = document.createElement('div');
  section.className = 'whats-new-section';

  const header = document.createElement('div');
  header.className = 'whats-new-section-header';
  header.textContent = title;
  section.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'whats-new-list';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  section.appendChild(list);

  return section;
}

export async function checkWhatsNew(): Promise<void> {
  const currentVersion = await window.vibeyard.app.getVersion();
  const lastSeen = appState.lastSeenVersion;

  // Skip on a fresh install — no previous version to compare against, so nothing's "new"
  if (lastSeen && lastSeen !== currentVersion) {
    try {
      const response = await fetch('./CHANGELOG.md');
      if (response.ok) {
        const markdown = await response.text();
        const notes = parseChangelog(markdown, currentVersion);
        if (notes) {
          showWhatsNewDialog(currentVersion, notes);
        }
      }
    } catch {
      // CHANGELOG.md missing in some packaged builds — silently skip
    }
  }

  if (lastSeen !== currentVersion) {
    appState.setLastSeenVersion(currentVersion);
  }
}
