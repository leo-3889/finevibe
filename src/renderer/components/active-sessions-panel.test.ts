// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectActiveSessions, initActiveSessions, rowHtml, type ActiveSessionRow } from './active-sessions-panel.js';
import { appState } from '../state.js';
import type { SessionStatus } from '../session-activity.js';
import type { ProjectRecord, ProviderId } from '../../shared/types.js';

// Minimal project/session factory — only the fields the selector reads.
const project = (
  id: string,
  name: string,
  sessions: Array<{ id: string; name?: string; type?: string; providerId?: ProviderId }>,
): ProjectRecord =>
  ({
    id,
    name,
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      type: s.type,
      providerId: s.providerId,
      cliSessionId: null,
      createdAt: new Date().toISOString(),
    })),
  } as unknown as ProjectRecord);

const statusMap = (m: Record<string, SessionStatus>) => (id: string): SessionStatus => m[id] ?? 'idle';

// Host-meta stub for the pure selector: Local is neutral, hosts carry colors.
const hostMeta = (m: Record<string, { name: string; color: string }>) =>
  (hostId: string) => m[hostId] ?? { name: hostId === 'local' ? 'Local' : hostId, color: '' };

describe('selectActiveSessions', () => {
  it('lists every open CLI session across all projects, regardless of status', () => {
    const projects = [
      project('p1', 'Alpha', [
        { id: 's1' },
        { id: 's2' },
        { id: 's3' },
        { id: 's4' },
      ]),
      project('p2', 'Beta', [{ id: 's5' }]),
    ];
    const statusOf = statusMap({ s1: 'working', s2: 'waiting', s3: 'completed', s4: 'input', s5: 'idle' });

    const rows = selectActiveSessions(projects, statusOf);

    // Every open session is listed — waiting and idle included.
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(rows.find((r) => r.sessionId === 's2')!.status).toBe('waiting');
    expect(rows.find((r) => r.sessionId === 's5')!.status).toBe('idle');
  });

  it('excludes non-CLI sessions (those with a type set)', () => {
    const projects = [
      project('p1', 'Alpha', [
        { id: 'cli' },
        { id: 'shell', type: 'shell' },
      ]),
    ];

    const rows = selectActiveSessions(projects, statusMap({}));

    expect(rows.map((r) => r.sessionId)).toEqual(['cli']);
  });

  it('aggregates across all projects with project names', () => {
    const projects = [
      project('p1', 'Alpha', [{ id: 's1' }]),
      project('p2', 'Beta', [{ id: 's2' }]),
    ];

    const rows = selectActiveSessions(projects, statusMap({}));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.projectId, r.projectName, r.sessionId].join('/')).sort()).toEqual([
      'p1/Alpha/s1',
      'p2/Beta/s2',
    ]);
  });

  it('orders by status priority (input > working > waiting > completed > idle), then project name, then session name', () => {
    const projects = [
      project('p1', 'Alpha', [
        { id: 'idle-a', name: 'zeta' },
        { id: 'input-a', name: 'alpha' },
        { id: 'working-a', name: 'mid' },
      ]),
      project('p2', 'Beta', [
        { id: 'input-b', name: 'beta' },
        { id: 'completed-b', name: 'omega' },
      ]),
    ];
    const statusOf = statusMap({
      'idle-a': 'idle',
      'input-a': 'input',
      'working-a': 'working',
      'input-b': 'input',
      'completed-b': 'completed',
    });

    const rows = selectActiveSessions(projects, statusOf);

    expect(rows.map((r) => r.sessionId)).toEqual(['input-a', 'input-b', 'working-a', 'completed-b', 'idle-a']);
  });

  it('returns empty for no projects or no sessions', () => {
    expect(selectActiveSessions([], statusMap({}))).toEqual([]);
    expect(selectActiveSessions([project('p1', 'Alpha', [])], statusMap({}))).toEqual([]);
  });

  // T4 / UR-7: the panel is cross-host (per-host plan §5 amends parent §11).
  describe('cross-host (plan §5)', () => {
    const on = (p: ProjectRecord, hostId: string): ProjectRecord => ({ ...p, hostId });
    const hosts = {
      local: { name: 'Local', color: '' },
      hA: { name: 'zen', color: '#4c9aff' },
      hB: { name: 'box', color: '#ff8a4c' },
    };

    it('never filters by host: rows carry hostId, hostName and hostColor from all hosts', () => {
      const projects = [
        on(project('p1', 'Alpha', [{ id: 's1' }]), 'hA'),
        project('p2', 'Beta', [{ id: 's2' }]), // hostId absent → local
        on(project('p3', 'Gamma', [{ id: 's3' }]), 'hB'),
      ];

      const rows = selectActiveSessions(projects, statusMap({}), hostMeta(hosts));

      expect(rows.map((r) => [r.sessionId, r.hostId, r.hostName, r.hostColor].join('/')).sort()).toEqual([
        's1/hA/zen/#4c9aff',
        's2/local/Local/',
        's3/hB/box/#ff8a4c',
      ]);
    });

    it('orders urgency → host (Local first) → project → session', () => {
      const projects = [
        on(project('p1', 'Zeta', [{ id: 'z1', name: 'zwork' }]), 'hA'),
        on(project('p2', 'Alpha', [{ id: 'a1', name: 'awork' }]), 'hB'),
        project('p3', 'Local', [{ id: 'l1', name: 'lwork' }, { id: 'l2', name: 'linput' }]),
      ];
      const statusOf = statusMap({ z1: 'working', a1: 'working', l1: 'working', l2: 'input' });

      const rows = selectActiveSessions(projects, statusOf, hostMeta(hosts));

      // Input outranks everything; within `working` Local leads, then the
      // host display names (box < zen).
      expect(rows.map((r) => r.sessionId)).toEqual(['l2', 'l1', 'a1', 'z1']);
    });

    it('rowHtml carries the host chip only for a validated color', () => {
      const row: ActiveSessionRow = {
        projectId: 'p1', projectName: 'Alpha', sessionId: 's1', sessionName: 'work',
        status: 'working', hostId: 'hA', hostName: 'zen', hostColor: '#4c9aff',
      };
      const html = rowHtml(row);
      expect(html).toContain('class="host-chip" style="background:#4c9aff"');
      expect(html).toContain('title="Alpha · zen"');

      const local = rowHtml({ ...row, hostId: 'local', hostName: 'Local', hostColor: '' });
      expect(local).not.toContain('host-chip');

      const junk = rowHtml({ ...row, hostColor: 'red;background:url(x)' as string });
      expect(junk).not.toContain('host-chip');
    });
  });
});

// P2-102: the row markup interpolates esc() inside quoted attributes
// (data-project-id, data-session-id, title) and into text nodes. The DOM text
// serializer never escaped `"`, so a quoted value closed its attribute and
// injected markup. The rows are rendered through the public path —
// initActiveSessions over real appState — with quote payloads riding the
// user-controlled fields that reach the markup (project/session names).
describe('active session row attribute safety', () => {
  const created: string[] = [];

  beforeEach(() => {
    document.body.innerHTML = '<div id="sidebar-active-sessions"></div>';
  });

  afterEach(() => {
    for (const id of created.splice(0)) appState.removeProject(id);
  });

  it('renders quoted names as literals that cannot break the attributes', () => {
    const name = 'proj"x " onmouseover="alert(1)';
    const alpha = appState.addProject(name, '/alpha');
    const beta = appState.addProject('Beta', '/beta');
    created.push(alpha.id, beta.id);
    appState.addSession(alpha.id, 'name"y');

    initActiveSessions();

    const container = document.getElementById('sidebar-active-sessions')!;
    expect(container.querySelectorAll('.active-session-row')).toHaveLength(1);
    const row = container.querySelector('.active-session-row')!;
    // Pre-fix the payload closed title="..." and parsed as a live attribute.
    // Local rows carry the bare project name (audit T4 #3: no `· Local`
    // churn for local-only users); the host suffix rides remote rows only.
    expect(row.getAttribute('title')).toBe(name);
    expect(row.getAttribute('onmouseover')).toBeNull();
    expect(container.querySelector('[onmouseover]')).toBeNull();
    // The delegated click handler routes on the dataset — ids round-trip.
    expect(row.dataset.projectId).toBe(alpha.id);
    expect(row.querySelector('.active-session-name')!.textContent).toBe('name"y');
  });

  it('keeps the row text readable when the escaper serializes quotes', () => {
    const alpha = appState.addProject('a "quoted" repo', '/alpha');
    const beta = appState.addProject('Beta', '/beta');
    created.push(alpha.id, beta.id);
    appState.addSession(alpha.id, 'fix "x" bug');

    initActiveSessions();

    const container = document.getElementById('sidebar-active-sessions')!;
    expect(container.querySelector('.active-session-name')!.textContent).toBe('fix "x" bug');
    expect(container.querySelector('.active-session-project')!.textContent).toBe('a "quoted" repo');
  });
});
