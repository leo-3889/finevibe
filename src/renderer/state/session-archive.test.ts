import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
}));

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});
import { archiveSession, archiveSessionOnCreate, buildResumedSession, buildResumedSessionFromCliId, findCreateEntry, syncCreateEntryCliId } from './session-archive';
import type { ArchivedSession, ProjectRecord, SessionRecord } from '../../shared/types';

beforeEach(() => {
  uuidCounter = 0;
});

function makeProject(): ProjectRecord {
  return {
    id: 'p1',
    name: 'P',
    path: '/tmp/p',
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  };
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    name: 'Session 1',
    providerId: 'claude',
    cliSessionId: 'cli-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildResumedSessionFromCliId()', () => {
  it('creates a SessionRecord with the given cliSessionId', () => {
    const session = buildResumedSessionFromCliId('cli-abc-123', 'My Session');
    expect(session.cliSessionId).toBe('cli-abc-123');
    expect(session.name).toBe('My Session');
  });

  it('defaults providerId to claude', () => {
    const session = buildResumedSessionFromCliId('cli-xyz', 'Test');
    expect(session.providerId).toBe('claude');
  });

  it('accepts an explicit providerId', () => {
    const session = buildResumedSessionFromCliId('cli-xyz', 'Test', 'codex');
    expect(session.providerId).toBe('codex');
  });

  it('generates a unique id each call', () => {
    const a = buildResumedSessionFromCliId('cli-1', 'A');
    const b = buildResumedSessionFromCliId('cli-2', 'B');
    expect(a.id).not.toBe(b.id);
  });

  it('sets createdAt to a valid ISO timestamp', () => {
    const before = new Date().toISOString();
    const session = buildResumedSessionFromCliId('cli-t', 'T');
    const after = new Date().toISOString();
    expect(session.createdAt >= before).toBe(true);
    expect(session.createdAt <= after).toBe(true);
  });

  it('does not set type field (plain CLI session)', () => {
    const session = buildResumedSessionFromCliId('cli-t', 'T');
    expect((session as Record<string, unknown>).type).toBeUndefined();
  });
});

describe('teamMemberId propagation', () => {
  it('archiveSession copies teamMemberId from session into the archive entry', () => {
    const project = makeProject();
    archiveSession(project, makeSession({ teamMemberId: 'member-42' }));
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0].teamMemberId).toBe('member-42');
  });

  it('archiveSession leaves teamMemberId undefined when the session has none', () => {
    const project = makeProject();
    archiveSession(project, makeSession());
    expect(project.sessionHistory![0].teamMemberId).toBeUndefined();
  });

  it('archiveSession backfills teamMemberId on existing entry sharing cliSessionId', () => {
    const project = makeProject();
    archiveSession(project, makeSession({ cliSessionId: 'cli-share' }));
    expect(project.sessionHistory![0].teamMemberId).toBeUndefined();
    archiveSession(project, makeSession({ cliSessionId: 'cli-share', teamMemberId: 'member-7' }));
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0].teamMemberId).toBe('member-7');
  });

  it('buildResumedSession carries teamMemberId forward', () => {
    const session = buildResumedSession({
      id: 'a1',
      name: 'Old',
      providerId: 'claude',
      cliSessionId: 'cli-9',
      createdAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      teamMemberId: 'member-99',
      cost: null,
    });
    expect(session.teamMemberId).toBe('member-99');
  });
});

describe('exitReason', () => {
  it('keeps process details for a crashed session', () => {
    const project = makeProject();
    archiveSession(project, makeSession(), { exitReason: 'unhandled_rejection', exitCode: 1, exitSignal: 9, processId: 2028 });
    expect(project.sessionHistory?.[0]).toMatchObject({ exitReason: 'unhandled_rejection', exitCode: 1, exitSignal: 9, processId: 2028 });
  });
  it('keeps a crash entry even when its transcript is unavailable', () => {
    const project = makeProject();
    archiveSession(project, makeSession({ cliSessionId: null }), { exitReason: 'unhandled_rejection', exitCode: 1, processId: 2028, transcriptAvailable: false });
    expect(project.sessionHistory?.[0]).toMatchObject({ exitReason: 'unhandled_rejection', transcriptAvailable: false, processId: 2028 });
  });
  it('archiveSession sets exitReason on the new entry when provided', () => {
    const project = makeProject();
    archiveSession(project, makeSession(), { exitReason: 'unhandled_rejection' });
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0].exitReason).toBe('unhandled_rejection');
  });

  it('archiveSession leaves exitReason undefined when opts are absent', () => {
    const project = makeProject();
    archiveSession(project, makeSession());
    expect(project.sessionHistory![0].exitReason).toBeUndefined();
  });

  it('re-archiving with a reason updates the existing entry in place', () => {
    const project = makeProject();
    archiveSession(project, makeSession({ cliSessionId: 'cli-crash' }));
    expect(project.sessionHistory![0].exitReason).toBeUndefined();
    archiveSession(project, makeSession({ cliSessionId: 'cli-crash' }), { exitReason: 'unhandled_rejection' });
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0].exitReason).toBe('unhandled_rejection');
  });

  it('re-archiving without a reason does not clear an existing exitReason', () => {
    const project = makeProject();
    archiveSession(project, makeSession({ cliSessionId: 'cli-crash' }), { exitReason: 'unhandled_rejection' });
    archiveSession(project, makeSession({ cliSessionId: 'cli-crash' }));
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0].exitReason).toBe('unhandled_rejection');
  });
});

describe('history-on-create', () => {
  it('records one active row per spawn', () => {
    const project = makeProject();
    const session = makeSession({ cliSessionId: null });
    archiveSessionOnCreate(project, session);
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0]).toMatchObject({ liveSessionId: 's1', state: 'active', cliSessionId: null });
    expect(project.sessionHistory![0].closedAt).toBeUndefined();
    archiveSessionOnCreate(project, session);
    expect(project.sessionHistory).toHaveLength(1);
    expect(findCreateEntry(project, 's1')?.id).toBe(project.sessionHistory![0].id);
  });

  it('mirrors the discovered cliSessionId onto the active row', () => {
    const project = makeProject();
    archiveSessionOnCreate(project, makeSession({ cliSessionId: null }));
    expect(syncCreateEntryCliId(project, 's1', 'cli-9')).toBe(true);
    expect(project.sessionHistory![0].cliSessionId).toBe('cli-9');
    expect(syncCreateEntryCliId(project, 'ghost', 'x')).toBe(false);
  });

  it('finalizes the create row in place at close', () => {
    const project = makeProject();
    archiveSessionOnCreate(project, makeSession({ cliSessionId: null }));
    syncCreateEntryCliId(project, 's1', 'cli-9');
    archiveSession(project, makeSession({ cliSessionId: 'cli-9' }), { finalize: true });
    expect(project.sessionHistory).toHaveLength(1);
    expect(project.sessionHistory![0]).toMatchObject({ state: 'closed', cliSessionId: 'cli-9' });
    expect(project.sessionHistory![0].closedAt).toBeTruthy();
    expect(findCreateEntry(project, 's1')).toBeUndefined();
  });

  it('a /clear segment archive never touches the live row', () => {
    const project = makeProject();
    archiveSessionOnCreate(project, makeSession({ cliSessionId: null }));
    syncCreateEntryCliId(project, 's1', 'cli-old');
    // updateSessionCliId archives the OLD conversation on the same tab (no finalize).
    archiveSession(project, makeSession({ cliSessionId: 'cli-old' }));
    expect(project.sessionHistory).toHaveLength(2);
    expect(project.sessionHistory![0].state).toBe('active');
    expect(project.sessionHistory![0].cliSessionId).toBe('cli-old');
    expect(project.sessionHistory![1].cliSessionId).toBe('cli-old');
  });

  it('the cap never prunes a running row', () => {
    const project = makeProject();
    // PA-06: the exemption now follows the live tab — an 'active' row is
    // exempt only while a session with its liveSessionId exists.
    project.sessions = [makeSession({ id: 'other-tab' })];
    const history = Array.from({ length: 499 }, (_, i) => ({
      id: `c${i}`,
      name: 'closed',
      providerId: 'claude' as const,
      cliSessionId: `c${i}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-01T00:00:00.000Z',
    }));
    history.push({
      id: 'act',
      name: 'live',
      providerId: 'claude' as const,
      cliSessionId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'active' as const,
      // A different tab's row — finalize must not consume it.
      liveSessionId: 'other-tab',
    });
    project.sessionHistory = history;
    archiveSession(project, makeSession({ cliSessionId: 'cli-1' }), { finalize: true });
    expect(project.sessionHistory!.length).toBeLessThanOrEqual(500);
    expect(project.sessionHistory!.some((a) => a.state === 'active')).toBe(true);
  });
});

describe('history cap exemptions (PA-06)', () => {
  const makeClosedRow = (id: string, overrides: Partial<ArchivedSession> = {}): ArchivedSession => ({
    id,
    name: 'row',
    providerId: 'claude',
    cliSessionId: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T00:00:00.000Z',
    cost: null,
    ...overrides,
  });
  const makeActiveRow = (id: string, liveSessionId: string): ArchivedSession => ({
    id,
    name: 'live',
    providerId: 'claude',
    cliSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'active',
    liveSessionId,
    cost: null,
  });

  it('bounds a history of only bookmarked rows (previously unbounded)', () => {
    const project = makeProject();
    project.sessionHistory = Array.from({ length: 501 }, (_, i) =>
      makeClosedRow(`b${i}`, { bookmarked: true }),
    );
    archiveSession(project, makeSession({ cliSessionId: 'cli-new' }));
    // 502 rows, cap 500 → 2 dropped. Only the newest 50 bookmarks are exempt,
    // so the old "bookmarked survives forever" immunity is gone.
    expect(project.sessionHistory!.length).toBe(500);
  });

  it('keeps the newest 50 bookmarks; the 51st-newest is prunable', () => {
    const project = makeProject();
    const plain = Array.from({ length: 500 }, (_, i) => makeClosedRow(`c${i}`));
    const marks = Array.from({ length: 51 }, (_, i) => makeClosedRow(`b${i}`, { bookmarked: true }));
    // Newest-last: b50 is the newest bookmark, b0 the 51st-newest.
    project.sessionHistory = [...plain, ...marks];
    archiveSession(project, makeSession({ cliSessionId: 'cli-new' }));
    const ids = new Set(project.sessionHistory!.map((a) => a.id));
    expect(project.sessionHistory!.length).toBe(500);
    for (let i = 1; i <= 50; i++) expect(ids.has(`b${i}`)).toBe(true);
    expect(ids.has('b0')).toBe(false);
  });

  it('prunes a crash-orphanned active row and never prunes a live-tab row', () => {
    const project = makeProject();
    project.sessions = [makeSession({ id: 'live-tab' })];
    project.sessionHistory = [
      // Oldest row is an orphan: its liveSessionId has no entry in sessions.
      makeActiveRow('act-ghost', 'ghost-tab'),
      makeActiveRow('act-live', 'live-tab'),
      ...Array.from({ length: 498 }, (_, i) => makeClosedRow(`c${i}`)),
    ];
    archiveSession(project, makeSession({ cliSessionId: 'cli-new' }));
    // 501 rows → 1 dropped: the orphan lost its exemption, so it is the oldest
    // non-exempt row; the row with a live tab is exempt.
    const ids = new Set(project.sessionHistory!.map((a) => a.id));
    expect(project.sessionHistory!.length).toBe(500);
    expect(ids.has('act-ghost')).toBe(false);
    expect(ids.has('act-live')).toBe(true);
  });
});
