import { appState } from '../state.js';
import { openFileReaderChecked } from '../open-file-reader.js';

let overlay: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let resultsList: HTMLElement | null = null;
let activeIndex = 0;
let results: string[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Request token: only the newest search may paint (see searchFiles).
let latestSearchToken = 0;

function parseQuery(raw: string): { fileQuery: string; lineNumber?: number } {
  const m = /^(.*):(\d+)$/.exec(raw);
  if (m && m[1].length > 0) {
    return { fileQuery: m[1], lineNumber: parseInt(m[2], 10) };
  }
  return { fileQuery: raw };
}

function createOverlay(): void {
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.className = 'quick-open-overlay';
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) hideQuickOpen();
  });

  const container = document.createElement('div');
  container.className = 'quick-open-container';

  input = document.createElement('input');
  input.className = 'quick-open-input';
  input.type = 'text';
  input.placeholder = 'Search files by name...';
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);

  resultsList = document.createElement('div');
  resultsList.className = 'quick-open-results';

  container.appendChild(input);
  container.appendChild(resultsList);
  overlay.appendChild(container);
  document.body.appendChild(overlay);
}

function onInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => searchFiles(), 150);
}

async function searchFiles(): Promise<void> {
  const project = appState.activeProject;
  if (!project || !input) return;

  const { fileQuery } = parseQuery(input.value);
  const token = ++latestSearchToken;
  let files: string[];
  try {
    files = await window.finevibe.fs.listFiles(project.path, fileQuery);
  } catch {
    files = [];
  }
  // A stale listFiles response that lands last must not overwrite the newest
  // query's results — the visible list would be the old files and Enter would
  // open the wrong one.
  if (token !== latestSearchToken) return;
  results = files;
  activeIndex = 0;
  renderResults();
}

function renderResults(): void {
  if (!resultsList) return;
  resultsList.replaceChildren();

  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'quick-open-empty';
    empty.textContent = input?.value ? 'No files found' : 'Type to search files...';
    resultsList.appendChild(empty);
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const item = document.createElement('div');
    item.className = 'quick-open-item';
    if (i === activeIndex) item.classList.add('active');

    const filePath = results[i];
    const parts = filePath.split('/');
    const fileName = parts.pop() || filePath;
    const dir = parts.join('/');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'quick-open-filename';
    nameSpan.textContent = fileName;
    item.appendChild(nameSpan);
    if (dir) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'quick-open-dir';
      dirSpan.textContent = dir;
      item.appendChild(dirSpan);
    }

    item.addEventListener('mouseenter', () => {
      activeIndex = i;
      updateActiveItem();
    });
    item.addEventListener('click', () => {
      activeIndex = i;
      selectFile();
    });

    resultsList.appendChild(item);
  }
}

function updateActiveItem(): void {
  if (!resultsList) return;
  const items = resultsList.querySelectorAll('.quick-open-item');
  items.forEach((el, i) => {
    el.classList.toggle('active', i === activeIndex);
  });
  // Scroll active item into view
  const active = items[activeIndex] as HTMLElement | undefined;
  active?.scrollIntoView({ block: 'nearest' });
}

function onKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      if (results.length > 0) {
        activeIndex = (activeIndex + 1) % results.length;
        updateActiveItem();
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      if (results.length > 0) {
        activeIndex = (activeIndex - 1 + results.length) % results.length;
        updateActiveItem();
      }
      break;
    case 'Enter':
      e.preventDefault();
      selectFile();
      break;
    case 'Escape':
      e.preventDefault();
      hideQuickOpen();
      break;
  }
}

function selectFile(): void {
  if (activeIndex < 0 || activeIndex >= results.length) return;
  const filePath = results[activeIndex];
  const project = appState.activeProject;
  if (!project) return;

  const { lineNumber } = parseQuery(input?.value ?? '');
  void openFileReaderChecked(project.id, filePath, lineNumber);
  hideQuickOpen();
}

export function showQuickOpen(): void {
  const project = appState.activeProject;
  if (!project) return;

  createOverlay();
  if (!overlay || !input) return;

  // Drop any search still in flight from a previous session of the overlay, so
  // its response cannot paint into the freshly opened one.
  latestSearchToken++;
  overlay.style.display = 'flex';
  input.value = '';
  results = [];
  activeIndex = 0;
  renderResults();
  input.focus();

  // Pre-load file list
  searchFiles();
}

function hideQuickOpen(): void {
  if (overlay) {
    overlay.style.display = 'none';
  }
  latestSearchToken++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
