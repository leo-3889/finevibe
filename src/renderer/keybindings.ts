import { appState } from './state.js';
import { closeSessionWithConfirm } from './session-close.js';
import { promptNewProject, toggleSidebar, toggleGitPanel } from './components/sidebar.js';
import { quickNewSession } from './components/tab-bar/session-menu.js';
import { toggleProjectTerminal } from './components/project-terminal.js';
import { toggleDebugPanel } from './components/debug-panel.js';
import { showPreferencesModal } from './components/preferences-modal.js';
import { getFocusedSessionId } from './components/terminal-pane.js';
import { showSearchBar, TerminalSearchBackend, ShellTerminalSearchBackend } from './components/search-bar.js';
import { getActiveShellSessionId } from './components/project-terminal.js';
import { showQuickOpen } from './components/quick-open.js';
import { showSessionSearchPalette } from './components/session-search-palette.js';
import { shortcutManager } from './shortcuts.js';
import { getFileReaderInstance, getFileReaderTextSelector, showGoToLineBar } from './components/file-reader.js';
import { getFileViewerInstance } from './components/file-viewer.js';
import { DomSearchBackend } from './components/dom-search-backend.js';
import { toggleInspector } from './components/session-inspector.js';
import { zoomIn, zoomOut, zoomReset } from './zoom.js';
import { getBrowserTabInstance } from './components/browser-tab/instance.js';

/**
 * Wrap a fire-and-forget action: it unconditionally performs its command,
 * so the key is consumed. Handlers with context guards report their own
 * verdict; a false verdict leaves the key to the focused widget (see
 * ShortcutDef.handler).
 */
const acts = (fn: () => void): (() => boolean) => () => { fn(); return true; };

export function initKeybindings(): void {
  const handleCloseSession = (): boolean => {
    const project = appState.activeProject;
    const session = appState.activeSession;
    if (!project || !session) return false;
    closeSessionWithConfirm(project.id, session.id);
    return true;
  };

  // Menu IPC listeners — handle clicks on Electron menu items.
  // Accelerators are display-only (registerAccelerator: false), so these
  // only fire on actual menu clicks, not keyboard shortcuts.
  window.vibeyard.menu.onNewProject(promptNewProject);
  window.vibeyard.menu.onNewSession(quickNewSession);
  window.vibeyard.menu.onToggleSplit(() => appState.toggleSwarm());
  window.vibeyard.menu.onNextSession(() => appState.cycleSession(1));
  window.vibeyard.menu.onPrevSession(() => appState.cycleSession(-1));
  window.vibeyard.menu.onGotoSession((index) => appState.gotoSession(index));
  window.vibeyard.menu.onToggleDebug(toggleDebugPanel);
  window.vibeyard.menu.onToggleInspector(toggleInspector);
  window.vibeyard.menu.onCloseSession(handleCloseSession);

  // Register shortcut handlers — the single authority for keyboard shortcuts.
  shortcutManager.registerHandler('new-session', acts(quickNewSession));
  shortcutManager.registerHandler('new-session-alt', acts(quickNewSession));
  shortcutManager.registerHandler('new-project', acts(promptNewProject));
  for (let i = 1; i <= 9; i++) {
    shortcutManager.registerHandler(`goto-session-${i}`, acts(() => appState.gotoSession(i - 1)));
  }
  shortcutManager.registerHandler('next-session', acts(() => appState.cycleSession(1)));
  shortcutManager.registerHandler('prev-session', acts(() => appState.cycleSession(-1)));
  shortcutManager.registerHandler('tab-back', acts(() => appState.navigateBack()));
  shortcutManager.registerHandler('tab-forward', acts(() => appState.navigateForward()));
  shortcutManager.registerHandler('toggle-sidebar', acts(toggleSidebar));
  shortcutManager.registerHandler('toggle-split', acts(() => appState.toggleSwarm()));
  shortcutManager.registerHandler('project-terminal', acts(toggleProjectTerminal));
  shortcutManager.registerHandler('project-terminal-alt', acts(toggleProjectTerminal));
  shortcutManager.registerHandler('debug-panel', acts(toggleDebugPanel));
  shortcutManager.registerHandler('git-panel', acts(toggleGitPanel));
  shortcutManager.registerHandler('quick-open', acts(showQuickOpen));
  shortcutManager.registerHandler('session-search', acts(showSessionSearchPalette));
  shortcutManager.registerHandler('find-in-terminal', () => {
    const shellPanel = document.getElementById('project-terminal-panel');
    if (shellPanel && !shellPanel.classList.contains('hidden') &&
        shellPanel.contains(document.activeElement)) {
      const shellSessionId = getActiveShellSessionId();
      if (shellSessionId) {
        showSearchBar(shellSessionId, ShellTerminalSearchBackend(shellSessionId));
        return true;
      }
    }

    const session = appState.activeSession;
    if (!session) return false;

    if (session.type === 'file-reader') {
      const instance = getFileReaderInstance(session.id);
      if (!instance) return false;
      const body = instance.element.querySelector('.file-reader-body') as HTMLElement;
      if (!body) return false;
      showSearchBar(session.id, new DomSearchBackend(body, getFileReaderTextSelector(session.id)));
      return true;
    } else if (session.type === 'diff-viewer') {
      const instance = getFileViewerInstance(session.id);
      if (!instance) return false;
      const body = instance.element.querySelector('.file-viewer-body') as HTMLElement;
      if (!body) return false;
      showSearchBar(session.id, new DomSearchBackend(body, '.diff-line'));
      return true;
    } else {
      const sessionId = getFocusedSessionId();
      if (!sessionId) return false;
      showSearchBar(sessionId, TerminalSearchBackend(sessionId));
      return true;
    }
  });
  shortcutManager.registerHandler('goto-line', () => {
    const session = appState.activeSession;
    if (session?.type !== 'file-reader') return false;
    showGoToLineBar(session.id);
    return true;
  });
  shortcutManager.registerHandler('help', acts(() => showPreferencesModal('help')));
  shortcutManager.registerHandler('close-session', handleCloseSession);
  shortcutManager.registerHandler('toggle-inspector', acts(toggleInspector));
  shortcutManager.registerHandler('zoom-in', acts(zoomIn));
  shortcutManager.registerHandler('zoom-out', acts(zoomOut));
  shortcutManager.registerHandler('zoom-reset', acts(zoomReset));
  shortcutManager.registerHandler('browser-reload', () => {
    const session = appState.activeSession;
    // Outside a browser tab Ctrl+R must reach the terminal PTY (readline
    // reverse-search); only a browser-tab session can act on it.
    if (session?.type !== 'browser-tab') return false;
    const instance = getBrowserTabInstance(session.id);
    if (!instance) return false;
    instance.webview.reload();
    return true;
  });
  shortcutManager.registerHandler('browser-hard-reload', () => {
    const session = appState.activeSession;
    if (session?.type !== 'browser-tab') return false;
    const instance = getBrowserTabInstance(session.id);
    if (!instance) return false;
    instance.webview.reloadIgnoringCache();
    return true;
  });

  document.addEventListener('keydown', (e) => {
    // A terminal's custom key handler runs the dispatcher at the xterm gate
    // (so a consumed shortcut never reaches the PTY); the consumed event
    // bubbles here already prevented — do not run its handler a second time.
    if (e.defaultPrevented) return;
    shortcutManager.matchEvent(e);
  });
}
