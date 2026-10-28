import { appState, MAX_PROJECT_NAME_LENGTH, ProjectRecord } from '../state.js';
import { showModal, setModalError, closeModal, showConfirmDialog, FieldDef, registerModalCleanup } from './modal.js';
import { showPreferencesModal } from './preferences-modal.js';
import { hasUnreadInProject, onChange as onUnreadChange } from '../session-unread.js';
import { onChange as onActivityChange, STATUS_GLYPH } from '../session-activity.js';
import { getProjectStatus, projectInitial } from '../project-status.js';
import { init as initDiscussionsBadge, getNewCount as getDiscussionsNewCount, markSeen as markDiscussionsSeen, onChange as onDiscussionsChange, DISCUSSIONS_URL } from '../discussions-badge.js';
import { openExternal } from '../open-external.js';
import { basename, lastSeparatorIndex } from '../../shared/platform.js';
import { deriveProjectName } from '../../shared/project-name.js';
import { detectGitCheckoutUrl } from '../../shared/git-url.js';
import { joinChildPath } from '../path-join.js';
import { esc } from '../dom-utils.js';
import { projectProfileBadge, providerProfileOptions } from '../profile-utils.js';
import { renderFileTree, clearProjectState as clearFileTreeState, closeFileTree, FILE_MANAGER } from './file-tree.js';
import {
  renderSessionHistory,
  closeSessionHistory,
  clearProjectState as clearSessionHistoryState,
} from './session-history.js';
import { attachHoverCard } from './hover-card.js';
import { mountGitPanel, closeGitPanel } from './git-panel.js';
import { gitChangeCount, onChange as onGitStatusChange } from '../git-status.js';
import { ICON_KANBAN, ICON_TEAM, ICON_OVERVIEW, ICON_SESSIONS, ICON_FILES, ICON_GIT } from '../icons.js';
import { getLocale, onLocaleChange, t } from '../i18n.js';
import { projectsForHost, hostChipHtml } from '../host-scope.js';
import { getHost, getHostColor, getHostName, onHostsChange } from '../host-registry.js';
import { showRemoteDirBrowser } from './remote-dir-browser.js';
import { LOCAL_HOST_ID } from '../../shared/types.js';
import { promptProjectSettings } from './project-settings.js';
import { hideTabContextMenu, setActiveContextMenu, positionMenu } from './tab-bar/menu.js';
import { rlog } from '../log.js';

type ProjectPanel = 'history' | 'files' | 'git' | null;
const projectPanelOpen = new Map<string, ProjectPanel>();
// The project the sidebar last rendered as active; a switch must release the
// outgoing project's panel resources (file-tree dir watches, history panel).
let lastActiveProjectId: string | null = null;

const projectListEl = document.getElementById('project-list')!;
let renamingProjectId: string | null = null;
const btnAddProject = document.getElementById('btn-add-project')!;
const btnPreferences = document.getElementById('btn-preferences')!;
const sidebarEl = document.getElementById('sidebar')!;
const resizeHandle = document.getElementById('sidebar-resize-handle')!;

const sidebarDiscussionsEl = document.getElementById('sidebar-discussions')!;
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar')!;

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 500;

const ICON_DISCUSSIONS = '<svg viewBox="0 -960 960 960" width="14" height="14" fill="currentColor"><path d="m240-240-92 92q-19 19-43.5 8.5T80-177v-623q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240Zm-34-80h594v-480H160v525l46-45Zm-46 0v-480 480Zm120-80h240q17 0 28.5-11.5T560-440q0-17-11.5-28.5T520-480H280q-17 0-28.5 11.5T240-440q0 17 11.5 28.5T280-400Zm0-120h400q17 0 28.5-11.5T720-560q0-17-11.5-28.5T680-600H280q-17 0-28.5 11.5T240-560q0 17 11.5 28.5T280-520Zm0-120h400q17 0 28.5-11.5T720-680q0-17-11.5-28.5T680-720H280q-17 0-28.5 11.5T240-680q0 17 11.5 28.5T280-640Z"/></svg>';

export function toggleSidebar(): void {
  appState.toggleSidebar();
}

function applySidebarCollapsed(): void {
  const collapsed = appState.sidebarCollapsed;
  sidebarEl.classList.toggle('collapsed', collapsed);
  resizeHandle.style.display = collapsed ? 'none' : '';
}

export function initSidebar(): void {
  btnAddProject.addEventListener('click', promptNewProject);
  btnPreferences.addEventListener('click', () => showPreferencesModal());
  btnToggleSidebar.addEventListener('click', toggleSidebar);

  renderDiscussions();
  applyDiscussionsVisibility();
  sidebarDiscussionsEl.addEventListener('click', () => {
    markDiscussionsSeen();
    void openExternal(DISCUSSIONS_URL);
  });
  initDiscussionsBadge();
  onDiscussionsChange(renderDiscussions);
  // Bootstrap renders run before initI18n() applies the persisted locale, so
  // the card must re-translate when the locale changes, not only on badge moves.
  onLocaleChange(renderDiscussions);

  initResizeHandle();
  appState.on('state-loaded', () => {
    if (appState.sidebarWidth) {
      sidebarEl.style.width = appState.sidebarWidth + 'px';
    }
    applySidebarCollapsed();
    // initSidebar() runs before appState.load(), so the discussions link was
    // shown from default preferences; re-apply visibility once the persisted
    // sidebarViews preference is actually available.
    applyDiscussionsVisibility();
    render();
  });
  appState.on('sidebar-toggled', applySidebarCollapsed);
  appState.on('project-added', render);
  appState.on('project-removed', (id) => {
    if (typeof id === 'string') {
      projectPanelOpen.delete(id);
      clearFileTreeState(id);
      clearSessionHistoryState(id);
    }
    render();
  });
  appState.on('project-changed', render);
  // S3-05: an add/close moves one row's count pill + status dot. The old
  // full render() rebuilt the active project's panel — wiping an open Files
  // tree and evicting every cached directory listing (renderFileTree →
  // refreshFolderCache). Structural events (project-*) keep the full render
  // above.
  appState.on('session-added', onSessionRowsChanged);
  appState.on('session-removed', onSessionRowsChanged);
  // C2R-12: layout mode reaches nothing in the project list, and this render
  // is far from free — it rebuilds the active panel, wiping the Files tree and
  // re-reading the root. split-layout owns `layout-changed`.
  // The badge tracks the project's *current* coding tool, which moves whenever
  // the active tab changes. `session-changed` deliberately does not re-render
  // the sidebar (it fires constantly), so patch the one node instead.
  appState.on('session-changed', syncProfileBadge);
  // CI-06: the same event is the batch closes' trailing render kick; flush the
  // row refreshes the deferred `session-removed` events skipped.
  appState.on('session-changed', flushDeferredRows);
  appState.on('readiness-changed', render);

  // PA-11: an unread transition only flips the project name's accent class;
  // rebuilding the list would throw away the rename input, scroll, and panel
  // state. Full render only when the rows no longer mirror the model.
  onUnreadChange(() => {
    const rows = Array.from(projectListEl.querySelectorAll<HTMLElement>('.project-item[data-project-id]'));
    if (rows.length !== appState.projects.length) { render(); return; }
    for (const row of rows) {
      const name = row.querySelector<HTMLElement>('.project-name');
      if (!name) { render(); return; }
      name.classList.toggle('unread', hasUnreadInProject(row.dataset.projectId!));
    }
  });
  // Keep the active project's Git tab badge in sync. Surgical when the button is
  // already present; a full render only when repo-ness first becomes known (the
  // button needs to appear/disappear).
  onGitStatusChange((projectId) => {
    if (projectId !== appState.activeProjectId) return;
    const gitBtn = projectListEl.querySelector('.project-row.active .project-action-btn.git-toggle');
    const count = gitChangeCount(projectId);
    const gitEnabled = appState.sidebarView('gitPanel');
    if (!gitBtn) {
      if (count !== null && gitEnabled) render();
      return;
    }
    if (count === null || !gitEnabled) { render(); return; } // repo went away / disabled
    const badge = gitBtn.querySelector('.project-action-badge');
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle('hidden', count === 0);
    }
  });
  // Status ticks are frequent — update just the affected row's dot rather than
  // rebuilding the whole list (mirrors the tab-bar's surgical update).
  onActivityChange((sessionId) => {
    const project = appState.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
    if (!project || project.id === appState.activeProjectId) return;
    const dot = projectListEl.querySelector(
      `.project-item[data-project-id="${project.id}"] .project-status`,
    );
    if (dot) {
      dot.className = `project-status ${getProjectStatus(project)}`;
      dot.textContent = STATUS_GLYPH[getProjectStatus(project)];
    }
  });
  appState.on('preferences-changed', () => {
    applyDiscussionsVisibility();
    render();
  });
  // Host colors/dots on cards come from the registry cache; repaint when it
  // first loads or a `hosts:status` reload changes it.
  onHostsChange(render);
  // Adding/removing a profile or changing a default flips the badge's
  // visibility/label on the active card.
  appState.on('profiles-changed', render);

  // SR2-f: the document click/Escape → hideTabContextMenu pair lives in
  // initTabBar() (tab-bar/index.ts), which the renderer always runs
  // alongside this one; the duplicate pair registered here double-fired.

  render();
}

interface RenderOpts {
  fileTreeEnabled: boolean;
  historyEnabled: boolean;
  gitEnabled: boolean;
}

function render(): void {
  if (renamingProjectId) return;
  hideTabContextMenu();

  const activeId = appState.activeProjectId;
  if (lastActiveProjectId && lastActiveProjectId !== activeId) {
    // Panel state (projectPanelOpen) is kept, so the panel reopens on return;
    // only the live resources are released. Both close fns are idempotent.
    const prevPanel = projectPanelOpen.get(lastActiveProjectId) ?? null;
    if (prevPanel === 'files') closeFileTree(lastActiveProjectId);
    if (prevPanel === 'history') closeSessionHistory(lastActiveProjectId);
  }
  lastActiveProjectId = activeId;

  projectListEl.innerHTML = '';

  const opts: RenderOpts = {
    fileTreeEnabled: appState.sidebarView('fileTree'),
    historyEnabled: appState.sidebarView('sessionHistory') && appState.preferences.sessionHistoryEnabled,
    gitEnabled: appState.sidebarView('gitPanel'),
  };

  // Projects keep their user-controlled order (drag-and-drop reorderable); the
  // active one is marked as a card in place rather than pinned to the top.
  // Host tab scope (parent §11): only the active host's projects show; with
  // activeHostId absent/'local' this is the full (all-local) list — identical
  // pre-Phase-2 behavior.
  const visible = projectsForHost(appState.projects, appState.preferences.activeHostId);
  for (const { project, isActive } of projectRenderOrder(visible, appState.activeProjectId)) {
    projectListEl.appendChild(buildProjectRow(project, isActive, opts));
  }
}

/**
 * Render plan for the project list: every project in its stored
 * (user-reorderable) order, each flagged `isActive` when it is the current
 * project. The active project is marked **in place** — it is never pinned to
 * the top, so selecting a project does not reorder the list.
 */
export function projectRenderOrder(
  projects: ProjectRecord[],
  activeProjectId: string | null,
): Array<{ project: ProjectRecord; isActive: boolean }> {
  return projects.map((project) => ({ project, isActive: project.id === activeProjectId }));
}

/**
 * Fill a project card's badge node: the coding tool as a dimmed prefix, then
 * the profile that tool runs under. Built from DOM nodes rather than an HTML
 * string so neither the initial paint nor the live repaint can inject.
 * Idempotent — a `data-badge` marker skips the write when nothing changed, so a
 * repaint triggered by an unrelated `session-changed` costs nothing.
 */
function renderProfileBadgeInto(
  node: HTMLElement,
  badge: { tool: string; profile: string } | undefined,
): void {
  const marker = badge ? `${badge.tool}\u0000${badge.profile}` : '';
  if (node.dataset.badge === marker) return;
  node.dataset.badge = marker;
  node.replaceChildren();
  if (!badge) return;
  const tool = document.createElement('span');
  tool.className = 'badge-tool';
  tool.textContent = badge.tool;
  node.appendChild(tool);
  node.appendChild(document.createTextNode(badge.profile));
}

/**
 * Repaint the active project's badge in place. The active tab decides the
 * project's coding tool, and `session-changed` deliberately does not re-render
 * the sidebar, so the node is patched directly instead of rebuilding the list.
 */
function syncProfileBadge(): void {
  const node = projectListEl.querySelector(
    '.project-row.active .project-profile-badge',
  ) as HTMLElement | null;
  if (!node) return;
  renderProfileBadgeInto(
    node,
    appState.activeProject ? projectProfileBadge(appState.activeProject) : undefined,
  );
}

// CI-06: batch closes (removeAllSessions / Close All) mark every per-session
// `session-removed` `deferRender` and end with one trailing `session-changed`
// kick. The projects the batch touched are remembered here and refreshed once
// by that kick; the old path ran the full render() once per removal.
const deferredRowProjects = new Set<string>();

/**
 * S3-05: surgical session-row patch. Only two nodes change when a session
 * is added or closed in a project that already has a row: the session-count
 * pill and (for inactive rows) the aggregate status dot — the same idiom as
 * the syncProfileBadge/onActivityChange patches. Anything the patch cannot
 * express (unknown project, missing row, open Sessions panel whose archive
 * list just gained a row) falls back to the full render.
 */
function onSessionRowsChanged(data?: unknown): void {
  const payload = data as { projectId?: string; deferRender?: boolean } | undefined;
  if (payload?.deferRender) {
    if (payload.projectId) deferredRowProjects.add(payload.projectId);
    return;
  }
  const project = appState.projects.find((p) => p.id === payload?.projectId);
  const row = project
    ? projectListEl.querySelector<HTMLElement>(`.project-item[data-project-id="${project.id}"]`)
    : null;
  if (!project || !row) { render(); return; }
  if (project.id === appState.activeProjectId && projectPanelOpen.get(project.id) === 'history') {
    render();
    return;
  }
  patchSessionRow(project, row);
}

/** The batch's trailing kick repaints every project the batch touched, once. */
function flushDeferredRows(data?: unknown): void {
  if ((data as { deferRender?: boolean } | undefined)?.deferRender) return;
  if (deferredRowProjects.size === 0) return;
  const ids = [...deferredRowProjects];
  deferredRowProjects.clear();
  for (const projectId of ids) onSessionRowsChanged({ projectId });
}

function patchSessionRow(project: ProjectRecord, row: HTMLElement): void {
  const count = project.sessions.length;
  let pill = row.querySelector<HTMLElement>('.project-session-count');
  if (count > 0) {
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'project-session-count';
      row.insertBefore(pill, row.querySelector('.project-delete'));
    }
    pill.textContent = String(count);
  } else if (pill) {
    pill.remove();
  }
  // The active row leads with the avatar (no dot); inactive rows carry the
  // aggregate dot — mirroring the onActivityChange patch's write shape.
  const dot = row.querySelector<HTMLElement>('.project-status');
  if (dot) {
    const status = getProjectStatus(project);
    dot.className = `project-status ${status}`;
    dot.textContent = STATUS_GLYPH[status];
  }
}

function buildProjectRow(project: ProjectRecord, isActive: boolean, opts: RenderOpts): HTMLElement {
  const { fileTreeEnabled, historyEnabled, gitEnabled } = opts;

  const wrapper = document.createElement('div');
  // The wrapper carries `.active` so CSS can style the whole row (header + tabs
  // + panel) as one card without a `:has()` selector.
  wrapper.className = 'project-row' + (isActive ? ' active' : '');

  const el = document.createElement('div');
  el.className = 'project-item' + (isActive ? ' active' : '');
  el.setAttribute('role', 'listitem');
  el.dataset.projectId = project.id;
  el.draggable = true;
  // Host identity color (plan §5): 2px left border + dot on non-local
  // projects; local projects carry no color (neutral, identical to before).
  const hostColor = getHostColor(project.hostId);
  if (hostColor) {
    el.classList.add('project-host-accent');
    // Style-attribute gate (plan §7): getHostColor returns only validated
    // #rrggbb hexes, never a raw record string.
    el.style.borderLeftColor = hostColor;
  }
  // Leading glyph: the active project shows an avatar initial; others show a
  // status dot reflecting their aggregate session activity.
  const lead = isActive
    ? `<div class="project-avatar" aria-hidden="true">${esc(projectInitial(project.name))}</div>`
    : `<span class="project-status ${getProjectStatus(project)}" aria-hidden="true">${STATUS_GLYPH[getProjectStatus(project)]}</span>`;
  const hostDot = hostChipHtml(hostColor, getHostName(project.hostId));
  const countPill = project.sessions.length
    ? `<span class="project-session-count">${project.sessions.length}</span>`
    : '';
  // The badge node is rendered on every row, empty ones hidden by `:empty`, so
  // activating a project without a list rebuild still leaves a node to repaint.
  // Content is filled in below from DOM nodes, never interpolated here.
  const profileBadge =
    `<span class="project-profile-badge" title="${esc(t('sidebar.profileTooltip'))}"></span>`;
  // pi-lens-ignore: xss-innerhtml, no-inner-html
  el.innerHTML = `
    ${lead}
    ${hostDot}
    <div class="project-main">
      <div class="project-name${hasUnreadInProject(project.id) ? ' unread' : ''}">${esc(project.name)}</div>
      <div class="project-path">${esc(project.path)}</div>
    </div>
    ${profileBadge}
    ${countPill}
    <span class="project-delete" title="${esc(t('sidebar.removeProjectTooltip'))}">&times;</span>
  `;
  if (isActive) {
    const badgeNode = el.querySelector('.project-profile-badge') as HTMLElement | null;
    if (badgeNode) renderProfileBadgeInto(badgeNode, projectProfileBadge(project));
  }

  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('project-delete')) return;
    if (isActive) return;
    appState.setActiveProject(project.id);
  });

  el.querySelector('.project-delete')!.addEventListener('click', () => {
    confirmRemoveProject(project);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showProjectContextMenu(e.clientX, e.clientY, project);
  });

  el.addEventListener('dragstart', (e) => {
    if (renamingProjectId === project.id) {
      e.preventDefault();
      return;
    }
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', project.id);
    el.classList.add('dragging');
  });

  el.addEventListener('dragover', (e) => {
    if (el.classList.contains('dragging')) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    el.classList.remove('drag-over-top', 'drag-over-bottom');
    if (e.clientY < midY) {
      el.classList.add('drag-over-top');
    } else {
      el.classList.add('drag-over-bottom');
    }
  });

  el.addEventListener('dragleave', () => {
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over-top', 'drag-over-bottom');
    const draggedId = e.dataTransfer!.getData('text/plain');
    if (!draggedId || draggedId === project.id) return;

    const fromIndex = appState.projects.findIndex(p => p.id === draggedId);
    if (fromIndex === -1) return;

    const rect = el.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    let targetIndex = appState.projects.findIndex(p => p.id === project.id);
    if (e.clientY >= midY) targetIndex++;
    // Adjust for the fact that removing the dragged item shifts indices
    if (fromIndex < targetIndex) targetIndex--;

    appState.reorderProject(fromIndex, targetIndex);
  });

  el.addEventListener('dragend', () => {
    projectListEl.querySelectorAll('.project-item.dragging, .project-item.drag-over-top, .project-item.drag-over-bottom').forEach(node => {
      node.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
    });
  });

  wrapper.appendChild(el);

  if (isActive) {
    // A 'git' panel only stays open while the git view is enabled in prefs.
    let openPanel = projectPanelOpen.get(project.id) ?? null;
    if (openPanel === 'git' && !gitEnabled) openPanel = null;
    const actions = buildProjectActions(project, openPanel, { fileTreeEnabled, historyEnabled, gitEnabled });
    wrapper.appendChild(actions);

    if (openPanel !== null) {
      const panelContainer = document.createElement('div');
      panelContainer.className = 'project-panel';
      if (openPanel === 'files') {
        panelContainer.classList.add('project-panel-files', 'project-file-tree');
        renderFileTree(project, panelContainer);
      } else if (openPanel === 'git') {
        panelContainer.classList.add('project-panel-git');
        mountGitPanel(project, panelContainer);
      } else {
        panelContainer.classList.add('project-panel-history');
        renderSessionHistory(project, panelContainer);
      }
      wrapper.appendChild(panelContainer);
    }
  }

  return wrapper;
}

function buildProjectActions(
  project: ProjectRecord,
  openPanel: ProjectPanel,
  opts: { fileTreeEnabled: boolean; historyEnabled: boolean; gitEnabled: boolean },
): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'project-actions';

  // Only the panel toggles (Files, Sessions) reflect a selected state, derived
  // from openPanel below. The tab buttons (Overview, Kanban, Team) never mark
  // themselves selected from the open tab — opening a tab leaves them inert.
  const overviewBtn = makeActionButton(t('sidebar.overview'), ICON_OVERVIEW, false);
  overviewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    appState.openProjectTab(project.id);
  });
  actions.appendChild(overviewBtn);

  const kanbanBtn = makeActionButton(t('sidebar.kanban'), ICON_KANBAN, false);
  kanbanBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    appState.openKanbanTab(project.id);
  });
  actions.appendChild(kanbanBtn);

  if (opts.historyEnabled) {
    const historyBtn = makeActionButton(t('sidebar.sessions'), ICON_SESSIONS, openPanel === 'history');
    historyBtn.classList.add('panel-toggle');
    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProjectPanel(project.id, openPanel === 'history' ? null : 'history');
    });
    actions.appendChild(historyBtn);
  }

  const teamBtn = makeActionButton(t('sidebar.team'), ICON_TEAM, false);
  teamBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    appState.openTeamTab(project.id);
  });
  actions.appendChild(teamBtn);

  if (opts.fileTreeEnabled) {
    const filesBtn = makeActionButton(t('sidebar.files'), ICON_FILES, openPanel === 'files');
    filesBtn.classList.add('panel-toggle');
    filesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProjectPanel(project.id, openPanel === 'files' ? null : 'files');
    });
    actions.appendChild(filesBtn);
  }

  // Git changes — only for git repos. The badge surfaces the change count so the
  // tab still gives passive awareness without expanding (mirrors the old panel).
  const gitCount = gitChangeCount(project.id);
  if (opts.gitEnabled && gitCount !== null) {
    const gitBtn = makeActionButton(t('sidebar.git'), ICON_GIT, openPanel === 'git');
    gitBtn.classList.add('panel-toggle', 'git-toggle');
    const badge = document.createElement('span');
    badge.className = 'project-action-badge' + (gitCount === 0 ? ' hidden' : '');
    badge.textContent = String(gitCount);
    gitBtn.appendChild(badge);
    gitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setProjectPanel(project.id, openPanel === 'git' ? null : 'git');
    });
    actions.appendChild(gitBtn);
  }

  return actions;
}

function makeActionButton(label: string, iconSvg: string, active: boolean, hint?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'project-action-btn' + (active ? ' active' : '');
  // pi-lens-ignore: xss-innerhtml, no-inner-html
  btn.innerHTML = `<span class="action-icon" aria-hidden="true">${iconSvg}</span><span class="action-label">${esc(label)}</span>`;
  attachHoverCard(btn, hint ?? label);
  return btn;
}

function setProjectPanel(projectId: string, next: ProjectPanel): void {
  const current = projectPanelOpen.get(projectId) ?? null;
  if (current === 'files' && next !== 'files') closeFileTree(projectId);
  if (current === 'history' && next !== 'history') closeSessionHistory(projectId);
  if (current === 'git' && next !== 'git') closeGitPanel();
  if (next === null) {
    projectPanelOpen.delete(projectId);
  } else {
    projectPanelOpen.set(projectId, next);
  }
  render();
}

/** Toggle the Git changes panel on the active project (Cmd/Ctrl+Shift+G). */
export function toggleGitPanel(): void {
  const project = appState.activeProject;
  if (!project) return;
  if (!(appState.preferences.sidebarViews?.gitPanel ?? true)) return;
  if (gitChangeCount(project.id) === null) return; // not a git repo
  const current = projectPanelOpen.get(project.id) ?? null;
  setProjectPanel(project.id, current === 'git' ? null : 'git');
}

export function promptNewProject(): void {
  // T5 (plan §6, UR-6): the SINGLE branch point. Under a non-local active tab
  // every path verb (Browse, probe, create, clone) runs on the host over the
  // hosts:* lanes; the local branches below are untouched. `remoteHome` is
  // the prefill root (HostRecord.defaultFolder, fallback remote `~`).
  const remoteHostId = appState.activeHostId;
  const remote = remoteHostId !== LOCAL_HOST_ID;
  const remoteHome = getHost(remoteHostId)?.defaultFolder?.trim() || '~';

  // A new project has no sessions yet, so its coding tool is the global
  // default — scope the profile picker to that tool.
  const profileOptions = providerProfileOptions(appState.preferences.defaultProvider ?? 'claude', remoteHostId);

  // Live-read so a General-section change while the modal is open is honored
  // on confirm; the pre-fill/sync uses the folder as it was at open.
  const currentFolder = () => (remote
    ? remoteHome
    : appState.preferences.defaultProjectsFolder?.trim() ?? '');
  const initialFolder = currentFolder();
  let pathManuallyEdited = false;
  let cloning = false;
  // The probe gate: fs:isDirectory is a consent-gated stat in main, so no
  // probe may start unless this modal is actually on screen. Armed right
  // after showModal renders, closed by the modal-cleanup funnel below.
  let modalOpen = false;
  const fields: FieldDef[] = [
    { label: t('sidebar.newProject.nameLabel'), id: 'project-name', placeholder: t('sidebar.newProject.namePlaceholder') },
    {
      label: t('sidebar.newProject.pathLabel'), id: 'project-path',
      placeholder: t('sidebar.newProject.urlPlaceholder'),
      defaultValue: initialFolder || undefined,
      buttonLabel: t('sidebar.newProject.browseButton'),
      onButtonClick: async (input) => {
        if (remote) {
          // The local dialog is NEVER constructed under a non-local tab.
          showRemoteDirBrowser({
            hostId: remoteHostId,
            title: t('sidebar.remoteBrowser.title', { name: getHostName(remoteHostId) }),
            startPath: input.value.trim() || remoteHome,
            onSelect: (dir) => {
              input.value = dir;
              pathManuallyEdited = true;
              autoFillName(dir);
              probeDirExists(dir);
            },
          });
          return;
        }
        const dir = await window.finevibe.fs.browseDirectory();
        if (!dir) return;
        input.value = dir;
        pathManuallyEdited = true;
        autoFillName(dir);
        probeDirExists(dir);
      },
    },
  ];
  if (profileOptions.length > 0) {
    fields.push({
      label: t('sidebar.newProject.defaultProfileLabel'),
      id: 'profile',
      type: 'select',
      defaultValue: '',
      options: [
        { value: '', label: t('sidebar.defaultProfileOption') },
        ...profileOptions,
      ],
    });
  }
  showModal(t('sidebar.newProject.title'), fields, async (values) => {
    // SR2-b: the modal's Enter keydown fires the confirm handler even with
    // the button disabled, so a re-trigger can land between ANY of this
    // handler's awaits (expandPath, browseDirectory, cloneRepo). The guard
    // arms synchronously at entry — the one point before any await — and
    // disarms in the handler's finally, covering the plain path too.
    if (cloning) return;
    cloning = true;
    try {
    const name = values['project-name']?.trim();
    const rawPath = values['project-path']?.trim();
    if (!rawPath) return;

    const checkout = detectGitCheckoutUrl(rawPath);
    if (!checkout) {
      if (!name) return;
      // Create means create. Main resolves the raw path (`~`, relative),
      // applies its own consent gate and makes the directory when it is
      // missing. Gating on `fs:isDirectory` here was the bug: outside the
      // allowlisted roots that stat is a confirm-gated call (P2-38), so a
      // cancelled dialog answered "Directory does not exist" for a folder
      // that exists — and the Create verb created nothing.
      const ensured = remote
        ? await window.finevibe.hosts.ensureDir(remoteHostId, rawPath)
        : await window.finevibe.fs.ensureDirectory(rawPath);
      if (!ensured.ok) {
        setModalError('project-path', t('sidebar.newProject.directoryNotCreated') + (ensured.error ? `: ${ensured.error}` : ''));
        return;
      }
      closeModal();
      // Main's resolved/canonical spelling, never the typed string: the
      // project record must carry the path main itself answers for.
      // Local keeps its exact pre-T5 3-arg call; `hostId` is passed only
      // when a host tab owns the path ('local' is the load-time default).
      appState.addProject(name, ensured.path!, values['profile'] || undefined, ...(remote ? [remoteHostId] as const : []));
      return;
    }

    // "Checkout and create": target <folder>/<repo> — the default projects
    // folder, browsed for when unset (plan item 2's friendlier fallback; a
    // cancelled browse leaves the modal open with the URL in place).
    const projectName = name || checkout.repoName;
    // The remote parent is never empty (remoteHome defaults to `~`), so the
    // browse-for-parent fallback below stays the local flow it always was.
    let parent = currentFolder();
    if (!parent) {
      const picked = await window.finevibe.fs.browseDirectory();
      if (!picked) return;
      parent = picked;
    }
    // fs:expandPath resolves against the LOCAL disk — remote paths must never
    // be canonicalized here; the hosts:cloneRepo handler normalizes.
    const targetPath = remote
      ? joinChildPath(parent, checkout.repoName)
      : await window.finevibe.fs.expandPath(joinChildPath(parent, checkout.repoName));

    // Clone is the slow step: the confirm button carries the progress state
    // while it runs (the busy guard armed at entry swallows re-triggers).
    const confirmBtn = document.getElementById('modal-confirm') as HTMLButtonElement | null;
    let res: { ok: boolean; error?: string } | undefined;
    try {
      if (confirmBtn) {
        confirmBtn.textContent = t('sidebar.newProject.cloning');
        confirmBtn.disabled = true;
      }
      res = remote
        ? await window.finevibe.hosts.cloneRepo(remoteHostId, checkout.url, targetPath)
        : await window.finevibe.fs.cloneRepo(checkout.url, targetPath);
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        updateConfirmLabel();
      }
    }
    if (!res?.ok) {
      setModalError('project-path', t('sidebar.newProject.cloneFailed') + (res?.error ? `: ${res.error}` : ''));
      return;
    }
      closeModal();
      appState.addProject(projectName, targetPath, values['profile'] || undefined, ...(remote ? [remoteHostId] as const : []));
    } finally {
      cloning = false;
    }
  });

  modalOpen = true;

  // The confirm label is a three-state machine owned by updateConfirmLabel:
  // a git URL owns the path field → "Checkout and create"; the field points
  // at an existing directory → "Select"; else showModal's fixed label.
  const confirmBtnEl = document.getElementById('modal-confirm');
  const baseConfirmLabel = confirmBtnEl?.textContent ?? '';
  let isCheckoutLabel = false;
  let dirExists = false;
  const updateConfirmLabel = () => {
    if (!confirmBtnEl) return;
    confirmBtnEl.textContent = isCheckoutLabel
      ? t('sidebar.newProject.checkoutAndCreate')
      : dirExists
        ? t('sidebar.newProject.selectButton')
        : baseConfirmLabel;
  };

  // The directory probe runs at open for the prefill only, then on blur,
  // Browse, autocomplete selection and the name→path rewrite — never on the
  // keystroke path (S4-04 precedent: a probe behind a consent-style gate
  // must not fire per keystroke on an arbitrary typed path).
  // Generation counter as in the suggest burst: a stale reply must never
  // paint over the state the current value already earned.
  let dirProbeSeq = 0;
  const probeDirExists = async (value: string) => {
    if (!modalOpen) return;
    const seq = ++dirProbeSeq;
    const apply = (exists: boolean) => {
      if (seq !== dirProbeSeq) return;
      dirExists = exists;
      updateConfirmLabel();
    };
    const trimmed = value.trim();
    if (!trimmed || detectGitCheckoutUrl(trimmed)) {
      apply(false);
      return;
    }
    const probeChain = async (value: string): Promise<boolean> => {
      if (remote) {
        const res = await window.finevibe.hosts.stat(remoteHostId, value);
        return res.ok && res.isDirectory === true;
      }
      const expanded = await window.finevibe.fs.expandPath(value);
      return await window.finevibe.fs.isDirectory(expanded);
    };
    try {
      apply(await probeChain(trimmed));
    } catch {
      apply(false);
    }
  };
  // Mirror of the suggest-debounce teardown: a probe in flight when the modal
  // closes must not paint the label of an already-closed modal, and the gate
  // closes with it — Esc/Cancel/Create all funnel through here.
  registerModalCleanup(() => {
    modalOpen = false;
    dirProbeSeq++;
  });

  // The prefill is the one value this modal can answer for without a
  // dialog: the default projects folder is an allowlisted root in main, so
  // probing it can never raise the native confirm. It is what makes the
  // label right for a folder the user never tabbed through.
  probeDirExists(initialFolder);

  const nameInput = document.getElementById('modal-project-name') as HTMLInputElement | null;
  let nameManuallyEdited = false;
  nameInput?.addEventListener('input', () => {
    nameManuallyEdited = true;
    syncPathFromName();
  });

  const autoFillName = (path: string) => {
    if (nameInput && !nameManuallyEdited && !detectGitCheckoutUrl(path)) {
      nameInput.value = deriveProjectName(path);
    }
  };

  // Name → path sync under the default folder (plan item 1): the same
  // manual-edit guard style, applied to both fields — a hand-typed path is
  // left alone, and a URL owns the field (its target is computed on confirm).
  const syncPathFromName = () => {
    const pathEl = document.getElementById('modal-project-path') as HTMLInputElement | null;
    if (!initialFolder || !pathEl || pathManuallyEdited) return;
    if (detectGitCheckoutUrl(pathEl.value)) return;
    pathEl.value = joinChildPath(initialFolder, nameInput?.value.trim() ?? '');
    // The field was rewritten programmatically, so probe the new value: it
    // is `<default projects folder>/<name>`, a child of an allowlisted
    // root, so the probe is dialog-free too. The generation guard inside
    // drops any reply a probe for the old value has in flight.
    probeDirExists(pathEl.value);
  };

  // Attach path autocomplete to the rendered input
  const pathInput = document.getElementById('modal-project-path') as HTMLInputElement | null;
  if (pathInput) {
    const fieldRow = pathInput.parentElement!;
    fieldRow.style.position = 'relative';
    fieldRow.style.flexWrap = 'wrap';

    const dropdown = document.createElement('div');
    dropdown.className = 'path-autocomplete-dropdown';
    fieldRow.appendChild(dropdown);

    let activeIndex = -1;

    const hideDropdown = () => {
      dropdown.innerHTML = '';
      dropdown.classList.remove('visible');
      activeIndex = -1;
    };

    const showSuggestions = (dirs: string[], dirPart: string) => {
      dropdown.innerHTML = '';
      activeIndex = -1;
      if (dirs.length === 0) { hideDropdown(); return; }
      for (const dir of dirs) {
        const item = document.createElement('div');
        item.className = 'path-autocomplete-item';
        item.textContent = dirPart + basename(dir);
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pathInput.value = item.textContent!;
          hideDropdown();
          autoFillName(pathInput.value);
          probeDirExists(pathInput.value);
        });
        dropdown.appendChild(item);
      }
      dropdown.classList.add('visible');
    };

    // SR2-c: one fs.listDirs burst per ~100ms of typing, and a generation
    // counter so a slow reply for an old prefix can never overwrite the
    // suggestions (or the dropdown) the current prefix already earned.
    let suggestSeq = 0;
    let suggestTimer: ReturnType<typeof setTimeout> | null = null;
    pathInput.addEventListener('input', () => {
      pathManuallyEdited = true;
      const value = pathInput.value;
      const checkout = detectGitCheckoutUrl(value);
      isCheckoutLabel = Boolean(checkout);
      updateConfirmLabel();
      if (checkout) {
        // The URL owns the field: name from the repo, and no path
        // autocomplete — a URL's dirPart is not a filesystem path to enumerate.
        if (nameInput && !nameManuallyEdited) nameInput.value = checkout.repoName;
        suggestSeq++;
        if (suggestTimer !== null) { clearTimeout(suggestTimer); suggestTimer = null; }
        hideDropdown();
        return;
      }
      // Keystroke rewrite: same invalidation as the programmatic one. The
      // keystroke path itself never probes — the label stays plain until the
      // next blur/Browse/autocomplete probe earns Select again.
      dirExists = false;
      dirProbeSeq++;
      updateConfirmLabel();
      autoFillName(value);
      const lastSlash = lastSeparatorIndex(value);
      if (lastSlash === -1) {
        suggestSeq++;
        if (suggestTimer !== null) { clearTimeout(suggestTimer); suggestTimer = null; }
        hideDropdown();
        return;
      }

      const dirPart = value.substring(0, lastSlash + 1);
      const namePart = value.substring(lastSlash + 1).toLowerCase();
      const seq = ++suggestSeq;
      if (suggestTimer !== null) clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => {
        suggestTimer = null;
        const listed = remote
          ? window.finevibe.hosts.listDirs(remoteHostId, dirPart, namePart || undefined).then((r) => r.dirs ?? [])
          : window.finevibe.fs.listDirs(dirPart, namePart || undefined);
        listed
          .then((dirs) => { if (seq === suggestSeq) showSuggestions(dirs, dirPart); })
          .catch(() => {});
      }, 100);
    });

    // C2R-11: the 100 ms debounce outlives the modal otherwise, and one stale
    // fs.listDirs reply paints a dropdown on a detached field.
    // registerModalCleanup runs on every close funnel (Esc, Cancel, Create).
    registerModalCleanup(() => {
      suggestSeq++;
      if (suggestTimer !== null) { clearTimeout(suggestTimer); suggestTimer = null; }
    });

    pathInput.addEventListener('keydown', (e) => {
      const items = dropdown.querySelectorAll<HTMLElement>('.path-autocomplete-item');
      if (!items.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[activeIndex]?.classList.remove('active');
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        items[activeIndex].classList.add('active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[activeIndex]?.classList.remove('active');
        activeIndex = Math.max(activeIndex - 1, 0);
        items[activeIndex].classList.add('active');
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if ((e.key === 'Enter' || e.key === 'Tab') && activeIndex >= 0) {
        e.preventDefault();
        e.stopPropagation();
        pathInput.value = items[activeIndex].textContent!;
        hideDropdown();
        autoFillName(pathInput.value);
        probeDirExists(pathInput.value);
      } else if (e.key === 'Escape') {
        hideDropdown();
      }
    });

    pathInput.addEventListener('blur', (e) => {
      setTimeout(hideDropdown, 100);
      autoFillName(pathInput.value);
      // Probe only on a real focus move. A null relatedTarget is the overlay
      // being hidden (Esc/Cancel dismissal) or plain focus loss, and a move
      // into the modal footer is Cancel/Confirm — Cancel must never probe, and
      // the confirm handler re-checks the directory on its own.
      const to = e.relatedTarget as HTMLElement | null;
      if (!to || to.closest('#modal-actions')) return;
      probeDirExists(pathInput.value);
    });
  }
}

function initResizeHandle(): void {
  let dragging = false;

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizeHandle.classList.add('active');
    document.body.classList.add('sidebar-resizing');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // If the mouse was released outside the window, mouseup never fired — detect via buttons and tear down.
    if (!e.buttons) {
      dragging = false;
      resizeHandle.classList.remove('active');
      document.body.classList.remove('sidebar-resizing');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      appState.setSidebarWidth(parseInt(sidebarEl.style.width, 10));
      return;
    }
    const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
    sidebarEl.style.width = width + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('active');
    document.body.classList.remove('sidebar-resizing');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    appState.setSidebarWidth(parseInt(sidebarEl.style.width, 10));
  });
}

function applyDiscussionsVisibility(): void {
  const visible = appState.sidebarView('discussions');
  sidebarDiscussionsEl.classList.toggle('hidden', !visible);
}

function confirmRemoveProject(project: ProjectRecord): void {
  const historyCount = project.sessionHistory?.length ?? 0;
  const taskCount = project.board?.tasks?.length ?? 0;

  const parts: string[] = [];
  if (historyCount > 0) {
    const noun = historyCount === 1
      ? t('sidebar.removeConfirm.sessionsHistoryNounSingular')
      : t('sidebar.removeConfirm.sessionsHistoryNounPlural');
    parts.push(t('sidebar.removeConfirm.sessionsHistory', { count: historyCount, noun }));
  }
  if (taskCount > 0) {
    const noun = taskCount === 1
      ? t('sidebar.removeConfirm.kanbanTasksNounSingular')
      : t('sidebar.removeConfirm.kanbanTasksNounPlural');
    parts.push(t('sidebar.removeConfirm.kanbanTasks', { count: taskCount, noun }));
  }

  const message = parts.length > 0
    ? t('sidebar.removeConfirm.withDataMessage', { name: project.name, parts: parts.join(' and ') })
    : t('sidebar.removeConfirm.emptyMessage', { name: project.name });
  showConfirmDialog(t('sidebar.removeConfirm.title'), message, {
    confirmLabel: t('sidebar.removeConfirm.confirmLabel'),
    onConfirm: () => appState.removeProject(project.id),
  });
}

function startProjectRename(project: ProjectRecord): void {
  const el = projectListEl.querySelector(
    `.project-item[data-project-id="${project.id}"]`,
  ) as HTMLElement | null;
  const nameEl = el?.querySelector('.project-name') as HTMLElement | null;
  if (!nameEl || nameEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.maxLength = MAX_PROJECT_NAME_LENGTH;
  input.value = project.name;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  renamingProjectId = project.id;

  let committed = false;
  const finish = (newName: string | null) => {
    if (committed) return;
    committed = true;
    input.remove();
    renamingProjectId = null;
    if (newName && newName !== project.name) {
      appState.renameProject(project.id, newName);
    } else {
      render();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(input.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(null);
    }
  });

  input.addEventListener('blur', () => finish(input.value.trim()));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function showProjectContextMenu(x: number, y: number, project: ProjectRecord): void {
  hideTabContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const renameItem = document.createElement('div');
  renameItem.className = 'tab-context-menu-item';
  renameItem.textContent = t('contextMenu.project.rename');
  renameItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    startProjectRename(project);
  });

  const hasSessions = project.sessions.length > 0;

  const closeAllItem = document.createElement('div');
  closeAllItem.className = 'tab-context-menu-item' + (!hasSessions ? ' disabled' : '');
  closeAllItem.textContent = t('contextMenu.project.closeAllSessions');
  if (hasSessions) {
    closeAllItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTabContextMenu();
      appState.removeAllSessions(project.id);
    });
  }

  const openInFolderItem = document.createElement('div');
  openInFolderItem.className = 'tab-context-menu-item';
  openInFolderItem.textContent = t('contextMenu.project.openInFileManager', { fileManager: FILE_MANAGER });
  openInFolderItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    void window.finevibe.fs.showInFolder(project.path)
      .then((result) => {
        if (!result.ok) rlog('warn', `Failed to open ${project.path} in ${FILE_MANAGER}: ${result.error ?? 'unknown error'}`);
      })
      .catch((err) => rlog('warn', `Failed to open ${project.path} in ${FILE_MANAGER}:`, err));
  });

  const copyPathItem = document.createElement('div');
  copyPathItem.className = 'tab-context-menu-item';
  copyPathItem.textContent = t('contextMenu.project.copyPath');
  copyPathItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    navigator.clipboard.writeText(project.path).catch((err) => rlog('warn', 'clipboard write failed', err));
  });

  const separator = document.createElement('div');
  separator.className = 'tab-context-menu-separator';

  // Provider defaults can be changed even when no profiles have been created.
  const settingsItem = document.createElement('div');
  settingsItem.className = 'tab-context-menu-item';
  settingsItem.textContent = t('contextMenu.project.settings');
  settingsItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    promptProjectSettings(project);
  });

  const removeItem = document.createElement('div');
  removeItem.className = 'tab-context-menu-item';
  removeItem.textContent = t('contextMenu.project.removeProject');
  removeItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTabContextMenu();
    confirmRemoveProject(project);
  });

  menu.appendChild(renameItem);
  menu.appendChild(closeAllItem);
  menu.appendChild(openInFolderItem);
  menu.appendChild(copyPathItem);
  menu.appendChild(settingsItem);
  menu.appendChild(separator);
  menu.appendChild(removeItem);
  document.body.appendChild(menu);
  setActiveContextMenu(menu);
  positionMenu(menu);
}

let lastDiscussionsCount = -1;
let lastDiscussionsLocale = '';

function renderDiscussions(): void {
  const count = getDiscussionsNewCount();
  const locale = getLocale();
  if (count === lastDiscussionsCount && locale === lastDiscussionsLocale) return;
  lastDiscussionsCount = count;
  lastDiscussionsLocale = locale;
  // Two unread indicators: dot is shown only when sidebar is collapsed (icon visible),
  // inline badge is shown only when expanded (text visible). CSS picks one per mode.
  const dot = count > 0 ? '<span class="discussions-icon-dot"></span>' : '';
  const inlineBadge = count > 0 ? ` <span class="discussions-badge">${count}</span>` : '';
  sidebarDiscussionsEl.title = t('sidebar.discussions.tooltip');
  // pi-lens-ignore: xss-innerhtml, no-inner-html
  sidebarDiscussionsEl.innerHTML =
    `<span class="action-icon" aria-hidden="true">${ICON_DISCUSSIONS}${dot}</span>` +
    `<div class="discussions-text">` +
      `<div class="discussions-title">${esc(t('sidebar.discussions.title'))}${inlineBadge}</div>` +
      `<div class="discussions-desc">${esc(t('sidebar.discussions.description'))}</div>` +
    `</div>`;
}

