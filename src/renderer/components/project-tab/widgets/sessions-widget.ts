import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { getProviderDisplayName } from '../../../provider-availability.js';
import type { WidgetFactory } from './widget-host.js';
import { DEFAULT_SESSIONS_CONFIG, type SessionsConfig } from './sessions-types.js';
import { showSessionHistoryDialog } from './sessions-dialog.js';

export const createSessionsWidget: WidgetFactory = (host) => {
  const root = document.createElement('div');
  root.className = 'widget-sessions';

  const body = document.createElement('div');
  body.className = 'widget-sessions-body';
  root.appendChild(body);

  function render(): void {
    body.innerHTML = '';

    const cfg = host.getConfig<Partial<SessionsConfig>>();
    const recentLimit = typeof cfg.recentLimit === 'number'
      ? cfg.recentLimit
      : DEFAULT_SESSIONS_CONFIG.recentLimit;

    const fullHistory = appState.getSessionHistory(host.projectId)
      .slice()
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    const history = fullHistory.slice(0, recentLimit);

    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'widget-sessions-recent-empty';
      empty.textContent = 'No archived sessions yet.';
      body.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'widget-sessions-list';
      for (const archived of history) {
        list.appendChild(buildRecentRow(archived));
      }
      body.appendChild(list);
    }

    if (fullHistory.length > recentLimit) {
      const project = appState.projects.find((p) => p.id === host.projectId);
      if (!project) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'widget-sessions-view-all-btn';
      btn.textContent = `View all ${fullHistory.length} sessions →`;
      btn.addEventListener('click', () => showSessionHistoryDialog(project));
      body.appendChild(btn);
    }
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

  const offHistory = appState.on('history-changed', () => render());

  render();

  return {
    element: root,
    destroy() {
      offHistory();
    },
    refresh() {
      render();
    },
  };
};

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
