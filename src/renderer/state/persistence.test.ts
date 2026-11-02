import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../session-cost.js', () => ({ restoreCost: vi.fn() }));
vi.mock('../session-context.js', () => ({ restoreContext: vi.fn() }));

import { serializeForSave, hydrateLoadedState, PREDEFINED_CACHE_PERSIST_MAX_AGE_MS, PREDEFINED_CACHE_PERSIST_MAX_SUGGESTIONS } from './persistence.js';
import type { HostRecord, PersistedState, Preferences, SessionRecord } from '../../shared/types.js';

const VALID_HOST: HostRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'lab',
  user: 'dev',
  host: '192.0.2.242',
  port: 22,
  authKind: 'key',
  privateKeyPath: '/home/finevibe/hosts/3f2504e0-4f89-41d3-9a0c-0305e82c3301/id_ed25519',
  managedKey: true,
  enrollmentStatus: 'enrolled',
};

function baseState(session: Partial<SessionRecord>): PersistedState {
  return {
    version: 1,
    activeProjectId: 'p1',
    preferences: {} as PersistedState['preferences'],
    projects: [
      {
        id: 'p1',
        name: 'Proj',
        path: '/p',
        activeSessionId: 's1',
        layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
        sessions: [{ id: 's1', name: 'S', cliSessionId: null, createdAt: '0', ...session }],
      },
    ],
  };
}

describe('serializeForSave', () => {
  it('preserves the sticky profileId on sessions (resume must reuse the config dir)', () => {
    const out = serializeForSave(baseState({ profileId: 'work' }));
    expect(out.projects[0].sessions[0].profileId).toBe('work');
  });

  it('strips the transient pending prompts', () => {
    const out = serializeForSave(baseState({ profileId: 'work', pendingInitialPrompt: 'hi', pendingSystemPrompt: 'sys' }));
    const s = out.projects[0].sessions[0];
    expect(s.profileId).toBe('work');
    expect(s.pendingInitialPrompt).toBeUndefined();
    expect(s.pendingSystemPrompt).toBeUndefined();
  });

  it('strips per-session envVars — typed secrets must not reach disk (P2-101)', () => {
    const out = serializeForSave(
      baseState({ envVars: 'ANTHROPIC_API_KEY=sk-ant-secret\nFOO=bar' }), // pii-allow: synthetic key fixture
    );
    const s = out.projects[0].sessions[0];
    expect('envVars' in s).toBe(false);
  });

  it('keeps project.defaultEnv — the keep-env UX is an explicit opt-in (P2-101)', () => {
    const state = baseState({ envVars: 'ANTHROPIC_API_KEY=sk-ant-secret' }); // pii-allow: synthetic key fixture
    state.projects[0].defaultEnv = 'FOO=bar';
    const out = serializeForSave(state);
    expect(out.projects[0].defaultEnv).toBe('FOO=bar');
    expect('envVars' in out.projects[0].sessions[0]).toBe(false);
  });

  it('preserves cliSessionId through a serialize → hydrate round trip (resume depends on it)', () => {
    const out = serializeForSave(baseState({ cliSessionId: 'cli-42' }));
    hydrateLoadedState(out, {} as Preferences);
    expect(out.projects[0].sessions[0].cliSessionId).toBe('cli-42');
  });

  it('passes the top-level profiles array through unchanged', () => {
    const state = baseState({});
    state.profiles = [{ id: 'work', name: 'Work', providerId: 'claude', configDir: '/cfg/work', managed: true, createdAt: 0 }];
    const out = serializeForSave(state);
    expect(out.profiles).toEqual(state.profiles);
  });
});

describe('serializeForSave predefined-cache eviction (C4TM-07)', () => {
  const suggestions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, name: `S${i}`, role: 'r', systemPrompt: 'p', source: 'custom', createdAt: 0, updatedAt: 0,
    }));
  function stateWithCache(fetchedAt: number, count: number): PersistedState {
    const state = baseState({});
    state.team = { members: [], predefinedCache: { fetchedAt, suggestions: suggestions(count) } };
    return state;
  }

  it('drops a cache older than the persist age bound', () => {
    const out = serializeForSave(stateWithCache(Date.now() - PREDEFINED_CACHE_PERSIST_MAX_AGE_MS - 1, 5));
    expect(out.team?.predefinedCache).toBeUndefined();
  });

  it('keeps a fresh cache', () => {
    const out = serializeForSave(stateWithCache(Date.now(), 5));
    expect(out.team?.predefinedCache?.suggestions).toHaveLength(5);
  });

  it('caps a fresh oversized corpus at the persist suggestion cap', () => {
    const out = serializeForSave(stateWithCache(Date.now(), 500));
    expect(out.team?.predefinedCache?.suggestions).toHaveLength(PREDEFINED_CACHE_PERSIST_MAX_SUGGESTIONS);
    expect(out.team?.predefinedCache?.suggestions[0].id).toBe('s0');
  });

  it('leaves a cache-less team untouched', () => {
    const state = baseState({});
    state.team = { members: [] };
    const out = serializeForSave(state);
    expect(out.team).toEqual({ members: [] });
    expect('predefinedCache' in (out.team ?? {})).toBe(false);
  });

  it('never mutates the in-memory state (the live cache keeps serving the picker)', () => {
    const state = stateWithCache(Date.now() - 25 * 60 * 60 * 1000, 500);
    serializeForSave(state);
    expect(state.team?.predefinedCache?.suggestions).toHaveLength(500);
  });
});

describe('hydrateLoadedState', () => {
  it('migrates the legacy global defaultProfileId to the provider global default', () => {
    const state = baseState({});
    state.profiles = [{ id: 'work', name: 'Work', providerId: 'pi', configDir: '/cfg/work', managed: true, createdAt: 0 }];
    (state.preferences as { defaultProfileId?: string }).defaultProfileId = 'work';

    hydrateLoadedState(state, {} as Preferences);

    expect(state.preferences.defaultProfiles).toEqual({ pi: 'work' });
    expect((state.preferences as { defaultProfileId?: string }).defaultProfileId).toBeUndefined();
  });

  it('drops a dangling legacy defaultProfileId', () => {
    const state = baseState({});
    (state.preferences as { defaultProfileId?: string }).defaultProfileId = 'gone';

    hydrateLoadedState(state, {} as Preferences);

    expect(state.preferences.defaultProfiles).toBeUndefined();
    expect((state.preferences as { defaultProfileId?: string }).defaultProfileId).toBeUndefined();
  });

  it('fills sidebarViews keys missing from an older save with defaults', () => {
    const state = baseState({});
    // Pre-discussions/activeSessions save: the object exists but lacks newer keys.
    state.preferences = {
      sidebarViews: { gitPanel: false, sessionHistory: true, discussions: false, fileTree: true },
    } as unknown as PersistedState['preferences'];

    hydrateLoadedState(state, {
      sidebarViews: { gitPanel: true, sessionHistory: true, discussions: true, fileTree: true, activeSessions: true },
    } as Preferences);

    expect(state.preferences.sidebarViews).toEqual({
      gitPanel: false,
      sessionHistory: true,
      discussions: false,
      fileTree: true,
      activeSessions: true,
    });
  });

  // per-host providers T1: renderer-side mirror of the store.ts load-time
  // normalization — hostId-less sessions/profiles hydrate as 'local'.
  it('normalizes hostId-less sessions and profiles to the local host', () => {
    const state = baseState({});
    state.profiles = [{ id: 'work', name: 'Work', providerId: 'pi', configDir: '/cfg/work', managed: true, createdAt: 0 }];

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].sessions[0].hostId).toBe('local');
    expect(state.profiles[0].hostId).toBe('local');
  });

  it('keeps a persisted non-local hostId untouched', () => {
    const state = baseState({ hostId: 'remote1' });

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].sessions[0].hostId).toBe('remote1');
  });

  // parent §11 retire tail: the free-text sshHost is gone from SessionRecord,
  // so an old state.json must hydrate with the key stripped (registry match
  // adopts the id, anything else pins to local) and re-save without it.
  it('adopts the registry id for a legacy sshHost and strips the retired key', () => {
    const state = baseState({ sshHost: 'lab.example.com' } as Partial<SessionRecord>);
    state.hosts = [{ ...VALID_HOST, host: 'lab.example.com' }];

    hydrateLoadedState(state, {} as Preferences);

    const session = state.projects[0].sessions[0];
    expect(session.hostId).toBe(VALID_HOST.id);
    expect(Object.hasOwn(session, 'sshHost')).toBe(false);
    expect(serializeForSave(state).projects[0].sessions[0]).not.toHaveProperty('sshHost');
  });

  it('strips an unregistered legacy sshHost and pins the session to local', () => {
    const state = baseState({ sshHost: 'nowhere.example.com' } as Partial<SessionRecord>);

    hydrateLoadedState(state, {} as Preferences);

    const session = state.projects[0].sessions[0];
    expect(session.hostId).toBe('local');
    expect(Object.hasOwn(session, 'sshHost')).toBe(false);
  });
});

describe('hydrateLoadedState active rows', () => {
  const rows = () => [
    { id: 'a1', name: 'live', providerId: 'claude' as const, cliSessionId: 'cli-1', createdAt: '0', state: 'active' as const, liveSessionId: 's1' },
    { id: 'a2', name: 'orphan', providerId: 'claude' as const, cliSessionId: 'cli-2', createdAt: '0', state: 'active' as const, liveSessionId: 'gone' },
  ];

  it('finalizes rows whose tab did not survive, keeps live ones', () => {
    const state = baseState({});
    state.projects[0].sessionHistory = rows();

    hydrateLoadedState(state, {} as Preferences);

    const [live, orphan] = state.projects[0].sessionHistory!;
    expect(live.state).toBe('active');
    expect(orphan.state).toBe('closed');
    expect(orphan.closedAt).toBeTruthy();
  });
});

describe('hydrateLoadedState remote-terminal drop (C5R-01)', () => {
  // Remote-terminal pane instances are created by share-manager only during
  // a live share (split-layout skips the type at hydration), so a
  // resurrected session is a blank dead-end tab on every restart.
  it('drops remote-terminal sessions from the hydrated tab list', () => {
    const state = baseState({});
    state.projects[0].sessions.push({
      id: 'r1', name: 'Remote', type: 'remote-terminal', cliSessionId: null, createdAt: '0',
    });

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('finalizes active history rows whose dropped tab was remote-terminal', () => {
    const state = baseState({});
    state.projects[0].sessions.push({
      id: 'r1', name: 'Remote', type: 'remote-terminal', cliSessionId: null, createdAt: '0',
    });
    state.projects[0].sessionHistory = [
      { id: 'h1', name: 'R', providerId: 'claude', cliSessionId: null, createdAt: '0', state: 'active', liveSessionId: 'r1' },
    ];

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].sessionHistory![0].state).toBe('closed');
    expect(state.projects[0].sessionHistory![0].closedAt).toBeTruthy();
  });
});

describe('hydrateLoadedState githubLastSeen age prune (PA-31)', () => {
  // Fixed clock so the 90-day cutoff is deterministic.
  const NOW = Date.parse('2026-10-22T00:00:00.000Z');
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops entries older than 90 days and unparseable timestamps, keeps fresh ones', () => {
    const state = baseState({});
    state.projects[0].githubLastSeen = {
      fresh: iso(1),
      boundary: iso(90), // exactly at the cutoff: kept (only strictly older is dropped)
      stale: iso(90.5),
      garbage: 'not-a-date', // cannot be aged → dropped
    };

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].githubLastSeen).toEqual({ fresh: iso(1), boundary: iso(90) });
  });

  it('deletes the key when every entry is dropped (no empty {} reaches disk)', () => {
    const state = baseState({});
    state.projects[0].githubLastSeen = { stale: iso(91), garbage: 'x' };

    hydrateLoadedState(state, {} as Preferences);

    expect('githubLastSeen' in state.projects[0]).toBe(false);
  });

  it('keeps an all-fresh map untouched, by reference (no identity churn)', () => {
    const state = baseState({});
    const seen = { pr: iso(89), issue: iso(2) };
    state.projects[0].githubLastSeen = seen;

    hydrateLoadedState(state, {} as Preferences);

    expect(state.projects[0].githubLastSeen).toBe(seen);
  });

  it('does not create githubLastSeen for a project that has none', () => {
    const state = baseState({});

    hydrateLoadedState(state, {} as Preferences);

    expect('githubLastSeen' in state.projects[0]).toBe(false);
  });
});

// team-lead-persona-plan M2b / I4: the Done-gate is an additive board key, so its
// persistence contract is “rides the whole-state write, survives hydrate, and
// writes nothing when the board never opted in”.
describe('board leadGate round-trip (I4 Done-gate)', () => {
  const gatedState = (): PersistedState => {
    const state = baseState({});
    state.projects[0].board = {
      columns: [
        { id: 'c-inbox', title: 'Backlog', order: 0, behavior: 'inbox' },
        { id: 'c-done', title: 'Done', order: 1, behavior: 'terminal' },
      ],
      tasks: [],
      leadGate: true,
    };
    return state;
  };

  it('persists the per-board gate through save → hydrate', () => {
    const out = serializeForSave(gatedState());
    hydrateLoadedState(out, {} as Preferences);
    expect(out.projects[0].board?.leadGate).toBe(true);
  });

  it('writes no gate key for a board that never opted in (zero delta)', () => {
    const state = gatedState();
    delete state.projects[0].board!.leadGate;

    const out = serializeForSave(state);
    hydrateLoadedState(out, {} as Preferences);

    expect(out.projects[0].board).toBeDefined();
    expect('leadGate' in out.projects[0].board!).toBe(false);
  });
});
