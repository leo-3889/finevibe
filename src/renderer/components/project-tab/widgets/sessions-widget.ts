import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { getProviderDisplayName } from '../../../provider-availability.js';
import type { WidgetFactory } from './widget-host.js';
import { DEFAULT_SESSIONS_CONFIG, type SessionsConfig } from './sessions-types.js';
import { showSessionHistoryDialog } from './sessions-dialog.js';
import { formatRelativeDate } from '../../../../shared/text-utils.js';

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

    // Active rows have no closedAt — sort on the same effective timestamp
    // the display line uses, or new Running rows sort last and slice out.
    const fullHistory = appState.getSessionHistory(host.projectId)
      .slice()
      .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt));
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
    date.textContent = formatRelativeDate(archived.closedAt ?? archived.createdAt);
    date.title = new Date(archived.closedAt ?? archived.createdAt).toLocaleString();
    meta.appendChild(date);

    if (archived.cost && archived.cost.totalCostUsd > 0) {
      const cost = document.createElement('span');
      cost.className = 'widget-sessions-cost';
      cost.textContent = `$${archived.cost.totalCostUsd.toFixed(2)}`;
      meta.appendChild(cost);
    }

    main.appendChild(meta);
    row.appendChild(main);

    const isBookmarked = archived.bookmarked === true;
    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.type = 'button';
    bookmarkBtn.className = `widget-sessions-bookmark-btn${isBookmarked ? ' bookmarked' : ''}`;
    bookmarkBtn.textContent = isBookmarked ? '★' : '☆';
    bookmarkBtn.title = isBookmarked ? 'Remove bookmark' : 'Bookmark session';
    bookmarkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.toggleBookmark(host.projectId, archived.id);
    });
    row.appendChild(bookmarkBtn);

    // Live rows finalize on close; deleting the bookmark hides the running
    // session and re-archives it under a new id ("Running rows survive").
    if (archived.state !== 'active') {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'widget-sessions-remove-btn';
      removeBtn.innerHTML = '&times;';
      removeBtn.title = 'Remove from history';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        appState.removeHistoryEntry(host.projectId, archived.id);
      });
      row.appendChild(removeBtn);
    }

    if (archived.cliSessionId) {
      row.addEventListener('click', () => {
        void appState.resumeFromHistorySafe(host.projectId, archived.id);
      });
    } else {
      row.classList.add('disabled');
    }

    return row;
  }

  const offHistory = appState.on('history-changed', (data) => {
    // Payload is the owning projectId (readiness-widget idiom): a sibling
    // project's history write must not re-render this widget.
    const id = typeof data === 'string' ? data : undefined;
    if (id && id !== host.projectId) return;
    render();
  });

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
