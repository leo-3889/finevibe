import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import { getProviderDisplayName } from '../../../provider-availability.js';
import type { WidgetFactory } from './widget-host.js';
import { formatRelativeDate } from '../../../../shared/text-utils.js';

export const createFavoriteSessionsWidget: WidgetFactory = (host) => {
  const root = document.createElement('div');
  root.className = 'widget-sessions';

  const body = document.createElement('div');
  body.className = 'widget-sessions-body';
  root.appendChild(body);

  function render(): void {
    const project = appState.projects.find((p) => p.id === host.projectId);
    body.innerHTML = '';

    const favorites = (project?.sessionHistory ?? [])
      .filter((a) => a.bookmarked === true)
      .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt));

    if (favorites.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'widget-sessions-recent-empty';
      empty.textContent = 'No favorite sessions yet.';
      body.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'widget-sessions-list';
    for (const archived of favorites) {
      list.appendChild(buildRow(archived));
    }
    body.appendChild(list);
  }

  function buildRow(archived: ArchivedSession): HTMLElement {
    const row = document.createElement('div');
    row.className = 'widget-sessions-row widget-sessions-row-recent';
    row.title = archived.cliSessionId ? 'Click to resume' : 'No CLI session id — cannot resume';

    const bookmark = document.createElement('span');
    bookmark.className = 'widget-sessions-bookmark';
    bookmark.textContent = '★';
    bookmark.title = 'Bookmarked';
    row.appendChild(bookmark);

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

    const removeBtn = document.createElement('button');
    removeBtn.className = 'widget-sessions-remove-btn';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove from favorites';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.toggleBookmark(host.projectId, archived.id);
    });
    row.appendChild(removeBtn);

    if (archived.cliSessionId) {
      row.addEventListener('click', () => {
        void appState.resumeFromHistorySafe(host.projectId, archived.id);
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
