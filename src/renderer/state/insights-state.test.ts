import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  vibeyard: {
    store: { load: mockLoad, save: mockSave },
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

import { appState, _resetForTesting } from '../state';
import { getCost } from '../session-cost.js';
const mockGetCost = vi.mocked(getCost);

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

describe('addInsightSnapshot()', () => {
  it('creates insights data if not present and stores snapshot', () => {
    const project = addProject();
    const snapshot = {
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      totalTokens: 30000,
      contextWindowSize: 200000,
      usedPercentage: 15,
    };
    appState.addInsightSnapshot(project.id, snapshot);
    expect(project.insights).toBeDefined();
    expect(project.insights!.initialContextSnapshots).toHaveLength(1);
    expect(project.insights!.initialContextSnapshots[0]).toEqual(snapshot);
  });

  it('appends to existing snapshots', () => {
    const project = addProject();
    const s1 = { sessionId: 's1', timestamp: new Date().toISOString(), totalTokens: 10000, contextWindowSize: 200000, usedPercentage: 5 };
    const s2 = { sessionId: 's2', timestamp: new Date().toISOString(), totalTokens: 20000, contextWindowSize: 200000, usedPercentage: 10 };
    appState.addInsightSnapshot(project.id, s1);
    appState.addInsightSnapshot(project.id, s2);
    expect(project.insights!.initialContextSnapshots).toHaveLength(2);
  });

  it('caps at 50 snapshots, keeping most recent', () => {
    const project = addProject();
    for (let i = 0; i < 55; i++) {
      appState.addInsightSnapshot(project.id, {
        sessionId: `s${i}`,
        timestamp: new Date().toISOString(),
        totalTokens: i * 1000,
        contextWindowSize: 200000,
        usedPercentage: i,
      });
    }
    expect(project.insights!.initialContextSnapshots).toHaveLength(50);
    // Should keep the last 50 (indices 5–54)
    expect(project.insights!.initialContextSnapshots[0].sessionId).toBe('s5');
    expect(project.insights!.initialContextSnapshots[49].sessionId).toBe('s54');
  });

  it('persists after adding snapshot', () => {
    const project = addProject();
    mockSave.mockClear();
    appState.addInsightSnapshot(project.id, {
      sessionId: 's1', timestamp: '', totalTokens: 0, contextWindowSize: 200000, usedPercentage: 0,
    });
    expect(mockSave).toHaveBeenCalled();
  });

  it('emits insights-changed event', () => {
    const project = addProject();
    const cb = vi.fn();
    appState.on('insights-changed', cb);
    appState.addInsightSnapshot(project.id, {
      sessionId: 's1', timestamp: '', totalTokens: 0, contextWindowSize: 200000, usedPercentage: 0,
    });
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('no-op for nonexistent project', () => {
    mockSave.mockClear();
    appState.addInsightSnapshot('nonexistent', {
      sessionId: 's1', timestamp: '', totalTokens: 0, contextWindowSize: 200000, usedPercentage: 0,
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('preserves dismissed list when adding snapshots', () => {
    const project = addProject();
    appState.dismissInsight(project.id, 'some-insight');
    appState.addInsightSnapshot(project.id, {
      sessionId: 's1', timestamp: '', totalTokens: 0, contextWindowSize: 200000, usedPercentage: 0,
    });
    expect(project.insights!.dismissed).toContain('some-insight');
  });
});

describe('dismissInsight()', () => {
  it('adds insightId to dismissed list', () => {
    const project = addProject();
    appState.dismissInsight(project.id, 'big-initial-context');
    expect(project.insights!.dismissed).toContain('big-initial-context');
  });

  it('creates insights data if not present', () => {
    const project = addProject();
    expect(project.insights).toBeUndefined();
    appState.dismissInsight(project.id, 'test-insight');
    expect(project.insights).toBeDefined();
    expect(project.insights!.initialContextSnapshots).toEqual([]);
  });

  it('does not add duplicate dismissals', () => {
    const project = addProject();
    appState.dismissInsight(project.id, 'big-initial-context');
    appState.dismissInsight(project.id, 'big-initial-context');
    expect(project.insights!.dismissed.filter(d => d === 'big-initial-context')).toHaveLength(1);
  });

  it('persists after dismissal', () => {
    const project = addProject();
    mockSave.mockClear();
    appState.dismissInsight(project.id, 'test');
    expect(mockSave).toHaveBeenCalled();
  });

  it('emits insights-changed event', () => {
    const project = addProject();
    const cb = vi.fn();
    appState.on('insights-changed', cb);
    appState.dismissInsight(project.id, 'test');
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('no-op for nonexistent project', () => {
    mockSave.mockClear();
    appState.dismissInsight('nonexistent', 'test');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('can dismiss multiple different insights', () => {
    const project = addProject();
    appState.dismissInsight(project.id, 'insight-a');
    appState.dismissInsight(project.id, 'insight-b');
    expect(project.insights!.dismissed).toEqual(['insight-a', 'insight-b']);
  });
});

describe('isInsightDismissed()', () => {
  it('returns true for dismissed insight', () => {
    const project = addProject();
    appState.dismissInsight(project.id, 'big-initial-context');
    expect(appState.isInsightDismissed(project.id, 'big-initial-context')).toBe(true);
  });

  it('returns false for non-dismissed insight', () => {
    const project = addProject();
    expect(appState.isInsightDismissed(project.id, 'big-initial-context')).toBe(false);
  });

  it('returns false for nonexistent project', () => {
    expect(appState.isInsightDismissed('nonexistent', 'big-initial-context')).toBe(false);
  });

  it('returns false for project with no insights data', () => {
    const project = addProject();
    expect(project.insights).toBeUndefined();
    expect(appState.isInsightDismissed(project.id, 'anything')).toBe(false);
  });
});

describe('navigateBack()/navigateForward()', () => {
  it('walks backward and forward through visited sessions', () => {
    const { project, sessions } = addProjectWithSessions(3);
    // addSession already pushes each into nav history (S1, S2, S3), active=S3
    expect(project.activeSessionId).toBe(sessions[2].id);

    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[1].id);
    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[0].id);
    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[0].id); // clamped

    appState.navigateForward();
    expect(project.activeSessionId).toBe(sessions[1].id);
    appState.navigateForward();
    expect(project.activeSessionId).toBe(sessions[2].id);
    appState.navigateForward();
    expect(project.activeSessionId).toBe(sessions[2].id); // clamped
  });

  it('truncates the forward stack on a new visit', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.navigateBack();
    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[0].id);

    appState.setActiveSession(project.id, sessions[2].id);
    // Forward stack should be cleared; navigateForward is now a no-op
    appState.navigateForward();
    expect(project.activeSessionId).toBe(sessions[2].id);

    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[0].id);
  });

  it('skips sessions removed from history', () => {
    const { project, sessions } = addProjectWithSessions(3);
    // active=S3, history=[S1,S2,S3]
    appState.removeSession(project.id, sessions[1].id);
    // S2 pruned. History=[S1,S3], active=S3.
    appState.navigateBack();
    expect(project.activeSessionId).toBe(sessions[0].id);
  });

  it('navigates across projects', () => {
    const projectA = addProject('A', '/a');
    const sA = appState.addSession(projectA.id, 'A1')!;
    const projectB = addProject('B', '/b');
    const sB = appState.addSession(projectB.id, 'B1')!;

    expect(appState.activeProjectId).toBe(projectB.id);
    appState.navigateBack();
    expect(appState.activeProjectId).toBe(projectA.id);
    expect(projectA.activeSessionId).toBe(sA.id);

    appState.navigateForward();
    expect(appState.activeProjectId).toBe(projectB.id);
    expect(projectB.activeSessionId).toBe(sB.id);
  });

  it('does not re-push during back/forward navigation', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.navigateBack();
    appState.navigateBack();
    // Should still be able to walk all the way forward to the original tail
    appState.navigateForward();
    appState.navigateForward();
    expect(project.activeSessionId).toBe(sessions[2].id);
  });

  it('prunes a removed session from nav history without corrupting preceding entries', () => {
    const { project, sessions } = addProjectWithSessions(3);
    appState.removeSession(project.id, sessions[2].id);
    appState.navigateBack();
    expect(appState.activeProject!.activeSessionId).toBe(sessions[0].id);
  });
});

describe('setProjectReadiness()', () => {
  function makeResult(overall = 80, t = '2025-01-01T00:00:00.000Z'): Parameters<typeof appState.setProjectReadiness>[1] {
    return {
      overallScore: overall,
      scannedAt: t,
      categories: [
        { id: 'instructions', name: 'Instructions', weight: 0.5, score: 90, checks: [] },
        { id: 'context', name: 'Context', weight: 0.5, score: 70, checks: [] },
      ],
    };
  }

  it('sets readiness on the project, persists, and emits readiness-changed', () => {
    const project = addProject();
    const cb = vi.fn();
    appState.on('readiness-changed', cb);
    const result = makeResult();
    appState.setProjectReadiness(project.id, result);
    expect(project.readiness).toBe(result);
    expect(cb).toHaveBeenCalledWith(project.id);
    expect(mockSave).toHaveBeenCalled();
  });

  it('is a no-op for unknown projectId', () => {
    const cb = vi.fn();
    appState.on('readiness-changed', cb);
    appState.setProjectReadiness('missing', makeResult());
    expect(cb).not.toHaveBeenCalled();
  });

  it('appends a snapshot to readinessHistory on each call', () => {
    const project = addProject();
    appState.setProjectReadiness(project.id, makeResult(60, '2025-01-01T00:00:00.000Z'));
    appState.setProjectReadiness(project.id, makeResult(75, '2025-01-02T00:00:00.000Z'));

    const history = project.readinessHistory!;
    expect(history).toHaveLength(2);
    expect(history[0].overallScore).toBe(60);
    expect(history[1].overallScore).toBe(75);
    expect(history[1].categoryScores).toEqual({ instructions: 90, context: 70 });
    expect(history[1].timestamp).toBe('2025-01-02T00:00:00.000Z');
  });

  it('caps readinessHistory at 30 entries (FIFO)', () => {
    const project = addProject();
    for (let i = 0; i < 35; i++) {
      appState.setProjectReadiness(project.id, makeResult(i, `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    }
    const history = project.readinessHistory!;
    expect(history).toHaveLength(30);
    expect(history[0].overallScore).toBe(5);
    expect(history[29].overallScore).toBe(34);
  });
});
