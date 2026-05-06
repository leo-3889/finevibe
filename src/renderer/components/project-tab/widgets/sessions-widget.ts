import type { ArchivedSession, ProviderId, SessionRecord } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { getStatus, onChange as onStatusChange, type SessionStatus } from '../../../session-activity.js';
import { getCost, onChange as onCostChange, formatTokens } from '../../../session-cost.js';
import { isUnread, onChange as onUnreadChange } from '../../../session-unread.js';
import { getProviderDisplayName } from '../../../provider-availability.js';
import { isCliSession } from '../../../session-utils.js';
import { createWidgetEmpty } from './widget-empty.js';
import type { WidgetFactory } from './widget-host.js';
import { DEFAULT_SESSIONS_CONFIG, type SessionsConfig } from './sessions-types.js';

export const createSessionsWidget: WidgetFactory = (host) => {
  const root = document.createElement('div');
  root.className = 'widget-sessions';

  function startNewSession(): void {
    const project = appState.projects.find((p) => p.id === host.projectId);
    if (!project) return;
    appState.addSession(project.id, `Session ${project.sessions.length + 1}`);
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'widget-sessions-toolbar';

  const countLabel = document.createElement('span');
  countLabel.className = 'widget-sessions-count';
  toolbar.appendChild(countLabel);

  const newBtn = document.createElement('button');
  newBtn.className = 'widget-sessions-add-btn';
  newBtn.textContent = '+ New Session';
  newBtn.title = 'Start a new session in this project';
  newBtn.addEventListener('click', startNewSession);
  toolbar.appendChild(newBtn);

  root.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'widget-sessions-body';
  root.appendChild(body);

  function render(): void {
    const project = appState.projects.find((p) => p.id === host.projectId);
    body.innerHTML = '';

    const cfg = host.getConfig<Partial<SessionsConfig>>();
    const recentLimit = typeof cfg.recentLimit === 'number'
      ? cfg.recentLimit
      : DEFAULT_SESSIONS_CONFIG.recentLimit;

    const sessions = (project?.sessions ?? []).filter(isCliSession);
    const history = (project?.sessionHistory ?? [])
      .slice()
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, recentLimit);

    countLabel.textContent = sessions.length === 1 ? '1 active' : `${sessions.length} active`;

    body.appendChild(buildActiveSection(sessions, project?.activeSessionId ?? null));
    body.appendChild(buildRecentSection(history));
  }

  function buildActiveSection(sessions: SessionRecord[], activeSessionId: string | null): HTMLElement {
    const section = document.createElement('div');
    section.className = 'widget-sessions-section';

    const heading = document.createElement('div');
    heading.className = 'widget-sessions-section-heading';
    heading.textContent = 'Active';
    section.appendChild(heading);

    if (sessions.length === 0) {
      section.appendChild(createWidgetEmpty('No active sessions.', 'Start a session', startNewSession));
      return section;
    }

    const list = document.createElement('div');
    list.className = 'widget-sessions-list';
    for (const session of sessions) {
      list.appendChild(buildActiveRow(session, session.id === activeSessionId));
    }
    section.appendChild(list);
    return section;
  }

  function buildActiveRow(session: SessionRecord, isActive: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'widget-sessions-row widget-sessions-row-active';
    row.classList.toggle('active', isActive);
    row.dataset['sessionId'] = session.id;
    row.title = session.name;

    const dot = document.createElement('span');
    dot.className = `tab-status ${getStatus(session.id)}`;
    row.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'widget-sessions-row-main';

    const name = document.createElement('div');
    name.className = 'widget-sessions-row-name';
    name.textContent = session.name;
    name.classList.toggle('unread', isUnread(session.id));
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'widget-sessions-row-meta';

    const provider = document.createElement('span');
    provider.className = 'widget-sessions-provider';
    provider.textContent = getProviderDisplayName((session.providerId ?? 'claude') as ProviderId);
    meta.appendChild(provider);

    const cost = document.createElement('span');
    cost.className = 'widget-sessions-cost';
    cost.textContent = formatCost(session.id);
    meta.appendChild(cost);

    main.appendChild(meta);
    row.appendChild(main);

    row.addEventListener('click', () => {
      appState.setActiveSession(host.projectId, session.id);
    });

    return row;
  }

  function buildRecentSection(history: ArchivedSession[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'widget-sessions-section';

    const heading = document.createElement('div');
    heading.className = 'widget-sessions-section-heading';
    heading.textContent = 'Recent';
    section.appendChild(heading);

    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'widget-sessions-recent-empty';
      empty.textContent = 'No archived sessions yet.';
      section.appendChild(empty);
      return section;
    }

    const list = document.createElement('div');
    list.className = 'widget-sessions-list';
    for (const archived of history) {
      list.appendChild(buildRecentRow(archived));
    }
    section.appendChild(list);
    return section;
  }

  function buildRecentRow(archived: ArchivedSession): HTMLElement {
    const row = document.createElement('div');
    row.className = 'widget-sessions-row widget-sessions-row-recent';
    row.title = archived.cliSessionId ? 'Click to resume' : 'No CLI session id — cannot resume';

    if (archived.bookmarked) {
      const bookmark = document.createElement('span');
      bookmark.className = 'widget-sessions-bookmark';
      bookmark.textContent = '★';
      bookmark.title = 'Bookmarked';
      row.appendChild(bookmark);
    }

    const main = document.createElement('div');
    main.className = 'widget-sessions-row-main';

    const name = document.createElement('div');
    name.className = 'widget-sessions-row-name';
    name.textContent = archived.name;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'widget-sessions-row-meta';

    const provider = document.createElement('span');
    provider.className = 'widget-sessions-provider';
    provider.textContent = getProviderDisplayName(archived.providerId);
    meta.appendChild(provider);

    const date = document.createElement('span');
    date.className = 'widget-sessions-date';
    date.textContent = formatRelativeDate(archived.closedAt);
    date.title = new Date(archived.closedAt).toLocaleString();
    meta.appendChild(date);

    if (archived.cost && archived.cost.totalCostUsd > 0) {
      const cost = document.createElement('span');
      cost.className = 'widget-sessions-cost';
      cost.textContent = `$${archived.cost.totalCostUsd.toFixed(2)}`;
      meta.appendChild(cost);
    }

    main.appendChild(meta);
    row.appendChild(main);

    if (archived.cliSessionId) {
      row.addEventListener('click', () => {
        appState.resumeFromHistory(host.projectId, archived.id);
      });
    } else {
      row.classList.add('disabled');
    }

    return row;
  }

  function findActiveRow(sessionId: string): HTMLElement | null {
    return body.querySelector<HTMLElement>(
      `.widget-sessions-row-active[data-session-id="${sessionId}"]`,
    );
  }

  function updateRowStatus(sessionId: string, status: SessionStatus): void {
    const dot = findActiveRow(sessionId)?.querySelector<HTMLElement>('.tab-status');
    if (dot) dot.className = `tab-status ${status}`;
  }

  function updateRowCost(sessionId: string): void {
    const costEl = findActiveRow(sessionId)?.querySelector<HTMLElement>('.widget-sessions-cost');
    if (costEl) costEl.textContent = formatCost(sessionId);
  }

  function updateUnreadFlags(): void {
    const project = appState.projects.find((p) => p.id === host.projectId);
    if (!project) return;
    for (const session of project.sessions) {
      const nameEl = findActiveRow(session.id)?.querySelector<HTMLElement>('.widget-sessions-row-name');
      nameEl?.classList.toggle('unread', isUnread(session.id));
    }
  }

  const offAdded = appState.on('session-added', () => render());
  const offRemoved = appState.on('session-removed', () => render());
  const offChanged = appState.on('session-changed', () => render());
  const offHistory = appState.on('history-changed', () => render());
  const offStatus = onStatusChange(updateRowStatus);
  const offCost = onCostChange(updateRowCost);
  const offUnread = onUnreadChange(updateUnreadFlags);

  render();

  return {
    element: root,
    destroy() {
      offAdded();
      offRemoved();
      offChanged();
      offHistory();
      offStatus();
      offCost();
      offUnread();
    },
    refresh() {
      render();
    },
  };
};

function formatCost(sessionId: string): string {
  const cost = getCost(sessionId);
  if (!cost || cost.totalCostUsd <= 0) return '';
  const totalTokens = cost.totalInputTokens + cost.totalOutputTokens;
  const tokens = totalTokens > 0 ? ` · ${formatTokens(totalTokens)}` : '';
  return `$${cost.totalCostUsd.toFixed(2)}${tokens}`;
}

function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
