import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import type { WidgetFactory } from './widget-host.js';
import { buildSessionRow } from './session-row.js';

// C3RP-16: hard render cap, mirroring the sessions widget's recentLimit —
// favorites grow unbounded in the archive; the dialog is the browse surface.
const FAVORITES_RENDER_LIMIT = 50;
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
      .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
      .slice(0, FAVORITES_RENDER_LIMIT);

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
    const bookmark = document.createElement('span');
    bookmark.className = 'widget-sessions-bookmark';
    bookmark.textContent = '★';
    bookmark.title = 'Bookmarked';

    const removeBtn = document.createElement('button');
    removeBtn.className = 'widget-sessions-remove-btn';
    removeBtn.innerHTML = '&times;';
    removeBtn.title = 'Remove from favorites';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appState.toggleBookmark(host.projectId, archived.id);
    });

    // Row 28: skeleton shared with the sessions widget via session-row.ts.
    return buildSessionRow(archived, host.projectId, { leading: bookmark, trailing: [removeBtn] });
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
