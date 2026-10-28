import { appState } from '../state.js';
import { ProjectRecord, LOCAL_HOST_ID } from '../../shared/types.js';
import { getStatus, SessionStatus, onChange as onActivityChange, STATUS_GLYPH } from '../session-activity.js';
import { STATUS_PRIORITY } from '../project-status.js';
import { isCliSession } from '../session-utils.js';
import { esc } from '../dom-utils.js';
import { t } from '../i18n.js';
import { getHostColor, getHostName, onHostsChange } from '../host-registry.js';
import { hostChipHtml } from '../host-scope.js';

export interface ActiveSessionRow {
  projectId: string;
  projectName: string;
  sessionId: string;
  sessionName: string;
  status: SessionStatus;
  /** Host the session runs on ('local' normalized at load); cross-host —
   * the panel never filters by the active host tab (per-host plan §5, UR-7). */
  hostId: string;
  /** Host display name (Local = translated neutral label). */
  hostName: string;
  /** Validated identity color, '' for Local / unset (plan §5/§7). */
  hostColor: string;
}

/** Host display data the selector needs; injectable so tests stay pure. */
type HostMetaOf = (hostId: string) => { name: string; color: string };

const registryHostMeta: HostMetaOf = (hostId) => ({ name: getHostName(hostId), color: getHostColor(hostId) });


/**
 * Pure selector: gather every open CLI session across all projects of all
 * hosts, ordered by urgency (`STATUS_PRIORITY`) then host (Local first) then
 * project name then session name. Live status is display and ordering only —
 * it never hides a row. The panel is cross-host: no host filter is applied
 * here (per-host plan §5 amends parent §11). DOM-free so it can be
 * unit-tested.
 */
export function selectActiveSessions(
  projects: ProjectRecord[],
  statusOf: (sessionId: string) => SessionStatus,
  hostMetaOf: HostMetaOf = registryHostMeta,
): ActiveSessionRow[] {
  const rows: ActiveSessionRow[] = [];
  for (const project of projects) {
    const hostId = project.hostId ?? LOCAL_HOST_ID;
    const host = hostMetaOf(hostId);
    for (const session of project.sessions) {
      if (!isCliSession(session)) continue;
      rows.push({
        projectId: project.id,
        projectName: project.name,
        sessionId: session.id,
        sessionName: session.name,
        status: statusOf(session.id),
        hostId,
        hostName: host.name,
        hostColor: host.color,
      });
    }
  }
  rows.sort((a, b) => {
    // idle is not in STATUS_PRIORITY — rank it after completed, not before input.
    const rank = (s: SessionStatus) => {
      const i = STATUS_PRIORITY.indexOf(s);
      return i === -1 ? STATUS_PRIORITY.length : i;
    };
    const pa = rank(a.status);
    const pb = rank(b.status);
    if (pa !== pb) return pa - pb;
    // urgency → host → project → session (plan §5); Local sorts first.
    const hostOrder = (a.hostId === LOCAL_HOST_ID ? 0 : 1) - (b.hostId === LOCAL_HOST_ID ? 0 : 1);
    if (hostOrder !== 0) return hostOrder;
    const hn = a.hostName.localeCompare(b.hostName);
    if (hn !== 0) return hn;
    const pn = a.projectName.localeCompare(b.projectName);
    if (pn !== 0) return pn;
    return a.sessionName.localeCompare(b.sessionName);
  });
  return rows;
}

let containerEl: HTMLElement | null = null;

/** Rebuild the sidebar Active Sessions section from current state. */
function renderActiveSessions(): void {
  if (!containerEl) return;

  // Never wipe DOM mid-selection (mirrors the ui-dev re-render guard).
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed && containerEl.contains(sel.anchorNode)) {
    return;
  }

  const enabled = appState.sidebarView('activeSessions') && appState.projects.length > 1;
  const rows = enabled ? selectActiveSessions(appState.projects, getStatus) : [];

  if (rows.length === 0) {
    containerEl.classList.add('hidden');
    containerEl.innerHTML = '';
    return;
  }

  containerEl.classList.remove('hidden');
  // Cross-host: one separator line where the host changes (rows arrive
  // host-grouped from the selector), carrying the non-color redundancy the
  // palette-accessibility risk demands (plan §10 R5). Single-host lists get
  // NO separators — a local-only user's panel stays byte-identical (audit T4 #2).
  const multiHost = new Set(rows.map((r) => r.hostId)).size > 1;
  let lastHostId = '';
  const body = rows.map((row) => {
    const sep = multiHost && row.hostId !== lastHostId
      ? `<div class="active-session-host-sep">${esc(t('sidebar.activeSessions.hostSeparator', { host: row.hostName }))}</div>`
      : '';
    lastHostId = row.hostId;
    return sep + rowHtml(row);
  }).join('');
  // pi-lens-ignore: xss-innerhtml, slop, no-inner-html
  containerEl.innerHTML = `
    <div class="active-sessions-header">
      <span class="active-sessions-title">${esc(t('sidebar.activeSessions.title'))}</span>
      <span class="active-sessions-count">${rows.length}</span>
    </div>
    <div class="active-sessions-list">
      ${body}
    </div>
  `;
}

/** One panel row: status glyph, host chip, session, project. Exported for
 * the chip-builder test. */
export function rowHtml(row: ActiveSessionRow): string {
  // The host suffix rides the title only for remote rows — local-only titles
  // stay byte-identical to pre-Phase-2 (audit T4 #3).
  const title = row.hostId === LOCAL_HOST_ID ? row.projectName : `${row.projectName} · ${row.hostName}`;
  return `
    <div class="active-session-row" data-project-id="${esc(row.projectId)}" data-session-id="${esc(row.sessionId)}" title="${esc(title)}">
      <span class="project-status ${row.status}" aria-hidden="true">${STATUS_GLYPH[row.status]}</span>
      ${hostChipHtml(row.hostColor, row.hostName)}
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
  // Host colors arrive async with the registry cache; repaint rows on change.
  onHostsChange(scheduleRender);
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
