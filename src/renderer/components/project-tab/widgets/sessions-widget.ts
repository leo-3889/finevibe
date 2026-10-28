import type { ArchivedSession } from '../../../../shared/types.js';
import { appState } from '../../../state.js';
import type { WidgetFactory } from './widget-host.js';
import { DEFAULT_SESSIONS_CONFIG, type SessionsConfig } from './sessions-types.js';
import { showSessionHistoryDialog } from './sessions-dialog.js';
import { buildSessionRow } from './session-row.js';

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

    const trailing: HTMLElement[] = [bookmarkBtn];
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
      trailing.push(removeBtn);
    }

    // Row 28: the skeleton (name/provider/date/cost + resume click) is the
    // favorite widget's, shared through session-row.ts.
    return buildSessionRow(archived, host.projectId, { trailing });
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
