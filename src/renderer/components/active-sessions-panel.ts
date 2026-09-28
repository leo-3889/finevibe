import { appState } from '../state.js';
import { ProjectRecord, Preferences, ProviderId } from '../../shared/types.js';
import { getStatus, SessionStatus, onChange as onActivityChange, STATUS_GLYPH } from '../session-activity.js';
import { STATUS_PRIORITY } from '../project-status.js';
import { isCliSession } from '../session-utils.js';
import { getProviderCapabilities } from '../provider-availability.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';

export interface ActiveSessionRow {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionName: string;
  status: SessionStatus;
}

type ActiveStatusConfig = NonNullable<Preferences['activeSessionStatuses']>;

/** The status keys a session can be filtered on, and the canonical default set. */
export const ACTIVE_STATUS_KEYS = ['working', 'waiting', 'input', 'completed'] as const;
export const DEFAULT_ACTIVE_SESSION_STATUSES: ActiveStatusConfig = {
  working: true,
  waiting: false,
  input: true,
  completed: true,
};

/** Resolve the configured set of statuses that count as "active". */
export function resolveActiveStatuses(prefs: Preferences): Set<SessionStatus> {
  const cfg = prefs.activeSessionStatuses ?? DEFAULT_ACTIVE_SESSION_STATUSES;
  return new Set(ACTIVE_STATUS_KEYS.filter((k) => cfg[k]));
}

/**
 * Pure selector: gather every open CLI session across all projects whose live
 * status is in `activeStatuses`, ordered by urgency (`STATUS_PRIORITY`) then
 * project name. DOM-free so it can be unit-tested.
 *
 * `reportsStatusOf` says whether a provider emits a live status at all —
 * via hooks (`hookStatus`) or transcript polling (`polledStatus`). Providers
 * that report one are filtered by `activeStatuses` like any other. A provider
 * with neither has no status signal, so the filter can't distinguish working
 * from idle: an open session there is listed regardless, and only an `idle`
 * (PTY-exited) one is dropped.
 */
export function selectActiveSessions(
  projects: ProjectRecord[],
  statusOf: (sessionId: string) => SessionStatus,
  activeStatuses: Set<SessionStatus>,
  reportsStatusOf: (providerId: ProviderId | undefined) => boolean,
): ActiveSessionRow[] {
  const rows: ActiveSessionRow[] = [];
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!isCliSession(session)) continue;
      const status = statusOf(session.id);
      if (reportsStatusOf(session.providerId)) {
        if (!activeStatuses.has(status)) continue;
      } else if (status === 'idle') {
        // No status source: 'idle' is the only "not open" state we can see.
        continue;
      }
      rows.push({
        projectId: project.id,
        projectName: project.name,
        sessionId: session.id,
        sessionName: session.name,
        status,
      });
    }
  }
  rows.sort((a, b) => {
    const pa = STATUS_PRIORITY.indexOf(a.status);
    const pb = STATUS_PRIORITY.indexOf(b.status);
    if (pa !== pb) return pa - pb;
    return a.projectName.localeCompare(b.projectName);
  });
  return rows;
}

let containerEl: HTMLElement | null = null;

/** Rebuild the sidebar Active Sessions section from current state. */
export function renderActiveSessions(): void {
  if (!containerEl) return;

  // Never wipe DOM mid-selection (mirrors the ui-dev re-render guard).
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && containerEl.contains(sel.anchorNode)) {
    return;
  }

  // Only meaningful across multiple projects — with a single project the rows
  // just duplicate that project's own tab bar, so the section stays hidden.
  const enabled =
    (appState.preferences.sidebarViews?.activeSessions ?? true) && appState.projects.length > 1;
  const rows = enabled
    ? selectActiveSessions(
        appState.projects,
        getStatus,
        resolveActiveStatuses(appState.preferences),
        (providerId) => {
          const caps = getProviderCapabilities(providerId ?? 'claude');
          return caps?.hookStatus === true || caps?.polledStatus === true;
        },
      )
    : [];

  if (rows.length === 0) {
    containerEl.classList.add('hidden');
    containerEl.innerHTML = '';
    return;
  }

  containerEl.classList.remove('hidden');
  containerEl.innerHTML = `
    <div class="active-sessions-header">
      <span class="active-sessions-title">${esc(t('sidebar.activeSessions.title'))}</span>
      <span class="active-sessions-count">${rows.length}</span>
    </div>
    <div class="active-sessions-list">
      ${rows.map(rowHtml).join('')}
    </div>
  `;
}

function rowHtml(row: ActiveSessionRow): string {
  return `
    <div class="active-session-row" data-project-id="${esc(row.projectId)}" data-session-id="${esc(row.sessionId)}" title="${esc(row.projectName)}">
      <span class="project-status ${row.status}" aria-hidden="true">${STATUS_GLYPH[row.status]}</span>
      <span class="active-session-name">${esc(row.sessionName)}</span>
      <span class="active-session-project">${esc(row.projectName)}</span>
    </div>
  `;
}

// Coalesce the many event sources that can invalidate the panel into a single
// rebuild per frame — a burst (e.g. state-loaded plus a wave of session-added)
// collapses to one render.
let renderScheduled = false;
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderActiveSessions();
  });
}

/** Wire the sidebar Active Sessions section; call once at startup. */
export function initActiveSessions(): void {
  containerEl = document.getElementById('sidebar-active-sessions');
  if (!containerEl) return;

  // One delegated click listener survives every innerHTML rebuild.
  containerEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.active-session-row');
    const projectId = row?.dataset.projectId;
    const sessionId = row?.dataset.sessionId;
    if (!projectId || !sessionId) return;
    appState.setActiveProject(projectId);
    appState.setActiveSession(projectId, sessionId);
  });

  onActivityChange(scheduleRender);
  for (const event of [
    'session-added',
    'session-removed',
    'session-changed',
    'project-added',
    'project-changed',
    'project-removed',
    'state-loaded',
    'preferences-changed',
  ] as const) {
    appState.on(event, scheduleRender);
  }

  renderActiveSessions();
}
