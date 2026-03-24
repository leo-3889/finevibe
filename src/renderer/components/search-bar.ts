import { getSearchAddon, getTerminalInstance } from './terminal-pane.js';

export interface SearchBackend {
  findNext(query: string, options: { caseSensitive: boolean; regex: boolean }): void;
  findPrevious(query: string, options: { caseSensitive: boolean; regex: boolean }): void;
  clearDecorations(): void;
  getContainer(): HTMLElement;
  focus(): void;
}

export class TerminalSearchBackend implements SearchBackend {
  constructor(private sessionId: string) {}

  findNext(query: string, options: { caseSensitive: boolean; regex: boolean }): void {
    const addon = getSearchAddon(this.sessionId);
    if (addon) addon.findNext(query, options);
  }

  findPrevious(query: string, options: { caseSensitive: boolean; regex: boolean }): void {
    const addon = getSearchAddon(this.sessionId);
    if (addon) addon.findPrevious(query, options);
  }

  clearDecorations(): void {
    const addon = getSearchAddon(this.sessionId);
    if (addon) addon.clearDecorations();
  }

  getContainer(): HTMLElement {
    const instance = getTerminalInstance(this.sessionId);
    return instance!.element;
  }

  focus(): void {
    const instance = getTerminalInstance(this.sessionId);
    if (instance) instance.terminal.focus();
  }
}

const searchBars = new Map<string, { bar: HTMLDivElement; backend: SearchBackend }>();

export function showSearchBar(sessionId: string, backend: SearchBackend): void {
  const existing = searchBars.get(sessionId);
  if (existing) {
    existing.backend = backend;
    existing.bar.classList.remove('hidden');
    const input = existing.bar.querySelector('input') as HTMLInputElement;
    input.focus();
    input.select();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'search-bar';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search...';
  input.spellcheck = false;

  const matchCaseBtn = document.createElement('button');
  matchCaseBtn.className = 'search-toggle-btn';
  matchCaseBtn.textContent = 'Aa';
  matchCaseBtn.title = 'Match Case';

  const regexBtn = document.createElement('button');
  regexBtn.className = 'search-toggle-btn';
  regexBtn.textContent = '.*';
  regexBtn.title = 'Use Regular Expression';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'search-nav-btn';
  prevBtn.textContent = '\u2191';
  prevBtn.title = 'Previous Match (Shift+Enter)';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'search-nav-btn';
  nextBtn.textContent = '\u2193';
  nextBtn.title = 'Next Match (Enter)';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-nav-btn search-close-btn';
  closeBtn.textContent = '\u2715';
  closeBtn.title = 'Close (Escape)';

  bar.appendChild(input);
  bar.appendChild(matchCaseBtn);
  bar.appendChild(regexBtn);
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(closeBtn);

  backend.getContainer().appendChild(bar);
  searchBars.set(sessionId, { bar, backend });

  let caseSensitive = false;
  let regex = false;

  function getOptions() {
    return { caseSensitive, regex };
  }

  function doSearch() {
    if (!input.value) {
      backend.clearDecorations();
      return;
    }
    backend.findNext(input.value, getOptions());
  }

  input.addEventListener('input', doSearch);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!input.value) return;
      if (e.shiftKey) {
        backend.findPrevious(input.value, getOptions());
      } else {
        backend.findNext(input.value, getOptions());
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSearchBar(sessionId);
    }
    // Prevent Cmd+F from bubbling when search bar is focused
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      input.select();
    }
  });

  matchCaseBtn.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    matchCaseBtn.classList.toggle('active', caseSensitive);
    doSearch();
  });

  regexBtn.addEventListener('click', () => {
    regex = !regex;
    regexBtn.classList.toggle('active', regex);
    doSearch();
  });

  prevBtn.addEventListener('click', () => {
    if (input.value) backend.findPrevious(input.value, getOptions());
  });

  nextBtn.addEventListener('click', () => {
    if (input.value) backend.findNext(input.value, getOptions());
  });

  closeBtn.addEventListener('click', () => hideSearchBar(sessionId));

  input.focus();
}

export function hideSearchBar(sessionId: string): void {
  const entry = searchBars.get(sessionId);
  if (!entry) return;
  entry.bar.classList.add('hidden');
  entry.backend.clearDecorations();
  entry.backend.focus();
}

export function destroySearchBar(sessionId: string): void {
  const entry = searchBars.get(sessionId);
  if (!entry) return;
  entry.backend.clearDecorations();
  entry.bar.remove();
  searchBars.delete(sessionId);
}

export function isSearchBarVisible(sessionId: string): boolean {
  const entry = searchBars.get(sessionId);
  return !!entry && !entry.bar.classList.contains('hidden');
}
