import { Terminal } from '@xterm/xterm';
import { getTerminalTheme } from '../terminal-theme.js';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { appState } from '../state.js';
import { TERMINAL_SCROLLBACK } from './terminal-shared.js';
import { fitAllVisible } from './terminal-pane.js';
import { destroySearchBar, hideSearchBar } from './search-bar.js';
import { shortcutManager, displayKeys } from '../shortcuts.js';
import { attachClipboardCopyHandler, attachCopyOnSelect, attachFileDropHandler, attachImagePasteHandler, collapseArmedTextareaOnContextMenu, loadWebglWithFallback } from './terminal-utils.js';
import { attachWin32TerminalKeys, unlatchWin32Key } from './win32-terminal-keys.js';
import { isWin } from '../platform.js';
import { esc } from '../dom-utils.js';

interface ShellTerminalInstance {
  id: string;
  label: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  element: HTMLDivElement;
  projectId: string;
  sessionId: string;
  spawned: boolean;
  lastSize: string;
}

const shells = new Map<string, ShellTerminalInstance[]>();
const activeShellByProject = new Map<string, string>();

let panelEl: HTMLElement;
let containerEl: HTMLElement;
let sidebarEl: HTMLElement;
let resizeHandleEl: HTMLElement;
let currentProjectId: string | null = null;
let resizeObserver: ResizeObserver | null = null;

function findShellBySessionId(sessionId: string): ShellTerminalInstance | undefined {
  for (const list of shells.values()) {
    for (const instance of list) {
      if (instance.sessionId === sessionId) return instance;
    }
  }
  return undefined;
}

function getShellsFor(projectId: string): ShellTerminalInstance[] {
  let list = shells.get(projectId);
  if (!list) {
    list = [];
    shells.set(projectId, list);
  }
  return list;
}

function nextLabel(projectId: string): string {
  const list = getShellsFor(projectId);
  const used = new Set<number>();
  for (const s of list) {
    const m = /^Terminal (\d+)$/.exec(s.label);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Terminal ${n}`;
}

function createShell(projectId: string): ShellTerminalInstance {
  const element = document.createElement('div');
  element.className = 'shell-terminal';
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.position = 'relative';

  const terminal = new Terminal({
    theme: getTerminalTheme(appState.preferences.theme ?? 'dark'),
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
    scrollback: TERMINAL_SCROLLBACK,
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const shellId = crypto.randomUUID();
  const sessionId = `shell-${projectId}-${shellId}`;

  const writeToPty = (data: string) => window.finevibe.pty.write(sessionId, data);
  // Same contract as session terminals: the shell's ConPTY advertised mode
  // 9001 at spawn, so a Windows shell pane starts latched and Escape is
  // never written as a bare ESC to the armed PTY.
  const handleWin32Key = attachWin32TerminalKeys(terminal, writeToPty, { latchKey: sessionId, latched: isWin });
  attachClipboardCopyHandler(terminal, handleWin32Key);
  attachImagePasteHandler(terminal, element, writeToPty);

  const instance: ShellTerminalInstance = {
    id: shellId,
    label: nextLabel(projectId),
    terminal,
    fitAddon,
    searchAddon,
    element,
    projectId,
    sessionId,
    spawned: false,
    lastSize: '',
  };

  // Dropping a file types its path into the shell, the same contract the session
  // terminals use. A spawn is required: `spawned` goes false again when the shell
  // exits, so a dead shell stops accepting drops with its overlay up.
  attachFileDropHandler(terminal, element, writeToPty, () => instance.spawned);

  terminal.onData((data) => {
    window.finevibe.pty.write(sessionId, data);
  });

  getShellsFor(projectId).push(instance);
  return instance;
}

async function spawnShell(instance: ShellTerminalInstance, projectPath: string): Promise<void> {
  if (instance.spawned) return;
  instance.spawned = true;

  const overlay = instance.element.querySelector('.terminal-exit-overlay');
  if (overlay) overlay.remove();

  try {
    await window.finevibe.pty.createShell(instance.sessionId, projectPath);
    // A fresh PTY starts at the spawn default; force the next fit to
    // re-send the pane's current geometry.
    instance.lastSize = '';
  } catch (err) {
    // `activateShellInstance` fires this un-awaited. A rejected `createShell`
    // (missing shell binary, ConPTY failure) used to surface as an unhandled
    // rejection: the tab stayed blank, and `spawned === true` blocked every
    // later retry. Mirror the session pane's failure overlay.
    instance.spawned = false;
    appendExitOverlay(
      instance,
      `Failed to start shell: ${err instanceof Error ? err.message : String(err)}`,
      'Retry',
      () => spawnShell(instance, projectPath),
    );
  }
}

/**
 * The pane overlay carrying a message and one action (exit notice, spawn
 * failure). Built with DOM APIs, never innerHTML: the message includes
 * exception text, which must not be parsed as markup.
 */
function appendExitOverlay(
  instance: ShellTerminalInstance,
  message: string,
  buttonLabel: string,
  onRestart: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'terminal-exit-overlay';
  const box = document.createElement('div');
  box.className = 'terminal-exit-message';
  const line = document.createElement('div');
  line.textContent = message;
  const button = document.createElement('button');
  button.className = 'respawn-btn';
  button.textContent = buttonLabel;
  button.addEventListener('click', () => {
    overlay.remove();
    onRestart();
  });
  box.appendChild(line);
  box.appendChild(button);
  overlay.appendChild(box);
  instance.element.appendChild(overlay);
}

function activateShellInstance(instance: ShellTerminalInstance): void {
  for (const list of shells.values()) {
    for (const other of list) {
      if (other !== instance) {
        other.element.style.display = 'none';
      }
    }
  }

  if (!containerEl.contains(instance.element)) {
    containerEl.appendChild(instance.element);
    instance.terminal.open(instance.element);
    attachCopyOnSelect(instance.terminal);
    collapseArmedTextareaOnContextMenu(instance.terminal);
    loadWebglWithFallback(instance.terminal);
  }
  instance.element.style.display = '';

  activeShellByProject.set(instance.projectId, instance.id);

  if (!instance.spawned) {
    const project = appState.projects.find(p => p.id === instance.projectId);
    if (project) spawnShell(instance, project.path);
  }
}

function activateAndRefresh(instance: ShellTerminalInstance): void {
  activateShellInstance(instance);
  renderSidebar(instance.projectId);
  requestAnimationFrame(() => {
    fitActiveShell();
    instance.terminal.focus();
  });
}

function showPanel(projectId: string): void {
  const project = appState.projects.find(p => p.id === projectId);
  if (!project) return;

  const list = getShellsFor(projectId);
  if (list.length === 0) {
    createShell(projectId);
  }

  const activeId = activeShellByProject.get(projectId);
  const instance = list.find(s => s.id === activeId) ?? getShellsFor(projectId)[0];

  activateShellInstance(instance);

  panelEl.classList.remove('hidden');
  resizeHandleEl.classList.remove('hidden');

  const height = project.terminalPanelHeight ?? 200;
  panelEl.style.height = `${height}px`;

  currentProjectId = projectId;

  renderSidebar(projectId);

  requestAnimationFrame(() => {
    fitActiveShell();
    fitAllVisible();
    instance.terminal.focus();
  });
}

function hidePanel(): void {
  if (currentProjectId) {
    const instance = getActiveShell(currentProjectId);
    if (instance) hideSearchBar(instance.sessionId);
  }
  panelEl.classList.add('hidden');
  resizeHandleEl.classList.add('hidden');
  requestAnimationFrame(() => fitAllVisible());
}

function getActiveShell(projectId: string): ShellTerminalInstance | undefined {
  const list = shells.get(projectId);
  if (!list || list.length === 0) return undefined;
  const activeId = activeShellByProject.get(projectId);
  return list.find(s => s.id === activeId) ?? list[0];
}

function setActiveShell(projectId: string, shellId: string): void {
  if (activeShellByProject.get(projectId) === shellId) return;
  const list = shells.get(projectId);
  if (!list) return;
  const instance = list.find(s => s.id === shellId);
  if (!instance) return;
  activateAndRefresh(instance);
}

function closeShell(projectId: string, shellId: string): void {
  const list = shells.get(projectId);
  if (!list) return;
  const idx = list.findIndex(s => s.id === shellId);
  if (idx < 0) return;
  const instance = list[idx];

  destroySearchBar(instance.sessionId);
  window.finevibe.pty.kill(instance.sessionId);
  instance.terminal.dispose();
  // C2R-13: the PTY dies here, so its mode-9001 latch entry dies with it.
  unlatchWin32Key(instance.sessionId);
  instance.element.remove();
  list.splice(idx, 1);

  const wasActive = activeShellByProject.get(projectId) === shellId;

  if (list.length === 0) {
    shells.delete(projectId);
    activeShellByProject.delete(projectId);
    hidePanel();
    appState.setTerminalPanelOpen(false);
    return;
  }

  if (wasActive) {
    const next = list[idx] ?? list[idx - 1] ?? list[0];
    activateShellInstance(next);
  }

  renderSidebar(projectId);
  requestAnimationFrame(() => fitActiveShell());
}

function renderSidebar(projectId: string): void {
  const list = shells.get(projectId) ?? [];
  if (list.length <= 1) {
    sidebarEl.classList.add('hidden');
    sidebarEl.innerHTML = '';
    return;
  }
  sidebarEl.classList.remove('hidden');
  const activeId = activeShellByProject.get(projectId);
  // pi-lens-ignore: no-html-label-for, slop, xss-innerhtml, no-inner-html, xss-risk
  sidebarEl.innerHTML = list.map(s => `
    <div class="terminal-list-item${s.id === activeId ? ' active' : ''}" data-shell-id="${esc(s.id)}">
      <span class="terminal-list-item-name">${esc(s.label)}</span>
      <span class="terminal-list-item-close" title="Close Terminal">&times;</span>
    </div>
  `).join('');

  for (const el of sidebarEl.querySelectorAll<HTMLElement>('.terminal-list-item')) {
    const shellId = el.dataset.shellId!;
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('terminal-list-item-close')) return;
      setActiveShell(projectId, shellId);
    });
    const closeEl = el.querySelector('.terminal-list-item-close');
    if (closeEl) {
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        closeShell(projectId, shellId);
      });
    }
  }
}

function fitActiveShell(): void {
  if (!currentProjectId) return;
  const instance = getActiveShell(currentProjectId);
  if (!instance || panelEl.classList.contains('hidden')) return;
  try {
    instance.fitAddon.fit();
    const { cols, rows } = instance.terminal;
    // Mirrors fitTerminal()'s memo: renderLayout() ends in a fitAllVisible(),
    // and a redundant resize makes the CLI redraw underneath an in-progress
    // selection — only a changed geometry goes over the wire.
    const size = `${cols}x${rows}`;
    if (size === instance.lastSize) return;
    instance.lastSize = size;
    // pty.resize is typed void, but the bridge hands back the
    // ipcRenderer.invoke promise; a rejected resize would otherwise surface
    // as an unhandled rejection.
    Promise.resolve(window.finevibe.pty.resize(instance.sessionId, cols, rows)).catch(() => {});
  } catch {
    // not visible yet
  }
}

export function toggleProjectTerminal(): void {
  const project = appState.activeProject;
  if (!project) return;

  const isOpen = !panelEl.classList.contains('hidden') && currentProjectId === project.id;
  if (isOpen) {
    hidePanel();
    appState.setTerminalPanelOpen(false);
  } else {
    showPanel(project.id);
    appState.setTerminalPanelOpen(true);
  }
}

export function handleShellPtyData(sessionId: string, data: string): void {
  const instance = findShellBySessionId(sessionId);
  if (instance) instance.terminal.write(data);
}

export function handleShellPtyExit(sessionId: string, exitCode: number): void {
  const instance = findShellBySessionId(sessionId);
  if (!instance) return;
  instance.spawned = false;

  appendExitOverlay(instance, `Shell exited (code: ${exitCode})`, 'Restart', () => {
    const project = appState.projects.find(p => p.id === instance.projectId);
    if (project) {
      spawnShell(instance, project.path);
    }
  });
}

function isShellSessionId(sessionId: string): boolean {
  return sessionId.startsWith('shell-');
}

function destroyAllShells(projectId: string): void {
  const list = shells.get(projectId);
  if (!list) return;
  for (const instance of list) {
    destroySearchBar(instance.sessionId);
    window.finevibe.pty.kill(instance.sessionId);
    instance.terminal.dispose();
    // C2R-13: see closeShell — every killed PTY releases its latch entry.
    unlatchWin32Key(instance.sessionId);
    instance.element.remove();
  }
  shells.delete(projectId);
  activeShellByProject.delete(projectId);
}

// C5R-05: every shell pins a PTY + ConPTY + xterm pane and '+ New Terminal'
// was uncapped, so a key-mash runaway grew them without bound. Exited shells
// count too: their pane, exit overlay and sidebar label all stay alive.
const MAX_SHELLS_PER_PROJECT = 50;
let newTerminalBtn: HTMLElement | null = null;
let shellLimitNoteTimer: ReturnType<typeof setTimeout> | 0 = 0;

// The file's only chrome-level feedback channel is the button label/title
// (the exit overlay is pane-scoped): swap the '+' to the live count and the
// title to the note, restore after a beat. Re-entrant clicks reuse one timer.
function showShellLimitNote(projectId: string): void {
  if (!newTerminalBtn) return;
  const count = getShellsFor(projectId).length;
  clearTimeout(shellLimitNoteTimer);
  newTerminalBtn.textContent = String(count);
  newTerminalBtn.title = `Terminal limit reached (${MAX_SHELLS_PER_PROJECT} per project)`;
  shellLimitNoteTimer = setTimeout(() => {
    if (!newTerminalBtn) return;
    newTerminalBtn.textContent = '+';
    newTerminalBtn.title = 'New Terminal';
  }, 1500);
}

export function initProjectTerminal(): void {
  panelEl = document.getElementById('project-terminal-panel')!;
  containerEl = document.getElementById('project-terminal-container')!;
  sidebarEl = document.getElementById('project-terminal-sidebar')!;
  resizeHandleEl = document.getElementById('project-terminal-resize-handle')!;
  const closeBtn = document.getElementById('btn-close-terminal')!;
  const newBtn = document.getElementById('btn-new-terminal')!;
  newTerminalBtn = newBtn;
  const toggleBtn = document.getElementById('btn-toggle-terminal')!;

  closeBtn.addEventListener('click', () => {
    hidePanel();
    appState.setTerminalPanelOpen(false);
  });

  newBtn.addEventListener('click', () => {
    const project = appState.activeProject;
    if (!project) return;
    // C5R-05: count live + exited shells — exited panes keep their PTY
    // bookkeeping, overlay and sidebar label until closed.
    if (getShellsFor(project.id).length >= MAX_SHELLS_PER_PROJECT) {
      showShellLimitNote(project.id);
      return;
    }
    activateAndRefresh(createShell(project.id));
  });

  const primaryKey = displayKeys(shortcutManager.getKeys('project-terminal-alt'));
  toggleBtn.title = `Toggle Terminal (${primaryKey})`;

  toggleBtn.addEventListener('click', () => toggleProjectTerminal());

  // Resize handle drag
  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  // S3-01: pointer events with implicit capture on the handle. The old
  // document mousemove/mouseup pair was removed only inside onMouseUp —
  // releasing the button outside the window (the normal way to overshoot
  // a panel drag) never delivers mouseup to the renderer: dragging
  // stayed true, the pair leaked for the renderer's life (every mouse
  // move app-wide then ran a full fit sweep at mousemove rate), the body
  // cursor/userSelect lock stayed applied, and every later mousedown
  // stacked another pair. pointerup/pointercancel on a captured pointer
  // are ALWAYS delivered, wherever the button is released.
  resizeHandleEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = panelEl.offsetHeight;
    resizeHandleEl.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    resizeHandleEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  // C2R-18: the height write stays synchronous (the drag must follow the
  // pointer), the fits do not. fitActiveShell()+fitAllVisible() ran at
  // pointermove rate: a forced layout plus an xterm reflow of every visible
  // pane per move, on top of the ResizeObserver's own callback. One scheduled
  // frame per burst (split-layout's resize idiom); endDrag fits the settled
  // height and cancels a frame that has not run yet.
  let fitFrame = 0;
  const scheduleFits = (): void => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      fitActiveShell();
      fitAllVisible();
    });
  };

  resizeHandleEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const delta = startY - ev.clientY;
    const newHeight = Math.max(80, Math.min(startHeight + delta, window.innerHeight - 150));
    panelEl.style.height = `${newHeight}px`;
    scheduleFits();
  });

  const endDrag = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    try {
      resizeHandleEl.releasePointerCapture(ev.pointerId);
    } catch {
      // Capture was already gone (pointercancel after window loss).
    }
    resizeHandleEl.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (fitFrame) {
      cancelAnimationFrame(fitFrame);
      fitFrame = 0;
    }
    const height = panelEl.offsetHeight;
    appState.setTerminalPanelHeight(height);
    fitActiveShell();
    fitAllVisible();
  };
  resizeHandleEl.addEventListener('pointerup', endDrag);
  resizeHandleEl.addEventListener('pointercancel', endDrag);

  // React to project changes
  appState.on('project-changed', () => {
    const project = appState.activeProject;
    if (!project) {
      hidePanel();
      currentProjectId = null;
      return;
    }

    if (project.terminalPanelOpen) {
      showPanel(project.id);
    } else {
      hidePanel();
      currentProjectId = project.id;
    }
  });

  // On state load, restore panel for active project
  appState.on('state-loaded', () => {
    const project = appState.activeProject;
    if (project?.terminalPanelOpen) {
      showPanel(project.id);
    }
  });

  // Clean up when project is removed
  appState.on('project-removed', (data) => {
    const projectId = data as string;
    destroyAllShells(projectId);
    if (currentProjectId === projectId) {
      hidePanel();
      currentProjectId = null;
    }
  });

  // Resize terminal when window resizes
  resizeObserver = new ResizeObserver(() => {
    if (currentProjectId && !panelEl.classList.contains('hidden')) {
      fitActiveShell();
    }
  });
  resizeObserver.observe(containerEl);
}

export function getShellTerminalInstance(sessionId: string): ShellTerminalInstance | undefined {
  return findShellBySessionId(sessionId);
}

export function getActiveShellSessionId(): string | null {
  if (!currentProjectId || panelEl.classList.contains('hidden')) return null;
  const instance = getActiveShell(currentProjectId);
  return instance?.sessionId ?? null;
}

export { isShellSessionId };

export function applyThemeToAllShells(theme: 'dark' | 'light'): void {
  const termTheme = getTerminalTheme(theme);
  for (const list of shells.values()) {
    for (const instance of list) {
      instance.terminal.options.theme = termTheme;
    }
  }
}
