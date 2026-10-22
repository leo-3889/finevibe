import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  finevibe: {
    store: { load: mockLoad, save: mockSave },
    session: {
      transcriptExists: vi.fn(async () => true),
    },
  },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

vi.mock('./session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('./session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('./provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, _resetForTesting, MAX_PROJECT_NAME_LENGTH, MAX_SESSION_NAME_LENGTH } from './state';
import { getCost, restoreCost } from './session-cost.js';
import { restoreContext } from './session-context.js';

const mockGetCost = vi.mocked(getCost);
const mockRestoreCost = vi.mocked(restoreCost);
const mockRestoreContext = vi.mocked(restoreContext);

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockGetCost.mockReturnValue(null);
  _resetForTesting();
});

function addProject(name = 'Test', path = '/test') {
  return appState.addProject(name, path);
}

function addProjectWithSessions(count: number) {
  const project = addProject();
  const sessions = [];
  for (let i = 0; i < count; i++) {
    sessions.push(appState.addSession(project.id, `Session ${i + 1}`)!);
  }
  return { project, sessions };
}

describe('load()', () => {
  it('loads persisted state from store', async () => {
    const persisted = {
      version: 1,
      projects: [
        {
          id: 'p1',
          name: 'Proj',
          path: '/proj',
          sessions: [],
          activeSessionId: null,
          layout: { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const },
        },
      ],
      activeProjectId: 'p1',
      preferences: { soundOnSessionWaiting: true, debugMode: false },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    expect(appState.projects).toHaveLength(1);
    expect(appState.activeProjectId).toBe('p1');
    expect(appState.preferences.soundOnSessionWaiting).toBe(true);
  });

  it('handles null return from store (keeps defaults)', async () => {
    mockLoad.mockResolvedValue(null);
    await appState.load();
    expect(appState.projects).toEqual([]);
    expect(appState.activeProjectId).toBeNull();
  });

  it('merges defaults for forward compatibility', async () => {
    const persisted = {
      version: 1,
      projects: [],
      activeProjectId: null,
      preferences: { soundOnSessionWaiting: true },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    // debugMode should be filled in from defaults
    expect(appState.preferences.debugMode).toBe(false);
    expect(appState.preferences.soundOnSessionWaiting).toBe(true);
  });

  it('emits state-loaded event', async () => {
    mockLoad.mockResolvedValue(null);
    const cb = vi.fn();
    appState.on('state-loaded', cb);
    await appState.load();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('restores persisted cost data into session-cost module', async () => {
    const costData = {
      totalCostUsd: 1.5,
      totalInputTokens: 500,
      totalOutputTokens: 200,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      totalDurationMs: 1000,
      totalApiDurationMs: 800,
    };
    const persisted = {
      version: 1,
      projects: [{
        id: 'p1',
        name: 'Proj',
        path: '/proj',
        sessions: [
          { id: 's1', name: 'S1', cliSessionId: 'cli-1', createdAt: '2026-01-01', cost: costData },
          { id: 's2', name: 'S2', cliSessionId: null, createdAt: '2026-01-02' },
        ],
        activeSessionId: 's1',
        layout: { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const },
      }],
      activeProjectId: 'p1',
      preferences: { soundOnSessionWaiting: false, debugMode: false },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    expect(mockRestoreCost).toHaveBeenCalledOnce();
    expect(mockRestoreCost).toHaveBeenCalledWith('s1', costData);
  });

  it('restores persisted context window data into session-context module', async () => {
    const contextData = { totalTokens: 5000, contextWindowSize: 200000, usedPercentage: 2.5 };
    const persisted = {
      version: 1,
      projects: [{
        id: 'p1',
        name: 'Proj',
        path: '/proj',
        sessions: [
          { id: 's1', name: 'S1', cliSessionId: null, createdAt: '2026-01-01', contextWindow: contextData },
        ],
        activeSessionId: 's1',
        layout: { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const },
      }],
      activeProjectId: 'p1',
      preferences: { soundOnSessionWaiting: false, debugMode: false },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    expect(mockRestoreContext).toHaveBeenCalledOnce();
    expect(mockRestoreContext).toHaveBeenCalledWith('s1', contextData);
  });

  it('deduplicates history entry IDs on load', async () => {
    const persisted = {
      version: 1,
      projects: [{
        id: 'p1',
        name: 'Proj',
        path: '/proj',
        sessions: [],
        activeSessionId: null,
        layout: { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const },
        sessionHistory: [
          { id: 'dup-id', name: 'Entry1', providerId: 'claude', cliSessionId: 'cli-a', createdAt: '2026-01-01', closedAt: '2026-01-01', cost: null },
          { id: 'dup-id', name: 'Entry2', providerId: 'claude', cliSessionId: 'cli-b', createdAt: '2026-01-02', closedAt: '2026-01-02', cost: null },
          { id: 'unique-id', name: 'Entry3', providerId: 'claude', cliSessionId: 'cli-c', createdAt: '2026-01-03', closedAt: '2026-01-03', cost: null },
        ],
      }],
      activeProjectId: 'p1',
      preferences: { soundOnSessionWaiting: false, debugMode: false },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    const history = appState.getSessionHistory('p1');
    expect(history).toHaveLength(3);
    // First entry keeps its ID, second gets a new one
    expect(history[0].id).toBe('dup-id');
    expect(history[1].id).not.toBe('dup-id');
    expect(history[2].id).toBe('unique-id');
    // All IDs are now unique
    const ids = new Set(history.map(h => h.id));
    expect(ids.size).toBe(3);
  });

  it('does not call restoreCost for sessions without cost', async () => {
    const persisted = {
      version: 1,
      projects: [{
        id: 'p1',
        name: 'Proj',
        path: '/proj',
        sessions: [{ id: 's1', name: 'S1', cliSessionId: null, createdAt: '2026-01-01' }],
        activeSessionId: 's1',
        layout: { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const },
      }],
      activeProjectId: 'p1',
      preferences: { soundOnSessionWaiting: false, debugMode: false },
    };
    mockLoad.mockResolvedValue(persisted);
    await appState.load();
    expect(mockRestoreCost).not.toHaveBeenCalled();
  });
});

describe('persist()', () => {
  it('calls store.save after addProject', () => {
    addProject();
    appState.flushPersist(); // PA-15: persist is frame-coalesced, not synchronous
    expect(mockSave).toHaveBeenCalled();
    const savedState = mockSave.mock.calls[0][0];
    expect(savedState.projects).toHaveLength(1);
  });

  it('calls store.save after addSession', () => {
    const project = addProject();
    mockSave.mockClear();
    appState.addSession(project.id, 'S1');
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('getters', () => {
  it('projects returns empty array by default', () => {
    expect(appState.projects).toEqual([]);
  });

  it('activeProjectId returns null by default', () => {
    expect(appState.activeProjectId).toBeNull();
  });

  it('activeProject returns undefined when no projects', () => {
    expect(appState.activeProject).toBeUndefined();
  });

  it('activeSession returns undefined when no project', () => {
    expect(appState.activeSession).toBeUndefined();
  });

  it('activeProject returns the active project', () => {
    const project = addProject('My Proj', '/my');
    expect(appState.activeProject).toBeDefined();
    expect(appState.activeProject!.id).toBe(project.id);
  });

  it('activeSession returns the active session', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    expect(appState.activeSession).toBeDefined();
    expect(appState.activeSession!.id).toBe(session.id);
  });

  it('sidebarWidth returns undefined by default', () => {
    expect(appState.sidebarWidth).toBeUndefined();
  });
});

describe('addProject()', () => {
  it('creates project with UUID and sets it active', () => {
    const project = addProject('Foo', '/foo');
    expect(project.id).toBe('uuid-1');
    expect(project.name).toBe('Foo');
    expect(project.path).toBe('/foo');
    expect(project.sessions).toEqual([]);
    expect(project.activeSessionId).toBeNull();
    expect(appState.activeProjectId).toBe('uuid-1');
  });

  it('emits project-added and project-changed', () => {
    const addedCb = vi.fn();
    const changedCb = vi.fn();
    appState.on('project-added', addedCb);
    appState.on('project-changed', changedCb);
    const project = addProject();
    expect(addedCb).toHaveBeenCalledWith(project);
    expect(changedCb).toHaveBeenCalledTimes(1);
  });

  it('initializes a default board so the kanban tab renders without an app restart', () => {
    const project = addProject();
    expect(project.board).toBeDefined();
    expect(project.board!.columns.map(c => c.title)).toEqual(['Backlog', 'Ready', 'Running', 'Done']);
    expect(project.board!.tasks).toEqual([]);
  });
});

describe('openKanbanTab()', () => {
  it('backfills a missing board on the project before opening the tab', () => {
    const project = addProject();
    delete project.board;
    const session = appState.openKanbanTab(project.id);
    expect(session?.type).toBe('kanban');
    expect(project.board).toBeDefined();
    expect(project.board!.columns).toHaveLength(4);
  });
});

describe('removeProject()', () => {
  it('removes the project and falls back to first remaining', () => {
    const p1 = addProject('P1', '/p1');
    const p2 = addProject('P2', '/p2');
    // p2 is active now
    appState.removeProject(p2.id);
    expect(appState.projects).toHaveLength(1);
    expect(appState.activeProjectId).toBe(p1.id);
  });

  it('sets activeProjectId to null when last project removed', () => {
    const p = addProject();
    appState.removeProject(p.id);
    expect(appState.projects).toHaveLength(0);
    expect(appState.activeProjectId).toBeNull();
  });

  it('emits project-removed and project-changed', () => {
    const removedCb = vi.fn();
    const changedCb = vi.fn();
    const p = addProject();
    appState.on('project-removed', removedCb);
    appState.on('project-changed', changedCb);
    appState.removeProject(p.id);
    expect(removedCb).toHaveBeenCalledWith(p.id);
    expect(changedCb).toHaveBeenCalled();
  });

  it('emits session-removed for each session before removing project', () => {
    const sessionRemovedCb = vi.fn();
    const p = addProject();
    const s1 = appState.addSession(p.id, 'S1')!;
    const s2 = appState.addSession(p.id, 'S2')!;
    appState.on('session-removed', sessionRemovedCb);
    appState.removeProject(p.id);
    expect(sessionRemovedCb).toHaveBeenCalledTimes(2);
    expect(sessionRemovedCb).toHaveBeenCalledWith({ projectId: p.id, sessionId: s1.id, deferRender: true });
    expect(sessionRemovedCb).toHaveBeenCalledWith({ projectId: p.id, sessionId: s2.id, deferRender: true });
  });
});

describe('renameProject()', () => {
  it('renames an existing project', () => {
    const p = addProject('Old', '/path');
    appState.renameProject(p.id, 'New');
    expect(appState.projects[0].name).toBe('New');
    expect(appState.projects[0].path).toBe('/path');
  });

  it('trims whitespace', () => {
    const p = addProject('Old');
    appState.renameProject(p.id, '  Spaced  ');
    expect(appState.projects[0].name).toBe('Spaced');
  });

  it('is a no-op when name is empty or whitespace', () => {
    const p = addProject('Old');
    appState.renameProject(p.id, '   ');
    expect(appState.projects[0].name).toBe('Old');
  });

  it('is a no-op when name is unchanged', () => {
    const p = addProject('Same');
    const changedCb = vi.fn();
    appState.on('project-changed', changedCb);
    appState.renameProject(p.id, 'Same');
    expect(changedCb).not.toHaveBeenCalled();
  });

  it('is a no-op for unknown project id', () => {
    addProject('Real');
    appState.renameProject('does-not-exist', 'Anything');
    expect(appState.projects[0].name).toBe('Real');
  });

  it('truncates name exceeding MAX_PROJECT_NAME_LENGTH', () => {
    const p = addProject('Old');
    const longName = 'A'.repeat(MAX_PROJECT_NAME_LENGTH + 30);
    appState.renameProject(p.id, longName);
    expect(appState.projects[0].name).toBe('A'.repeat(MAX_PROJECT_NAME_LENGTH));
  });

  it('emits project-changed and persists', () => {
    const p = addProject('Old');
    const changedCb = vi.fn();
    appState.on('project-changed', changedCb);
    mockSave.mockClear();
    appState.renameProject(p.id, 'New');
    expect(changedCb).toHaveBeenCalled();
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('addSession()', () => {
  it('creates a session and sets it active', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1', '--verbose')!;
    expect(session).toBeDefined();
    expect(session.name).toBe('S1');
    expect(session.args).toBe('--verbose');
    expect(session.cliSessionId).toBeNull();
    expect(appState.activeProject!.activeSessionId).toBe(session.id);
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.addSession('nonexistent', 'S')).toBeUndefined();
  });

  it('emits session-added and session-changed', () => {
    const addedCb = vi.fn();
    const changedCb = vi.fn();
    const project = addProject();
    appState.on('session-added', addedCb);
    appState.on('session-changed', changedCb);
    appState.addSession(project.id, 'S1');
    expect(addedCb).toHaveBeenCalledTimes(1);
    expect(changedCb).toHaveBeenCalledTimes(1);
  });

  it('uses project defaultArgs when no explicit args provided', () => {
    const project = addProject();
    project.defaultArgs = '--model sonnet';
    const session = appState.addSession(project.id, 'S1')!;
    expect(session.args).toBe('--model sonnet');
  });

  it('explicit args override project defaultArgs', () => {
    const project = addProject();
    project.defaultArgs = '--model sonnet';
    const session = appState.addSession(project.id, 'S1', '--model opus')!;
    expect(session.args).toBe('--model opus');
  });

  it('no args when neither explicit args nor defaultArgs set', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    expect(session.args).toBeUndefined();
  });

  it('pins an explicitly-passed profile that matches the provider', () => {
    const project = addProject();
    appState.profiles.push({ id: 'prof-1', name: 'Work', providerId: 'claude', configDir: '/x', managed: true, createdAt: 0 });
    const session = appState.addSession(project.id, 'S1', undefined, 'claude', 'prof-1')!;
    expect(session.profileId).toBe('prof-1');
  });

  it('does not pin a profile whose provider mismatches', () => {
    const project = addProject();
    appState.profiles.push({ id: 'prof-2', name: 'Other', providerId: 'codex', configDir: '/y', managed: true, createdAt: 0 });
    const session = appState.addSession(project.id, 'S1', undefined, 'claude', 'prof-2')!;
    expect(session.profileId).toBeUndefined();
  });
});

describe('addPlanSession()', () => {
  it('forwards profileId to addSession', () => {
    const project = addProject();
    const spy = vi.spyOn(appState, 'addSession');
    appState.addPlanSession(project.id, 'S1', true, 'claude', 'prof-1');
    expect(spy.mock.calls[0][4]).toBe('prof-1');
  });

  it('activates the new session by default', () => {
    const project = addProject();
    const session = appState.addPlanSession(project.id, 'S1')!;
    expect(appState.activeSession!.id).toBe(session.id);
  });

  // `Preferences.askAiFocus: 'stay'` sends `{activate:false}`: the session must
  // exist, run, and announce itself — without stealing the active tab.
  it('activate:false keeps the active tab, skips the nav ring, still emits and archives', () => {
    const project = addProject();
    const first = appState.addPlanSession(project.id, 'A')!;
    const second = appState.addPlanSession(project.id, 'B')!;
    const addedCb = vi.fn();
    const changedCb = vi.fn();
    appState.on('session-added', addedCb);
    appState.on('session-changed', changedCb);

    const background = appState.addPlanSession(project.id, 'C', true, undefined, undefined, { activate: false })!;

    expect(project.sessions.map((s) => s.id)).toContain(background.id);
    expect(appState.activeSession!.id).toBe(second.id);
    expect(addedCb).toHaveBeenCalledTimes(1);
    expect(addedCb).toHaveBeenCalledWith({ projectId: project.id, session: background });
    expect(changedCb).toHaveBeenCalledTimes(1);
    // The history entry is still created at spawn, exactly like an activated session.
    expect(appState.getSessionHistory(project.id).some((h) => h.liveSessionId === background.id)).toBe(true);
    // Nav ring unchanged: Cmd+[ walks B → A, never through the background tab.
    appState.navigateBack();
    expect(appState.activeSession!.id).toBe(first.id);
  });

  it('addSession forwards opts.activate:false to the same background path', () => {
    const project = addProject();
    const active = appState.addSession(project.id, 'A')!;
    const background = appState.addSession(project.id, 'B', undefined, undefined, undefined, undefined, { activate: false })!;
    expect(project.sessions.map((s) => s.id)).toContain(background.id);
    appState.navigateBack();
    expect(appState.activeSession!.id).toBe(active.id);
  });
});

describe('removeSession()', () => {
  it('closing last tab activates previous tab', () => {
    const { project, sessions } = addProjectWithSessions(3);
    // active is the last added session (sessions[2])
    appState.removeSession(project.id, sessions[2].id);
    expect(appState.activeProject!.sessions).toHaveLength(2);
    expect(appState.activeProject!.activeSessionId).toBe(sessions[1].id);
  });

  it('closing middle tab activates previous tab', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.setActiveSession(project.id, sessions[1].id);
    appState.removeSession(project.id, sessions[1].id);
    expect(appState.activeProject!.sessions).toHaveLength(2);
    expect(appState.activeProject!.activeSessionId).toBe(sessions[0].id);
  });

  it('closing first tab activates next tab', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.setActiveSession(project.id, sessions[0].id);
    appState.removeSession(project.id, sessions[0].id);
    expect(appState.activeProject!.sessions).toHaveLength(2);
    expect(appState.activeProject!.activeSessionId).toBe(sessions[1].id);
  });

  it('sets activeSessionId to null when last session removed', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.removeSession(project.id, session.id);
    expect(appState.activeProject!.activeSessionId).toBeNull();
  });

  it('clears session from splitPanes', () => {
    const { project, sessions } = addProjectWithSessions(2);
    appState.toggleSwarm();
    expect(appState.activeProject!.layout.splitPanes.length).toBeGreaterThan(0);
    appState.removeSession(project.id, sessions[0].id);
    expect(appState.activeProject!.layout.splitPanes).not.toContain(sessions[0].id);
  });

  it('emits session-removed and session-changed', () => {
    const removedCb = vi.fn();
    const changedCb = vi.fn();
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.on('session-removed', removedCb);
    appState.on('session-changed', changedCb);
    appState.removeSession(project.id, session.id);
    expect(removedCb).toHaveBeenCalledWith({ projectId: project.id, sessionId: session.id });
    expect(changedCb).toHaveBeenCalled();
  });
});

describe('reorderProject()', () => {
  it('moves project forward', () => {
    const a = appState.addProject('A', '/a');
    const b = appState.addProject('B', '/b');
    const c = appState.addProject('C', '/c');
    appState.reorderProject(0, 2);
    expect(appState.projects.map((p) => p.id)).toEqual([b.id, c.id, a.id]);
  });

  it('moves project backward', () => {
    const a = appState.addProject('A', '/a');
    const b = appState.addProject('B', '/b');
    const c = appState.addProject('C', '/c');
    appState.reorderProject(2, 0);
    expect(appState.projects.map((p) => p.id)).toEqual([c.id, a.id, b.id]);
  });

  it('no-op when fromIndex === toIndex', () => {
    const a = appState.addProject('A', '/a');
    const b = appState.addProject('B', '/b');
    const cb = vi.fn();
    appState.on('project-changed', cb);
    mockSave.mockClear();
    appState.reorderProject(1, 1);
    expect(mockSave).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(appState.projects.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('no-op when index is out of range', () => {
    const a = appState.addProject('A', '/a');
    const b = appState.addProject('B', '/b');
    const cb = vi.fn();
    appState.on('project-changed', cb);
    mockSave.mockClear();
    appState.reorderProject(0, 5);
    appState.reorderProject(-1, 0);
    appState.reorderProject(5, 0);
    expect(mockSave).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(appState.projects.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it('emits project-changed and persists', () => {
    appState.addProject('A', '/a');
    appState.addProject('B', '/b');
    const cb = vi.fn();
    appState.on('project-changed', cb);
    mockSave.mockClear();
    appState.reorderProject(0, 1);
    expect(cb).toHaveBeenCalledTimes(1);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('preferences', () => {
  it('setPreference updates and persists', () => {
    appState.setPreference('debugMode', true);
    expect(appState.preferences.debugMode).toBe(true);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });

  it('setPreference emits preferences-changed', () => {
    const cb = vi.fn();
    appState.on('preferences-changed', cb);
    appState.setPreference('soundOnSessionWaiting', true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('zoomFactor defaults to 1.0', () => {
    expect(appState.preferences.zoomFactor).toBe(1.0);
  });

  it('setPreference stores zoomFactor', () => {
    appState.setPreference('zoomFactor', 1.5);
    expect(appState.preferences.zoomFactor).toBe(1.5);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('setSidebarWidth()', () => {
  it('sets sidebarWidth and persists', () => {
    appState.setSidebarWidth(300);
    expect(appState.sidebarWidth).toBe(300);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('toggleSidebar()', () => {
  it('toggles sidebarCollapsed, persists, and emits', () => {
    expect(appState.sidebarCollapsed).toBe(false);
    const cb = vi.fn();
    appState.on('sidebar-toggled', cb);
    appState.toggleSidebar();
    expect(appState.sidebarCollapsed).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });

  it('toggles back to false', () => {
    appState.toggleSidebar(); // true
    appState.toggleSidebar(); // false
    expect(appState.sidebarCollapsed).toBe(false);
  });
});

describe('setTerminalPanelOpen()', () => {
  it('sets terminalPanelOpen on active project and emits', () => {
    addProject();
    const cb = vi.fn();
    appState.on('terminal-panel-changed', cb);
    appState.setTerminalPanelOpen(true);
    expect(appState.activeProject!.terminalPanelOpen).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });

  it('no-op when no active project', () => {
    mockSave.mockClear();
    appState.setTerminalPanelOpen(true);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('setTerminalPanelHeight()', () => {
  it('sets terminalPanelHeight on active project', () => {
    addProject();
    appState.setTerminalPanelHeight(250);
    expect(appState.activeProject!.terminalPanelHeight).toBe(250);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('on() / event system', () => {
  it('returns an unsubscribe function that works', () => {
    const cb = vi.fn();
    const unsub = appState.on('project-changed', cb);
    addProject();
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    addProject();
    expect(cb).toHaveBeenCalledTimes(1); // not called again
  });
});

describe('setActiveProject()', () => {
  it('sets activeProjectId and emits project-changed', () => {
    const p1 = addProject('P1', '/p1');
    addProject('P2', '/p2');
    const cb = vi.fn();
    appState.on('project-changed', cb);
    appState.setActiveProject(p1.id);
    expect(appState.activeProjectId).toBe(p1.id);
    expect(cb).toHaveBeenCalled();
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('updateSessionCliId()', () => {
  // The statusLine rewrites <sid>.sessionid on every render and the SessionStart /
  // UserPromptSubmit hooks re-report the same id. Each repeat used to cost a
  // persist plus a `session-changed` fan-out, and renderLayout() answered every one
  // of those by re-appending the terminal pane — blurring the in-pane find bar and
  // collapsing an in-progress selection.
  beforeEach(() => {
    (window as any).finevibe.session = {
      // PA-25: the archive gate reads an async-prefetched flag now; a resolved
      // `false` is what makes these sessions non-archivable.
      transcriptExists: vi.fn(async () => false),
    };
  });

  it('emits and persists the first time an id arrives', () => {
    const { project, sessions } = addProjectWithSessions(1);
    const cb = vi.fn();
    appState.on('session-changed', cb);
    mockSave.mockClear();

    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');

    expect(sessions[0].cliSessionId).toBe('cli-1');
    expect(cb).toHaveBeenCalledTimes(1);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });

  it('is a no-op when the same id is re-reported', () => {
    const { project, sessions } = addProjectWithSessions(1);
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');

    const cb = vi.fn();
    appState.on('session-changed', cb);
    mockSave.mockClear();

    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');

    expect(cb).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('still resets the tab on a changed id (/clear)', () => {
    const { project, sessions } = addProjectWithSessions(1);
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    appState.renameSession(project.id, sessions[0].id, 'My name', true);

    const cleared = vi.fn();
    appState.on('cli-session-cleared', cleared);

    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-2');

    expect(sessions[0].cliSessionId).toBe('cli-2');
    expect(sessions[0].userRenamed).toBe(false);
    expect(cleared).toHaveBeenCalledWith({ sessionId: sessions[0].id });
  });
});

// --- Session History Tests ---

describe('persist throttle', () => {
  // PA-15: a mutation no longer serializes + structured-clones the whole state
  // synchronously inside the interaction. persist() schedules ONE write on the
  // coming frame (a 16 ms timer in this node-env suite; rAF in the renderer)
  // and the leading-edge 200 ms throttle in `throttledWrite` bounds a burst to
  // one IPC per window.
  const FRAME_MS = 16;

  it('clones once per frame: a burst writes nothing until the frame lands', () => {
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'light');
      appState.setPreference('theme', 'dark');
      appState.setPreference('theme', 'light');
      // Inside the interaction: zero serialization, zero IPC clones.
      expect(mockSave).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FRAME_MS);
      // ONE clone for the whole burst, carrying the LATEST state.
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave.mock.calls[0][0].preferences.theme).toBe('light');
      vi.advanceTimersByTime(250);
      expect(mockSave).toHaveBeenCalledTimes(1); // no phantom trailing write
    } finally {
      vi.useRealTimers();
    }
  });

  it('clones an isolated mutation once, on the frame after the action', () => {
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'solo');
      expect(mockSave).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FRAME_MS);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave.mock.calls[0][0].preferences.theme).toBe('solo');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces frames inside the throttle window into one trailing save', () => {
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'a');
      vi.advanceTimersByTime(FRAME_MS); // leading write
      expect(mockSave).toHaveBeenCalledTimes(1);
      // A burst that outlives its frame: every later frame returns early
      // because the trailing save is armed — one IPC for the whole window.
      for (let i = 0; i < 5; i++) {
        appState.setPreference('theme', `v${i}`);
        vi.advanceTimersByTime(FRAME_MS);
      }
      expect(mockSave).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave.mock.calls[1][0].preferences.theme).toBe('v4');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushPersist writes now and cancels the pending frame', () => {
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'light'); // frame scheduled
      appState.setPreference('theme', 'dark');  // coalesced into it
      appState.flushPersist();
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockSave.mock.calls[0][0].preferences.theme).toBe('dark');
      // The cancelled frame must not arm a trailing save past the quit flush.
      vi.advanceTimersByTime(300);
      expect(mockSave).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the leading edge again once the throttle window has passed', () => {
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'light');
      vi.advanceTimersByTime(250); // the frame landed long ago
      appState.setPreference('theme', 'dark');
      vi.advanceTimersByTime(FRAME_MS);
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave.mock.calls[1][0].preferences.theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms the trailing save for the throttle window, not a clock skew', () => {
    // A backwards wall-clock jump (resume-from-suspend NTP correction,
    // restored VM snapshot) puts lastPersistAt in the future. Without the
    // Math.max clamp in throttledWrite(), the timer arms for 200 ms + skew
    // and the armed-timer guard drops every later write, leaving mutations
    // memory-only for that window.
    vi.useFakeTimers();
    try {
      appState.setPreference('theme', 'light');
      vi.advanceTimersByTime(FRAME_MS);         // leading write → lastPersistAt = now
      vi.setSystemTime(Date.now() - 60_000);    // clock jumps behind it
      appState.setPreference('theme', 'dark');  // trailing save must arm for ~200 ms
      vi.advanceTimersByTime(FRAME_MS + 250);
      expect(mockSave).toHaveBeenCalledTimes(2);
      expect(mockSave.mock.calls[1][0].preferences.theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- Session mutators on `state.ts` ---
// (Formerly `state/session-mutations.test.ts`, renamed into this file: the
// mutators under test are `state.ts` methods, and FEATURES.md maps coverage
// to modules by test-file name — `state.test.ts` is where the mapping finds
// `state.ts` coverage.)

describe('setActiveSession()', () => {
  it('updates activeSessionId and persists', () => {
    const { project, sessions } = addProjectWithSessions(2);
    mockSave.mockClear();
    appState.setActiveSession(project.id, sessions[0].id);
    expect(appState.activeProject!.activeSessionId).toBe(sessions[0].id);
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('updateSessionCost()', () => {
  const sampleCost = {
    totalCostUsd: 2.5,
    totalInputTokens: 1000,
    totalOutputTokens: 400,
    cacheReadTokens: 50,
    cacheCreationTokens: 25,
    totalDurationMs: 3000,
    totalApiDurationMs: 2000,
  };

  it('persists cost data on the session record', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      mockSave.mockClear();
      appState.updateSessionCost(session.id, sampleCost);
      const updated = appState.activeProject!.sessions.find(s => s.id === session.id)!;
      expect(updated.cost).toEqual(sampleCost);
      // PA-15: +16 ms for the coalescing frame (see the context test above).
      vi.advanceTimersByTime(1016);
      expect(mockSave).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no-op for nonexistent session', () => {
    addProject();
    mockSave.mockClear();
    appState.updateSessionCost('nonexistent', sampleCost);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('updates cost across projects', () => {
    const p1 = addProject('P1', '/p1');
    const p2 = addProject('P2', '/p2');
    const s1 = appState.addSession(p1.id, 'S1')!;
    appState.addSession(p2.id, 'S2');
    appState.updateSessionCost(s1.id, sampleCost);
    const found = appState.projects.find(p => p.id === p1.id)!.sessions.find(s => s.id === s1.id)!;
    expect(found.cost).toEqual(sampleCost);
  });
});

describe('updateSessionContext()', () => {
  const sampleContext = { totalTokens: 5000, contextWindowSize: 200000, usedPercentage: 2.5 };

  it('persists context data on the session record', () => {
    vi.useFakeTimers();
    try {
      const project = addProject();
      const session = appState.addSession(project.id, 'S1')!;
      mockSave.mockClear();
      appState.updateSessionContext(session.id, sampleContext);
      const updated = appState.activeProject!.sessions.find(s => s.id === session.id)!;
      expect(updated.contextWindow).toEqual(sampleContext);
      // PA-15: the persist the cost flush triggers is frame-coalesced, so the
      // 1 s timer only schedules the write; the frame lands 16 ms later.
      vi.advanceTimersByTime(1016);
      expect(mockSave).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no-op for nonexistent session', () => {
    addProject();
    mockSave.mockClear();
    appState.updateSessionContext('nonexistent', sampleContext);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('renameSession()', () => {
  it('updates session name and persists', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    mockSave.mockClear();
    appState.renameSession(project.id, session.id, 'New');
    expect(appState.activeSession!.name).toBe('New');
    appState.flushPersist();
    expect(mockSave).toHaveBeenCalled();
  });

  it('sets userRenamed when passed true', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    appState.renameSession(project.id, session.id, 'Manual', true);
    expect(appState.activeSession!.userRenamed).toBe(true);
  });

  it('does not set userRenamed when param omitted', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    appState.renameSession(project.id, session.id, 'Auto');
    expect(appState.activeSession!.userRenamed).toBeUndefined();
  });

  it('truncates name exceeding MAX_SESSION_NAME_LENGTH', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Old')!;
    const longName = 'A'.repeat(MAX_SESSION_NAME_LENGTH + 40);
    appState.renameSession(project.id, session.id, longName);
    expect(appState.activeSession!.name).toBe('A'.repeat(MAX_SESSION_NAME_LENGTH));
  });

  it('refuses to rename a kanban session', () => {
    const project = addProject('My Project');
    const kanban = appState.openKanbanTab(project.id)!;
    appState.renameSession(project.id, kanban.id, 'Custom', true);
    expect(kanban.name).toBe('My Project - Kanban');
    expect(kanban.userRenamed).toBeUndefined();
  });

  it('refuses to rename a project-tab session', () => {
    const project = addProject('My Project');
    const overview = appState.openProjectTab(project.id)!;
    appState.renameSession(project.id, overview.id, 'Custom', true);
    expect(overview.name).toBe('My Project - Overview');
    expect(overview.userRenamed).toBeUndefined();
  });
});

// --- Cross-slice payloads (PA-25 renderer half + the session-changed contract) ---

describe('session-changed payload', () => {
  const seen: unknown[] = [];
  beforeEach(() => {
    seen.length = 0;
    appState.on('session-changed', (data) => seen.push(data));
  });

  it('names the mutation class for activation, add, remove and adoption', () => {
    const { project, sessions } = addProjectWithSessions(2);
    expect(seen.map((p) => (p as { kind?: string })?.kind)).toEqual(['add', 'add']);
    expect((seen[0] as { sessionId?: string })?.sessionId).toBe(sessions[0].id);

    seen.length = 0;
    appState.setActiveSession(project.id, sessions[0].id);
    expect(seen).toEqual([{ sessionId: sessions[0].id, kind: 'activate' }]);

    seen.length = 0;
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    expect(seen).toEqual([{ sessionId: sessions[0].id, kind: 'metadata' }]);

    seen.length = 0;
    appState.renameSession(project.id, sessions[0].id, 'Title');
    expect(seen).toEqual([{ sessionId: sessions[0].id, kind: 'metadata' }]);

    seen.length = 0;
    appState.reorderSession(project.id, sessions[0].id, 1);
    expect(seen).toEqual([{ sessionId: sessions[0].id, kind: 'reorder' }]);

    seen.length = 0;
    appState.removeSession(project.id, sessions[1].id);
    expect(seen).toEqual([{ sessionId: sessions[1].id, kind: 'remove' }]);
  });
});

describe('archive gate transcript flags (PA-25)', () => {
  // The gate used to call `session:transcriptExistsSync` on every archivable
  // close, blocking the renderer on a main-side stat/decompress. The flag is
  // prefetched asynchronously when a cli id is bound; the sync channel must be
  // untouched on the close path.
  let probe: ReturnType<typeof vi.fn>;
  let probeSync: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    probe = vi.fn(async () => true);
    probeSync = vi.fn(() => true);
    (window as any).finevibe.session = {
      transcriptExists: probe,
      transcriptExistsSync: probeSync,
    };
  });

  const rowFor = (projectId: string, cliSessionId: string) =>
    appState.projects.find((p) => p.id === projectId)!.sessionHistory!.find((a) => a.cliSessionId === cliSessionId);

  it('probes at cli-id bind and closes with zero sync IPC', async () => {
    const { project, sessions } = addProjectWithSessions(1);
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    expect(probe).toHaveBeenCalledWith('claude', 'cli-1', '/test', undefined, sessions[0].id);
    await Promise.resolve();

    appState.removeSession(project.id, sessions[0].id);

    expect(probeSync).not.toHaveBeenCalled();
    expect(rowFor(project.id, 'cli-1')?.transcriptAvailable).toBe(true);
  });

  it('archives best-effort when the flag is unknown (restored tab)', () => {
    const { project, sessions } = addProjectWithSessions(1);
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    (appState as any)['transcriptFlags'].clear(); // a tab restored from disk

    appState.removeSession(project.id, sessions[0].id);

    expect(probeSync).not.toHaveBeenCalled();
    expect(rowFor(project.id, 'cli-1')?.transcriptAvailable).toBe(true);
  });

  it('marks the row unavailable when the probe found no transcript', async () => {
    probe.mockImplementation(async () => false);
    const { project, sessions } = addProjectWithSessions(1);
    appState.updateSessionCliId(project.id, sessions[0].id, 'cli-1');
    await Promise.resolve();

    appState.removeSession(project.id, sessions[0].id);

    expect(probeSync).not.toHaveBeenCalled();
    expect(rowFor(project.id, 'cli-1')?.transcriptAvailable).toBe(false);
  });

  it('probes the restored tabs after load, one at a time', async () => {
    mockLoad.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'p1',
        name: 'P',
        path: '/test',
        sessions: [
          { id: 's1', name: 'S1', cliSessionId: 'cli-a', createdAt: new Date().toISOString(), providerId: 'claude' },
          { id: 's2', name: 'S2', cliSessionId: 'cli-b', createdAt: new Date().toISOString(), providerId: 'claude' },
        ],
        activeSessionId: 's2',
        layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
      }],
      activeProjectId: 'p1',
    });
    await appState.load();
    // load() fires the seed chain without awaiting it: give it the microtasks.
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(probe.mock.calls.map((c) => c[1])).toEqual(['cli-a', 'cli-b']);
    expect(probeSync).not.toHaveBeenCalled();
  });
});
