import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

// Same harness as layout-state.test.ts; transcriptExistsSync is what
// removeSession's archive path (isArchivable) calls for CLI sessions.
vi.stubGlobal('window', {
  vibeyard: {
    store: { load: mockLoad, save: mockSave },
    session: { transcriptExistsSync: () => false },
  },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('../session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, MAX_SESSION_NAME_LENGTH, _resetForTesting } from '../state';
import { ensureProjectDefaults } from './persistence.js';
import type { PersistedState, SessionRecord, TabGroupRecord } from '../../shared/types.js';

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  _resetForTesting();
});

function addProjectWithSessions(count: number) {
  const project = appState.addProject('Test', '/test');
  const sessions: SessionRecord[] = [];
  for (let i = 0; i < count; i++) {
    sessions.push(appState.addSession(project.id, `Session ${i + 1}`)!);
  }
  return { project, sessions };
}

function groupOf(sessionId: string): TabGroupRecord | undefined {
  return appState.activeProject!.tabGroups?.find((g) => g.sessionIds.includes(sessionId));
}

describe('groupSessions()', () => {
  it('groups two tabs, persists once and emits session-changed', () => {
    const { project, sessions } = addProjectWithSessions(3);
    mockSave.mockClear();
    const emitted: unknown[] = [];
    appState.on('session-changed', (d) => emitted.push(d));

    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    appState.flushPersist();

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
    const g = groupOf(sessions[1].id)!;
    expect(g.sessionIds).toEqual([sessions[0].id, sessions[1].id]);
    expect(g.name.length).toBeGreaterThan(0);
    expect(g.colorIndex).toBe(0);
    // Groups persist verbatim through the save serializer.
    const saved = mockSave.mock.calls[0][0] as PersistedState;
    expect(saved.projects[0].tabGroups![0].sessionIds).toEqual([sessions[0].id, sessions[1].id]);
  });

  it('a rejected drop (same group) persists not at all and emits not at all', () => {
    const { project, sessions } = addProjectWithSessions(2);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    mockSave.mockClear();
    const emitted: unknown[] = [];
    appState.on('session-changed', (d) => emitted.push(d));
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    expect(mockSave).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('ignores an unknown project', () => {
    const { sessions } = addProjectWithSessions(2);
    mockSave.mockClear();
    appState.groupSessions('nope', sessions[0].id, sessions[1].id);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('renameTabGroup()', () => {
  it('truncates at MAX_SESSION_NAME_LENGTH and persists', () => {
    const { project, sessions } = addProjectWithSessions(2);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    const g = groupOf(sessions[0].id)!;
    mockSave.mockClear();

    appState.renameTabGroup(project.id, g.id, 'x'.repeat(MAX_SESSION_NAME_LENGTH + 20));
    appState.flushPersist();

    expect(appState.activeProject!.tabGroups![0].name).toHaveLength(MAX_SESSION_NAME_LENGTH);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('a rename of an unknown group is a no-op', () => {
    const { project } = addProjectWithSessions(1);
    mockSave.mockClear();
    appState.renameTabGroup(project.id, 'ghost', 'Name');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('ungroupTabGroup()', () => {
  it('dissolves the group, persists and re-renders', () => {
    const { project, sessions } = addProjectWithSessions(2);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    const g = groupOf(sessions[0].id)!;
    mockSave.mockClear();
    const emitted: unknown[] = [];
    appState.on('session-changed', (d) => emitted.push(d));

    appState.ungroupTabGroup(project.id, g.id);
    appState.flushPersist();

    expect(appState.activeProject!.tabGroups).toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('ungrouping an unknown group is a no-op', () => {
    const { project } = addProjectWithSessions(1);
    mockSave.mockClear();
    appState.ungroupTabGroup(project.id, 'ghost');
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('removeSession() prunes group membership', () => {
  it('drops the closed tab from its group and dissolves at size 1', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    appState.groupSessions(project.id, sessions[2].id, sessions[1].id);
    expect(groupOf(sessions[0].id)!.sessionIds).toHaveLength(3);

    appState.removeSession(project.id, sessions[2].id);
    expect(groupOf(sessions[0].id)!.sessionIds).toEqual([sessions[0].id, sessions[1].id]);

    appState.removeSession(project.id, sessions[1].id);
    expect(appState.activeProject!.tabGroups).toBeUndefined();
  });

  it('Close-others style batch closes leave no dangling members', () => {
    const { project, sessions } = addProjectWithSessions(4);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    appState.groupSessions(project.id, sessions[2].id, sessions[1].id);
    appState.groupSessions(project.id, sessions[3].id, sessions[2].id);

    appState.removeOtherSessions(project.id, sessions[1].id);
    const groups = appState.activeProject!.tabGroups ?? [];
    const liveIds = new Set(appState.activeProject!.sessions.map((s) => s.id));
    for (const g of groups) {
      expect(g.sessionIds.every((id) => liveIds.has(id))).toBe(true);
      expect(g.sessionIds.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('reorderSession() keeps groups contiguous', () => {
  it('dragging a middle member out splits and dissolves per normalizeTabGroups', () => {
    const { project, sessions } = addProjectWithSessions(4);
    appState.groupSessions(project.id, sessions[0].id, sessions[1].id);
    appState.groupSessions(project.id, sessions[2].id, sessions[1].id);
    expect(groupOf(sessions[0].id)!.sessionIds).toHaveLength(3);

    // Move the middle member clear past the group's end: sessions s0,s2,s3,s1.
    appState.reorderSession(project.id, sessions[1].id, 3);
    const g = groupOf(sessions[1].id);
    // The moved tab's run is size 1 (dissolved); the surviving [s0,s2] run
    // keeps the group identity.
    expect(g).toBeUndefined();
    const survivor = appState.activeProject!.tabGroups![0];
    expect(survivor.sessionIds).toEqual([sessions[0].id, sessions[2].id]);
  });
});

describe('ensureProjectDefaults() sanitises tabGroups', () => {
  function baseState(): PersistedState {
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
          sessions: [
            { id: 's1', name: 'S1', cliSessionId: null, createdAt: '0' },
            { id: 's2', name: 'S2', cliSessionId: null, createdAt: '0' },
            { id: 's3', name: 'S3', cliSessionId: null, createdAt: '0' },
          ] as SessionRecord[],
        },
      ],
    };
  }

  it('repairs a hostile tabGroups literal at load', () => {
    const state = baseState();
    state.projects[0].tabGroups = [
      { id: 'g1', name: 'G', sessionIds: ['s3', 'ghost', 's3'], colorIndex: 99 },
      { id: 'g2', name: 'H', sessionIds: ['s1', 's2', 's2', 's1'], colorIndex: -3 },
      { id: 'g3', name: 'I', sessionIds: ['s2', 's3'], colorIndex: 1.5 },
    ];
    ensureProjectDefaults(state);
    const groups = state.projects[0].tabGroups!;
    expect(groups.length).toBe(1);
    expect(groups[0].id).toBe('g2');
    expect(groups[0].sessionIds).toEqual(['s1', 's2']);
    expect(groups[0].colorIndex).toBe(3);
  });

  it('removes tabGroups that normalise to nothing', () => {
    const state = baseState();
    state.projects[0].tabGroups = [
      { id: 'g1', name: 'G', sessionIds: ['ghost'], colorIndex: 0 },
      { id: 'g2', name: 'H', sessionIds: ['s1', 's1'], colorIndex: 0 },
    ];
    ensureProjectDefaults(state);
    expect(state.projects[0].tabGroups).toBeUndefined();
  });

  it('leaves group-less projects untouched', () => {
    const state = baseState();
    ensureProjectDefaults(state);
    expect(state.projects[0].tabGroups).toBeUndefined();
  });
});
