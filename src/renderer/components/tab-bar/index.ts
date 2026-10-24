import { appState } from '../../state.js';
import { onChange as onStatusChange } from '../../session-activity.js';
import { onSshChange } from '../../session-ssh.js';
import { onChange as onGitStatusChange } from '../../git-status.js';
import { onChange as onUnreadChange } from '../../session-unread.js';
import { onChange as onGithubUnreadChange } from '../../github-unread.js';
import { ICON_TERMINAL, ICON_MENU } from '../../icons.js';
import { onShareChange } from '../../sharing/share-manager.js';
import { loadProviderAvailability, hasMultipleAvailableProviders } from '../../provider-availability.js';
import { getActiveContextMenu, hideTabContextMenu } from './menu.js';
import { gitStatusEl, tabListEl } from './dom.js';
import { render, updateTabStatus, updateTabSsh, handleSessionChanged, patchUnread } from './tab-list.js';
import { clearTabScrollState } from './tab-scroll.js';
import { initTabArrows, syncTabArrows } from './tab-arrows.js';
import { renderGitStatus, showBranchContextMenu } from './git-status-bar.js';
import { showMoreMenu, promptNewSession, quickNewSession } from './session-menu.js';

const btnAddSession = document.getElementById('btn-add-session')!;
const btnAddSessionMenu = document.getElementById('btn-add-session-menu')!;
const btnAddBrowserTab = document.getElementById('btn-add-browser-tab')!;
const btnMore = document.getElementById('btn-more')!;
// Terminal toggle is wired in project-terminal.ts; we only own its icon here.
const btnToggleTerminal = document.getElementById('btn-toggle-terminal')!;

export function initTabBar(): void {
  // pi-lens-ignore: xss-innerhtml, slop, no-inner-html
  btnToggleTerminal.innerHTML = ICON_TERMINAL;
  // pi-lens-ignore: xss-innerhtml, slop, no-inner-html
  btnMore.innerHTML = ICON_MENU;
  // Browser button keeps its CSS-drawn .toolbar-icon-browser glyph from index.html.

  btnAddSession.addEventListener('click', () => quickNewSession());
  btnAddSession.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMoreMenu(e.clientX, e.clientY);
  });
  // The pill's caret opens a custom-session dialog; the More button owns the menu.
  btnAddSessionMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    promptNewSession();
  });
  btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    if (getActiveContextMenu()) {
      hideTabContextMenu();
      return;
    }
    const rect = btnMore.getBoundingClientRect();
    showMoreMenu(rect.left, rect.bottom + 4);
  });
  btnAddBrowserTab.addEventListener('click', () => {
    const project = appState.activeProject;
    if (project) appState.addBrowserTabSession(project.id);
  });
  gitStatusEl.addEventListener('click', (e) => showBranchContextMenu(e));

  initTabArrows();
  // Every offset change lands here — arrow clicks, scrollbar drags, the
  // auto-scroll on session switch, and smooth-scroll settling at an edge.
  tabListEl.addEventListener('scroll', syncTabArrows, { passive: true });
  // Every width change too: window resize, sidebar drag, and the strip's own
  // gain/loss of the arrow reserve (tabsOverflow's hysteresis converges it).
  new ResizeObserver(syncTabArrows).observe(tabListEl);

  // Icons only distinguish providers when multiple are installed
  loadProviderAvailability().then(() => {
    if (hasMultipleAvailableProviders()) render();
  }).catch(() => {});

  appState.on('state-loaded', render);
  // SR2-a: add/close reach the strip through `session-changed` (kind
  // add/remove → handleSessionChanged) below. The old session-added /
  // session-removed subscriptions double-routed every add/close into two
  // full strip rebuilds; split-layout and sidebar own their own
  // subscriptions to those events.
  appState.on('project-changed', render);
  appState.on('project-removed', (id) => { if (typeof id === 'string') clearTabScrollState(id); });
  appState.on('session-changed', handleSessionChanged);
  // C2R-12: the strip renders no layout state (only session-menu's swarm
  // entry reads layout.mode, at open time), so layout toggles never needed a
  // rebuild — split-layout owns `layout-changed` and renders the panes.
  onShareChange(render);

  onStatusChange(updateTabStatus);

  // Live ssh connect/disconnect: patch the tab's ssh prefix in place.
  onSshChange((sessionId) => updateTabSsh(sessionId));

  // PA-11: flip the tab dots in place; full strip render only if the strip
  // no longer mirrors the model (session-unread already coalesces per frame).
  onUnreadChange(() => { if (!patchUnread()) render(); });
  // C2R-08: github notifications only move the project-tab dots, which
  // patchUnread already recomputes (hasGithubUnread); the full strip rebuild
  // per notify was pure waste.
  onGithubUnreadChange(() => { if (!patchUnread()) render(); });

  onGitStatusChange((projectId) => {
    if (projectId === appState.activeProjectId) renderGitStatus();
  });
  appState.on('project-changed', renderGitStatus);

  document.addEventListener('click', hideTabContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTabContextMenu(); });

  render();
}
