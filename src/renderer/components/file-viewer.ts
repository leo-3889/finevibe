import { appState } from '../state.js';
import { areaLabel } from '../dom-utils.js';
import { closeSessionIfFileMissing } from '../session-close.js';
import { destroySearchBar } from './search-bar.js';
import { isAbsolutePath, dirname, samePath } from '../../shared/platform.js';

interface FileViewerInstance {
  element: HTMLElement;
  filePath: string;
  area: string;
  worktreePath?: string;
  resolvedPath: string | null;
  loaded: boolean;
  // Per-instance so concurrent pane loads don't discard each other; a
  // superseded reload of the SAME pane is still dropped.
  loadGeneration: number;
}

const instances = new Map<string, FileViewerInstance>();
let unwatchFileChanged: (() => void) | null = null;
const pendingReloads = new Set<string>();
let removeSelectionListener: (() => void) | null = null;

function isSelectionInsideFileViewer(sessionId: string): boolean {
  const instance = instances.get(sessionId);
  if (!instance) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const body = instance.element.querySelector('.file-viewer-body');
  if (!body) return false;
  const range = sel.getRangeAt(0);
  return body.contains(range.startContainer);
}

function flushPendingReloads(): void {
  const ids = [...pendingReloads];
  pendingReloads.clear();
  for (const id of ids) {
    const inst = instances.get(id);
    if (inst) {
      inst.loaded = false;
      loadDiffGuarded(inst, id);
    }
  }
  // Remove listener when no longer needed
  if (removeSelectionListener) {
    removeSelectionListener();
    removeSelectionListener = null;
  }
}

function onSelectionChange(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    if (pendingReloads.size > 0) flushPendingReloads();
  }
}

function ensureSelectionListener(): void {
  if (removeSelectionListener) return;
  document.addEventListener('selectionchange', onSelectionChange);
  removeSelectionListener = () => document.removeEventListener('selectionchange', onSelectionChange);
}

function parseDiffLines(diff: string): HTMLElement {
  const content = document.createElement('div');
  content.className = 'file-viewer-content';

  // CRLF: the split is LF-only; a CRLF file leaves '\r' at every line end
  // and under white-space:pre the paragraph break renders that tail as a
  // second, visibly empty line — the diff reads double-height. Normalize
  // CRLF/CR to LF first; pure-LF diffs are unchanged.
  const normalized = diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const line of normalized.split('\n')) {
    const div = document.createElement('div');
    div.className = 'diff-line';

    if (line.startsWith('@@')) {
      div.classList.add('hunk');
    } else if (line.startsWith('+')) {
      div.classList.add('added');
    } else if (line.startsWith('-')) {
      div.classList.add('removed');
    } else {
      div.classList.add('context');
    }

    div.textContent = line.length > 0 ? line : '\u00a0';
    content.appendChild(div);
  }

  return content;
}

function resolveFilePath(instance: FileViewerInstance): string {
  const project = appState.activeProject;
  const basePath = instance.worktreePath ?? project?.path ?? '';
  return isAbsolutePath(instance.filePath)
    ? instance.filePath
    : `${basePath}/${instance.filePath}`;
}

async function loadDiff(instance: FileViewerInstance, sessionId: string): Promise<void> {
  if (instance.loaded) return;

  const project = appState.activeProject;
  if (!project) return;

  if (instance.area === 'untracked') {
    if (await closeSessionIfFileMissing(sessionId, resolveFilePath(instance))) return;
  }

  const body = instance.element.querySelector('.file-viewer-body')!;
  const isFirstLoad = !body.hasChildNodes();

  if (isFirstLoad) {
    const loading = document.createElement('div');
    loading.className = 'file-viewer-content';
    loading.innerHTML = '<div class="diff-line context">Loading diff...</div>';
    body.appendChild(loading);
  }

  const gen = ++instance.loadGeneration;

  try {
    const diff = await window.finevibe.git.getDiff(instance.worktreePath ?? project.path, instance.filePath, instance.area);
    if (gen !== instance.loadGeneration) return; // superseded by a newer load
    body.replaceChildren();
    body.appendChild(parseDiffLines(diff));
    instance.loaded = true;
  } catch {
    if (gen !== instance.loadGeneration) return;
    showDiffFailure(instance);
  }
}

/** The pane's failure state — one context row. Used by `loadDiff`'s catch
 *  and by the guarded fire-and-forget entry points below. */
function showDiffFailure(instance: FileViewerInstance): void {
  const body = instance.element.querySelector('.file-viewer-body');
  if (!body) return;
  body.replaceChildren();
  const content = document.createElement('div');
  content.className = 'file-viewer-content';
  const row = document.createElement('div');
  row.className = 'diff-line context';
  row.textContent = 'Failed to load diff';
  content.appendChild(row);
  body.appendChild(content);
}

/** Fire-and-forget entry: `loadDiff`'s own try/catch covers the diff IPC, but
 *  the untracked-file `fs.exists` check rejects outside it — surface that with
 *  the same failure state instead of dropping an unhandled rejection. */
function loadDiffGuarded(instance: FileViewerInstance, sessionId: string): void {
  loadDiff(instance, sessionId).catch(() => showDiffFailure(instance));
}

function ensureFileChangedListener(): void {
  if (unwatchFileChanged) return;
  unwatchFileChanged = window.finevibe.fs.onFsChange((changes) => {
    for (const change of changes) {
      for (const [sessionId, instance] of instances) {
        if (instance.resolvedPath && samePath(instance.resolvedPath, change.path) && instance.loaded) {
          reloadFileViewer(sessionId);
        }
      }
    }
  });
}

export function createFileViewerPane(sessionId: string, filePath: string, area: string, worktreePath?: string): void {
  if (instances.has(sessionId)) return;

  const el = document.createElement('div');
  el.className = 'file-viewer-pane';
  el.dataset.sessionId = sessionId;
  el.dataset.paneKind = 'file-viewer';
  el.style.display = 'none';

  // Header
  const header = document.createElement('div');
  header.className = 'file-viewer-header';

  const pathSpan = document.createElement('span');
  pathSpan.className = 'file-viewer-path';
  pathSpan.textContent = filePath;

  const areaBadge = document.createElement('span');
  areaBadge.className = `file-viewer-area-badge ${area}`;
  areaBadge.textContent = areaLabel(area);

  header.appendChild(pathSpan);
  header.appendChild(areaBadge);
  el.appendChild(header);

  // Scrollable body
  const body = document.createElement('div');
  body.className = 'file-viewer-body';
  el.appendChild(body);

  const instance: FileViewerInstance = { element: el, filePath, area, worktreePath, resolvedPath: null, loaded: false, loadGeneration: 0 };
  instances.set(sessionId, instance);
}

export function destroyFileViewerPane(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.resolvedPath) {
    window.finevibe.fs.unwatchDir(dirname(instance.resolvedPath));
  }
  pendingReloads.delete(sessionId);
  if (pendingReloads.size === 0 && removeSelectionListener) {
    removeSelectionListener();
    removeSelectionListener = null;
  }
  destroySearchBar(sessionId);
  instance.element.remove();
  instances.delete(sessionId);
}

export function showFileViewerPane(sessionId: string, isSplit: boolean): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  instance.element.style.display = 'flex';
  if (isSplit) instance.element.classList.add('split');
  else instance.element.classList.remove('split');

  // Watch the parent directory (not the file inode) so atomic save/replace is
  // still caught — a direct file watch dies when the inode is swapped.
  if (!instance.resolvedPath) {
    const fullPath = resolveFilePath(instance);
    instance.resolvedPath = fullPath;
    ensureFileChangedListener();
    window.finevibe.fs.watchDir(dirname(fullPath));
  }

  loadDiffGuarded(instance, sessionId);
}

export function hideAllFileViewerPanes(): void {
  for (const instance of instances.values()) {
    instance.element.style.display = 'none';
  }
}

export function attachFileViewerToContainer(sessionId: string, container: HTMLElement): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (instance.element.parentElement !== container) {
    container.appendChild(instance.element);
  }
}

export function getFileViewerInstance(sessionId: string): FileViewerInstance | undefined {
  return instances.get(sessionId);
}

/** Called from git-panel when a file row is clicked */
export function showFileViewer(filePath: string, area: string, worktreePath?: string): void {
  const project = appState.activeProject;
  if (!project) return;
  appState.addDiffViewerSession(project.id, filePath, area, worktreePath);
}

/** Reload the diff content for a given session (e.g. after git changes) */
function reloadFileViewer(sessionId: string): void {
  const instance = instances.get(sessionId);
  if (!instance) return;
  if (isSelectionInsideFileViewer(sessionId)) {
    pendingReloads.add(sessionId);
    ensureSelectionListener();
    return;
  }
  instance.loaded = false;
  loadDiffGuarded(instance, sessionId);
}
