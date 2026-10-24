import { appState, ArchivedSession, ProjectRecord } from '../state.js';
import { loadProviderAvailability } from '../provider-availability.js';
import { buildResumeWithProviderItems } from './resume-with-provider-menu.js';
import { showConfirmDialog } from './modal.js';
import { getLocale, onLocaleChange, t } from '../i18n.js';
import type { ProviderId } from '../../shared/types.js';

const MAX_VISIBLE = 50;
const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini CLI',
  pi: 'Pi',
  omp: 'Oh My Pi',
  'pi-bolt': 'Pi-Bolt',
};

interface ProjectFilterState {
  searchText: string;
  bookmarkOnly: boolean;
}

const filterStateByProject = new Map<string, ProjectFilterState>();
const activePanels = new Map<string, Map<string, HTMLElement>>();
const DEFAULT_INSTANCE_KEY = 'sidebar';

let historyContextMenu: HTMLElement | null = null;

function hideHistoryContextMenu(): void {
  if (historyContextMenu) {
    historyContextMenu.remove();
    historyContextMenu = null;
  }
}

function showHistoryToast(message: string): void {
  const el = document.createElement('div');
  el.className = 'history-toast';
  el.textContent = message;
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;' +
    'padding:8px 14px;border-radius:6px;background:var(--bg-secondary,#222);color:var(--fg-primary,#eee);' +
    'border:1px solid var(--border-color,#444);font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/** Save this session's durable record: `zip` = meta.json + transcript + sidecars; `file` = the transcript verbatim. */
async function backupSession(project: ProjectRecord, archived: ArchivedSession, format: 'zip' | 'file'): Promise<void> {
  const providerId = (archived.providerId || 'claude') as ProviderId;
  const profile = archived.profileId
    ? appState.profiles.find((p) => p.id === archived.profileId && p.providerId === providerId)
    : undefined;
  try {
    const outPath = await window.finevibe.session.exportArchive(
      providerId,
      archived.cliSessionId,
      project.path,
      profile?.configDir,
      archived,
      format,
    );
    if (outPath) showHistoryToast(t('session.history.exportSaved', { path: outPath }));
  } catch (err) {
    showHistoryToast(t('session.history.exportFailed', { err: String((err as Error)?.message ?? err) }));
  }
}

function showHistoryContextMenu(x: number, y: number, project: ProjectRecord, archived: ArchivedSession): void {
  hideHistoryContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Active rows (live sessions recorded at creation) finalize on close; they
  // carry no closed transcript guarantee, so no Resume affordances.
  const isActive = archived.state === 'active';
  if (!isActive && archived.cliSessionId && archived.transcriptAvailable !== false) {
    const resumeItem = document.createElement('div');
    resumeItem.className = 'tab-context-menu-item';
    resumeItem.textContent = t('session.history.resume');
    resumeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideHistoryContextMenu();
      void appState.resumeFromHistorySafe(project.id, archived.id);
    });
    menu.appendChild(resumeItem);
  }

  // Same gate as Resume above: an active row's transcript is being written by
  // a live CLI; resuming it elsewhere spawns a second agent on the same
  // conversation.
  if (!isActive && archived.cliSessionId && archived.transcriptAvailable !== false) {
    const resumeWithItems = buildResumeWithProviderItems(
      (archived.providerId || 'claude') as ProviderId,
      (targetId) => {
        hideHistoryContextMenu();
        appState.resumeWithProvider(project.id, { archivedSessionId: archived.id }, targetId);
      },
    );
    for (const el of resumeWithItems) menu.appendChild(el);
  }

  if (menu.firstChild) {
    const separator = document.createElement('div');
    separator.className = 'tab-context-menu-separator';
    menu.appendChild(separator);
  }

  // A running tab's row is the record its close finalizes. Removing it here
  // makes the close archive a fresh entry under a new id (bookmark lost), so
  // removal lives with the tab, not with the row - matching the sessions
  // widget, and enforced in the state layer as well.
  if (!isActive) {
    const removeItem = document.createElement('div');
    removeItem.className = 'tab-context-menu-item danger';
    removeItem.textContent = t('session.history.removeFromHistory');
    removeItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideHistoryContextMenu();
      appState.removeHistoryEntry(project.id, archived.id);
    });
    menu.appendChild(removeItem);
  }

  const backupItem = document.createElement('div');
  backupItem.className = 'tab-context-menu-item';
  backupItem.textContent = t('session.history.exportZip');
  backupItem.title = archived.cliSessionId
    ? t('session.history.exportZipTooltip')
    : t('session.history.exportZipNoIdTooltip');
  backupItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideHistoryContextMenu();
    void backupSession(project, archived, 'zip');
  });
  menu.appendChild(backupItem);

  if (archived.cliSessionId) {
    const fileItem = document.createElement('div');
    fileItem.className = 'tab-context-menu-item';
    fileItem.textContent = t('session.history.exportTranscript');
    fileItem.title = t('session.history.exportTranscriptTooltip');
    fileItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideHistoryContextMenu();
      void backupSession(project, archived, 'file');
    });
    menu.appendChild(fileItem);
  }

  document.body.appendChild(menu);
  historyContextMenu = menu;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
}

function getFilterState(projectId: string): ProjectFilterState {
  let state = filterStateByProject.get(projectId);
  if (!state) {
    state = { searchText: '', bookmarkOnly: false };
    filterStateByProject.set(projectId, state);
  }
  return state;
}

let listenersAttached = false;

export function initSessionHistory(): void {
  if (listenersAttached) return;
  listenersAttached = true;

  appState.on('history-changed', rerenderAll);
  onLocaleChange(rerenderAll);
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', hideHistoryContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideHistoryContextMenu(); });
  }
}

function rerenderAll(): void {
  for (const [projectId, panels] of activePanels) {
    const project = appState.projects.find(p => p.id === projectId);
    if (!project) continue;
    for (const [instanceKey, container] of panels) {
      renderSessionHistory(project, container, instanceKey);
    }
  }
}

export function renderSessionHistory(
  project: ProjectRecord,
  container: HTMLElement,
  instanceKey: string = DEFAULT_INSTANCE_KEY,
): void {
  let panels = activePanels.get(project.id);
  if (!panels) {
    panels = new Map();
    activePanels.set(project.id, panels);
  }
  panels.set(instanceKey, container);

  const history = appState.getSessionHistory(project.id);
  const filter = getFilterState(project.id);

  container.innerHTML = '';

  if (history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('session.history.empty');
    container.appendChild(empty);
    return;
  }

  const searchInput = document.createElement('input');
  searchInput.className = 'history-search';
  searchInput.type = 'text';
  searchInput.placeholder = t('session.history.filterPlaceholder');
  searchInput.value = filter.searchText;
  searchInput.addEventListener('input', () => {
    filter.searchText = searchInput.value;
    renderList(project, container, history, filter);
  });
  container.appendChild(searchInput);

  const bookmarkFilter = document.createElement('button');
  const applyFilterState = () => {
    bookmarkFilter.className = `history-bookmark-filter${filter.bookmarkOnly ? ' active' : ''}`;
    bookmarkFilter.textContent = `${filter.bookmarkOnly ? '★' : '☆'} ${t('session.history.bookmarked')}`;
  };
  applyFilterState();
  bookmarkFilter.addEventListener('click', () => {
    filter.bookmarkOnly = !filter.bookmarkOnly;
    applyFilterState();
    renderList(project, container, history, filter);
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'history-clear-btn';
  clearBtn.textContent = t('session.history.clearButton');
  clearBtn.addEventListener('click', () => {
    showConfirmDialog(
      t('session.history.clearTitle'),
      t('session.history.clearMessage', { name: project.name }),
      {
        confirmLabel: t('session.history.clearConfirm'),
        onConfirm: () => appState.clearSessionHistory(project.id),
      },
    );
  });

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  actions.appendChild(bookmarkFilter);
  actions.appendChild(clearBtn);
  container.appendChild(actions);

  const listEl = document.createElement('div');
  listEl.className = 'history-list';
  container.appendChild(listEl);

  renderList(project, container, history, filter);
}

export function closeSessionHistory(projectId: string, instanceKey?: string): void {
  const panels = activePanels.get(projectId);
  if (!panels) return;
  if (instanceKey === undefined) {
    for (const container of panels.values()) container.innerHTML = '';
    activePanels.delete(projectId);
    return;
  }
  const container = panels.get(instanceKey);
  if (container) container.innerHTML = '';
  panels.delete(instanceKey);
  if (panels.size === 0) activePanels.delete(projectId);
}

export function clearProjectState(projectId: string): void {
  filterStateByProject.delete(projectId);
  activePanels.delete(projectId);
}

function renderList(
  project: ProjectRecord,
  container: HTMLElement,
  history: ArchivedSession[],
  filter: ProjectFilterState,
): void {
  const listEl = container.querySelector('.history-list') as HTMLElement | null;
  if (!listEl) return;

  const needle = filter.searchText.toLowerCase();
  const filtered = history
    .filter((a) => a.name.toLowerCase().includes(needle))
    .filter((a) => !filter.bookmarkOnly || a.bookmarked)
    .slice()
    .reverse();

  listEl.innerHTML = '';

  const visible = filtered.slice(0, MAX_VISIBLE);
  for (const archived of visible) {
    const item = document.createElement('div');
    item.className = 'history-item';

    if (archived.state === 'active' && archived.liveSessionId) {
      // Running row: clicking switches to the live tab (a live session is
      // never "resumed" — that would duplicate the CLI session).
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        appState.setActiveSession(project.id, archived.liveSessionId!);
      });
    } else if (archived.cliSessionId && archived.transcriptAvailable !== false) {
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => {
        void appState.resumeFromHistorySafe(project.id, archived.id);
      });
    }
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadProviderAvailability().catch(() => {});
      showHistoryContextMenu(e.clientX, e.clientY, project, archived);
    });

    const info = document.createElement('div');
    info.className = 'history-item-info';

    const name = document.createElement('div');
    name.className = 'history-item-name';
    name.textContent = archived.name;
    if (archived.state === 'active') {
      const dot = document.createElement('span');
      dot.className = 'history-active-dot';
      dot.title = t('session.history.runningTooltip');
      dot.style.cssText = 'display:inline-block;width:7px;height:7px;border-radius:50%;background:#3fb950;margin-right:6px;vertical-align:middle;';
      name.appendChild(dot);
    }
    name.title = archived.cliSessionId
      ? `${archived.name}\n${t('session.history.sessionId', { id: archived.cliSessionId })}`
      : archived.name;
    info.appendChild(name);
    if (archived.exitReason) {
      const badge = document.createElement('span');
      badge.className = 'history-crash-badge';
      badge.textContent = '\u26A0';
      const exitDetails = [
        archived.processId !== undefined ? `PID ${archived.processId}` : null,
        archived.exitCode !== undefined ? `code ${archived.exitCode}` : null,
        archived.exitSignal !== undefined ? `signal ${archived.exitSignal}` : null,
      ].filter(Boolean).join(', ');
      badge.title = `${t('session.crashedTitle')}: ${archived.exitReason}${exitDetails ? ` (${exitDetails})` : ''}`;
      name.appendChild(badge);
    }

    const details = document.createElement('div');
    details.className = 'history-item-details';
    const parts: string[] = [];
    parts.push(archived.state === 'active' ? t('session.history.running') : formatDate(archived.closedAt ?? archived.createdAt));
    if (archived.cost) {
      parts.push(`$${archived.cost.totalCostUsd.toFixed(2)}`);
    }
    parts.push(getProviderLabel(archived.providerId));
    details.textContent = parts.join(' · ');
    info.appendChild(details);

    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'history-item-actions';

    if (archived.exitReason && archived.cliSessionId && archived.transcriptAvailable !== false) {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'history-resume-btn';
      resumeBtn.textContent = t('session.history.resume');
      resumeBtn.title = t('session.history.resumeCrashedTooltip');
      resumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void appState.resumeFromHistorySafe(project.id, archived.id);
      });
      actions.appendChild(resumeBtn);
    }

    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.className = `history-bookmark-btn${archived.bookmarked ? ' bookmarked' : ''}`;
    bookmarkBtn.textContent = archived.bookmarked ? '★' : '☆';
    bookmarkBtn.title = archived.bookmarked ? t('session.history.removeBookmarkTooltip') : t('session.history.bookmarkTooltip');
    bookmarkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.toggleBookmark(project.id, archived.id);
    });
    actions.appendChild(bookmarkBtn);

    item.appendChild(actions);

    listEl.appendChild(item);
  }

  if (filtered.length > MAX_VISIBLE) {
    const more = document.createElement('div');
    more.className = 'history-item-details';
    more.style.padding = '4px 12px';
    more.textContent = t('session.history.moreItems', { count: filtered.length - MAX_VISIBLE });
    listEl.appendChild(more);
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays < 7) {
    // Intl renders -1 day as "Yesterday"/"昨天" (numeric: 'auto') and the
    // rest as "N days ago"/"N天前" in the active UI locale.
    return new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(-diffDays, 'day');
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getProviderLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}
