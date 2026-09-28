import { describe, it, expect } from 'vitest';
import { selectActiveSessions, resolveActiveStatuses } from './active-sessions-panel.js';
import type { SessionStatus } from '../session-activity.js';
import type { ProjectRecord, Preferences, ProviderId } from '../../shared/types.js';

// Minimal project/session factory — only the fields the selector reads.
// Sessions default to a status-reporting provider (claude); pass providerId
// 'omp'/'pi' for the hook-less ones.
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
      providerId: s.providerId ?? 'claude',
    })),
  } as unknown as ProjectRecord);

const statusMap = (m: Record<string, SessionStatus>) => (id: string): SessionStatus => m[id] ?? 'idle';
// Mirrors the real gate: hookStatus (claude) OR polledStatus (omp/pi).
const reportsStatus = (providerId: ProviderId | undefined): boolean =>
  providerId === 'claude' || providerId === 'omp' || providerId === 'pi';
// A provider with no status source at all (neither hooks nor polling).
const reportsNothing = (providerId: ProviderId | undefined): boolean => providerId === 'claude';

describe('selectActiveSessions', () => {
  it('keeps only sessions whose status is in the active set', () => {
    const projects = [project('p1', 'Alpha', [
      { id: 'a' }, { id: 'b' }, { id: 'c' },
    ])];
    const rows = selectActiveSessions(
      projects,
      statusMap({ a: 'working', b: 'idle', c: 'completed' }),
      new Set<SessionStatus>(['working', 'completed']),
      reportsStatus,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'c']);
  });

  it('excludes non-CLI sessions (those with a type set)', () => {
    const projects = [project('p1', 'Alpha', [
      { id: 'cli' },
      { id: 'kanban', type: 'kanban' },
      { id: 'team', type: 'team' },
    ])];
    const rows = selectActiveSessions(
      projects,
      statusMap({ cli: 'working', kanban: 'working', team: 'working' }),
      new Set<SessionStatus>(['working']),
      reportsStatus,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['cli']);
  });

  it('aggregates across all projects', () => {
    const projects = [
      project('p1', 'Alpha', [{ id: 'a' }]),
      project('p2', 'Beta', [{ id: 'b' }]),
    ];
    const rows = selectActiveSessions(
      projects,
      statusMap({ a: 'working', b: 'input' }),
      new Set<SessionStatus>(['working', 'input']),
      reportsStatus,
    );
    expect(rows.map((r) => r.projectId).sort()).toEqual(['p1', 'p2']);
  });

  it('orders by status priority (input > working > waiting > completed), then project name', () => {
    const projects = [
      project('p1', 'Zeta', [{ id: 'w' }]),
      project('p2', 'Alpha', [{ id: 'i' }]),
      project('p3', 'Mid', [{ id: 'c' }]),
      project('p4', 'Beta', [{ id: 'w2' }]),
    ];
    const rows = selectActiveSessions(
      projects,
      statusMap({ w: 'working', i: 'input', c: 'completed', w2: 'working' }),
      new Set<SessionStatus>(['working', 'input', 'completed']),
      reportsStatus,
    );
    // input first, then the two working (tie broken by project name Beta < Zeta), then completed.
    expect(rows.map((r) => r.sessionId)).toEqual(['i', 'w2', 'w', 'c']);
  });

  it('returns empty when the active set is empty', () => {
    const projects = [project('p1', 'Alpha', [{ id: 'a' }])];
    expect(selectActiveSessions(projects, statusMap({ a: 'working' }), new Set(), reportsStatus)).toEqual([]);
  });

  it('filters polled-status providers by status, like hook providers', () => {
    // OMP/Pi now derive a real status from their transcript, so the active
    // set applies to them: a working session shows, a completed one shows
    // (it's in the default active set), and an exited (idle) one stays hidden.
    const projects = [project('p1', 'Alpha', [
      { id: 'omp-working', providerId: 'omp' },
      { id: 'pi-completed', providerId: 'pi' },
      { id: 'omp-exited', providerId: 'omp' },
    ])];
    const rows = selectActiveSessions(
      projects,
      statusMap({ 'omp-working': 'working', 'pi-completed': 'completed', 'omp-exited': 'idle' }),
      new Set<SessionStatus>(['working', 'input', 'completed']),
      reportsStatus,
    );
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['omp-working', 'pi-completed']);
  });

  it('lists open sessions of a no-status-source provider, but not exited (idle) ones', () => {
    // A provider with neither hooks nor polling has no status signal, so the
    // filter can't distinguish working from idle — show it while the PTY is
    // open, hide it once it exits (idle).
    const projects = [project('p1', 'Alpha', [
      { id: 'ghost-open', providerId: 'ghost' },
      { id: 'ghost-exited', providerId: 'ghost' },
    ])];
    const rows = selectActiveSessions(
      projects,
      statusMap({ 'ghost-open': 'waiting', 'ghost-exited': 'idle' }),
      new Set<SessionStatus>(['working', 'input', 'completed']),
      reportsNothing,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(['ghost-open']);
  });

  it('still filters status-reporting providers while keeping no-status ones', () => {
    const projects = [project('p1', 'Alpha', [
      { id: 'claude-idle', providerId: 'claude' },
      { id: 'claude-working', providerId: 'claude' },
      { id: 'ghost', providerId: 'ghost' },
    ])];
    const rows = selectActiveSessions(
      projects,
      statusMap({ 'claude-idle': 'idle', 'claude-working': 'working', ghost: 'waiting' }),
      new Set<SessionStatus>(['working']),
      reportsNothing,
    );
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['claude-working', 'ghost']);
  });
});

describe('resolveActiveStatuses', () => {
  it('falls back to working/input/completed when unset', () => {
    const set = resolveActiveStatuses({} as Preferences);
    expect([...set].sort()).toEqual(['completed', 'input', 'working']);
  });

  it('reflects the configured flags', () => {
    const set = resolveActiveStatuses({
      activeSessionStatuses: { working: true, waiting: true, input: false, completed: false },
    } as Preferences);
    expect([...set].sort()).toEqual(['waiting', 'working']);
  });
});
