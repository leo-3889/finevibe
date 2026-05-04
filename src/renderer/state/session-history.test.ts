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

function mockCostData() {
  mockGetCost.mockReturnValue({
    totalCostUsd: 0.42,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalDurationMs: 5000,
    totalApiDurationMs: 3000,
  });
}

describe('archiveSession via removeSession()', () => {
  it('archives CLI session on close', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'My Session')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-123');
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('My Session');
    expect(history[0].cliSessionId).toBe('cli-123');
    expect(history[0].createdAt).toBe(session.createdAt);
    expect(history[0].closedAt).toBeDefined();
    expect(history[0].providerId).toBe('claude');
  });

  it('archives Copilot sessions once a cliSessionId is available', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Copilot Session', undefined, 'copilot')!;
    appState.updateSessionCliId(project.id, session.id, 'copilot-cli-123');
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('Copilot Session');
    expect(history[0].providerId).toBe('copilot');
    expect(history[0].cliSessionId).toBe('copilot-cli-123');
  });

  it('captures cost data when available', () => {
    mockCostData();
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-cost');
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history[0].cost).not.toBeNull();
    expect(history[0].cost!.totalCostUsd).toBe(0.42);
    expect(history[0].cost!.totalInputTokens).toBe(1000);
    expect(history[0].cost!.totalOutputTokens).toBe(500);
    expect(history[0].cost!.totalDurationMs).toBe(5000);
  });

  it('archives with null cost when no cost data', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-no-cost');
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history[0].cost).toBeNull();
  });

  it('does NOT archive empty sessions (no cliSessionId, no cost)', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Empty')!;
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);
  });

  it('archives session with cost data but no cliSessionId', () => {
    mockCostData();
    const project = addProject();
    const session = appState.addSession(project.id, 'CostOnly')!;
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(1);
    expect(history[0].cliSessionId).toBeNull();
    expect(history[0].cost).not.toBeNull();
    expect(history[0].cost!.totalCostUsd).toBe(0.42);
  });

  it('does NOT archive diff-viewer sessions', () => {
    const project = addProject();
    const session = appState.addDiffViewerSession(project.id, '/f.ts', 'staged')!;
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);
  });

  it('does NOT archive file-reader sessions', () => {
    const project = addProject();
    const session = appState.addFileReaderSession(project.id, '/f.ts')!;
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);
  });

  it('does NOT archive mcp-inspector sessions', () => {
    const project = addProject();
    const session = appState.addMcpInspectorSession(project.id, 'Inspector')!;
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);
  });

  it('deduplicates by cliSessionId', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-abc');
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);

    // Resume and close again
    const resumed = appState.resumeFromHistory(project.id, appState.getSessionHistory(project.id)[0].id)!;
    appState.removeSession(project.id, resumed.id);
    // Should still be 1 entry, not 2
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);
  });

  it('updates cost on deduplicated re-close', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-abc');
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)[0].cost).toBeNull();

    // Resume with cost data
    const resumed = appState.resumeFromHistory(project.id, appState.getSessionHistory(project.id)[0].id)!;
    mockCostData();
    appState.removeSession(project.id, resumed.id);
    expect(appState.getSessionHistory(project.id)[0].cost).not.toBeNull();
    expect(appState.getSessionHistory(project.id)[0].cost!.totalCostUsd).toBe(0.42);
  });

  it('updates name on deduplicated re-close', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Original')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-abc');
    appState.removeSession(project.id, session.id);

    const resumed = appState.resumeFromHistory(project.id, appState.getSessionHistory(project.id)[0].id)!;
    appState.renameSession(project.id, resumed.id, 'Renamed');
    appState.removeSession(project.id, resumed.id);
    expect(appState.getSessionHistory(project.id)[0].name).toBe('Renamed');
  });

  it('caps history at 500 entries', () => {
    const project = addProject();
    // Manually set up 500 history entries
    const p = appState.projects.find((p) => p.id === project.id)!;
    p.sessionHistory = [];
    for (let i = 0; i < 500; i++) {
      p.sessionHistory.push({
        id: `old-${i}`,
        name: `Old ${i}`,
        providerId: 'claude',
        cliSessionId: null,
        createdAt: new Date().toISOString(),
        closedAt: new Date().toISOString(),
        cost: null,
      });
    }

    const session = appState.addSession(project.id, 'New')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-new');
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(500);
    // Oldest entry should have been dropped
    expect(history[0].id).toBe('old-1');
    expect(history[history.length - 1].name).toBe('New');
  });

  it('emits history-changed on archive', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-emit');
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.removeSession(project.id, session.id);
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('bulk removeAllSessions archives each', () => {
    const { project, sessions } = addProjectWithSessions(3);
    sessions.forEach((s, i) => appState.updateSessionCliId(project.id, s.id, `cli-bulk-${i}`));
    appState.removeAllSessions(project.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(3);
  });

  it('does NOT archive when sessionHistoryEnabled is false', () => {
    appState.setPreference('sessionHistoryEnabled', false);
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.removeSession(project.id, session.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);
  });

  it('preserves existing history when sessionHistoryEnabled is disabled', () => {
    const project = addProject();
    const session1 = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session1.id, 'cli-preserve');
    appState.removeSession(project.id, session1.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);

    appState.setPreference('sessionHistoryEnabled', false);
    const session2 = appState.addSession(project.id, 'S2')!;
    appState.removeSession(project.id, session2.id);
    // Still 1 — second session was not archived
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);
    expect(appState.getSessionHistory(project.id)[0].name).toBe('S1');
  });

  it('resumes archiving when sessionHistoryEnabled is re-enabled', () => {
    appState.setPreference('sessionHistoryEnabled', false);
    const project = addProject();
    const session1 = appState.addSession(project.id, 'S1')!;
    appState.removeSession(project.id, session1.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(0);

    appState.setPreference('sessionHistoryEnabled', true);
    const session2 = appState.addSession(project.id, 'S2')!;
    appState.updateSessionCliId(project.id, session2.id, 'cli-resume-pref');
    appState.removeSession(project.id, session2.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);
    expect(appState.getSessionHistory(project.id)[0].name).toBe('S2');
  });
});

describe('getSessionHistory()', () => {
  it('returns empty array for project with no history', () => {
    const project = addProject();
    expect(appState.getSessionHistory(project.id)).toEqual([]);
  });

  it('returns empty array for nonexistent project', () => {
    expect(appState.getSessionHistory('nonexistent')).toEqual([]);
  });
});

describe('removeHistoryEntry()', () => {
  it('removes a single history entry by id', () => {
    const project = addProject();
    const s1 = appState.addSession(project.id, 'S1')!;
    const s2 = appState.addSession(project.id, 'S2')!;
    appState.updateSessionCliId(project.id, s1.id, 'cli-s1');
    appState.updateSessionCliId(project.id, s2.id, 'cli-s2');
    appState.removeSession(project.id, s1.id);
    appState.removeSession(project.id, s2.id);
    const historyBefore = appState.getSessionHistory(project.id);
    expect(historyBefore).toHaveLength(2);

    const entryToRemove = historyBefore.find(h => h.name === 'S1')!;
    appState.removeHistoryEntry(project.id, entryToRemove.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(1);
    expect(history[0].name).toBe('S2');
  });

  it('no-op for nonexistent project', () => {
    // Should not throw
    appState.removeHistoryEntry('bad-project', 'bad-id');
  });

  it('no-op for nonexistent entry id', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-noop');
    appState.removeSession(project.id, session.id);
    appState.removeHistoryEntry(project.id, 'nonexistent');
    expect(appState.getSessionHistory(project.id)).toHaveLength(1);
  });

  it('emits history-changed', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-emit-hist');
    appState.removeSession(project.id, session.id);
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.removeHistoryEntry(project.id, session.id);
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('persists after removal', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-persist');
    appState.removeSession(project.id, session.id);
    mockSave.mockClear();
    appState.removeHistoryEntry(project.id, session.id);
    expect(mockSave).toHaveBeenCalled();
  });
});

describe('clearSessionHistory()', () => {
  it('clears all history for a project', () => {
    const { project, sessions } = addProjectWithSessions(3);
    sessions.forEach((s, i) => appState.updateSessionCliId(project.id, s.id, `cli-clear-${i}`));
    appState.removeAllSessions(project.id);
    expect(appState.getSessionHistory(project.id)).toHaveLength(3);
    appState.clearSessionHistory(project.id);
    expect(appState.getSessionHistory(project.id)).toEqual([]);
  });

  it('emits history-changed', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-clear-emit');
    appState.removeSession(project.id, session.id);
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.clearSessionHistory(project.id);
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('persists', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-clear-persist');
    appState.removeSession(project.id, session.id);
    mockSave.mockClear();
    appState.clearSessionHistory(project.id);
    expect(mockSave).toHaveBeenCalled();
  });

  it('no-op for nonexistent project', () => {
    // Should not throw
    appState.clearSessionHistory('nonexistent');
  });

  it('preserves bookmarked sessions when clearing', () => {
    const { project, sessions } = addProjectWithSessions(3);
    sessions.forEach((s, i) => appState.updateSessionCliId(project.id, s.id, `cli-bm-clear-${i}`));
    appState.removeAllSessions(project.id);
    const historyBefore = appState.getSessionHistory(project.id);
    expect(historyBefore).toHaveLength(3);

    const entryToBookmark = historyBefore.find(h => h.name === sessions[1].name)!;
    appState.toggleBookmark(project.id, entryToBookmark.id);
    appState.clearSessionHistory(project.id);
    const remaining = appState.getSessionHistory(project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe(sessions[1].name);
    expect(remaining[0].bookmarked).toBe(true);
  });
});

describe('toggleBookmark()', () => {
  it('toggles bookmark on a history entry', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-bm-toggle');
    appState.removeSession(project.id, session.id);

    const entry = appState.getSessionHistory(project.id)[0];
    expect(entry.bookmarked).toBeFalsy();

    appState.toggleBookmark(project.id, entry.id);
    expect(appState.getSessionHistory(project.id)[0].bookmarked).toBe(true);

    appState.toggleBookmark(project.id, entry.id);
    expect(appState.getSessionHistory(project.id)[0].bookmarked).toBe(false);
  });

  it('emits history-changed', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-bm-emit');
    appState.removeSession(project.id, session.id);
    const entry = appState.getSessionHistory(project.id)[0];
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.toggleBookmark(project.id, entry.id);
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('persists after toggling', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-bm-persist');
    appState.removeSession(project.id, session.id);
    const entry = appState.getSessionHistory(project.id)[0];
    mockSave.mockClear();
    appState.toggleBookmark(project.id, entry.id);
    expect(mockSave).toHaveBeenCalled();
  });

  it('no-op for nonexistent project', () => {
    appState.toggleBookmark('bad-project', 'bad-id');
  });

  it('no-op for nonexistent entry', () => {
    const project = addProject();
    appState.toggleBookmark(project.id, 'nonexistent');
  });

  it('archived entries from same session via /clear get unique IDs', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-first');
    // Simulate /clear: session gets a new CLI session ID, old state is archived
    appState.updateSessionCliId(project.id, session.id, 'cli-second');
    // Close the session — archives again with the new CLI session ID
    appState.removeSession(project.id, session.id);
    const history = appState.getSessionHistory(project.id);
    expect(history).toHaveLength(2);
    // Both entries must have unique IDs
    expect(history[0].id).not.toBe(history[1].id);

    // Bookmarking each entry should only affect that entry
    appState.toggleBookmark(project.id, history[1].id);
    const afterToggle = appState.getSessionHistory(project.id);
    expect(afterToggle[1].bookmarked).toBe(true);
    expect(afterToggle[0].bookmarked).toBeFalsy();
  });
});

describe('resumeFromHistory()', () => {
  it('creates new session from archived entry', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-resume');
    appState.removeSession(project.id, session.id);

    const archived = appState.getSessionHistory(project.id)[0];
    const resumed = appState.resumeFromHistory(project.id, archived.id)!;
    expect(resumed).toBeDefined();
    expect(resumed.cliSessionId).toBe('cli-resume');
    expect(resumed.name).toBe('S1');
    expect(resumed.providerId).toBe('claude');
    expect(resumed.id).not.toBe(session.id); // new id
    expect(resumed.createdAt).toBeDefined(); // has its own createdAt
  });

  it('sets resumed session as active', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-123');
    appState.removeSession(project.id, session.id);

    const archived = appState.getSessionHistory(project.id)[0];
    const resumed = appState.resumeFromHistory(project.id, archived.id)!;
    expect(appState.activeProject!.activeSessionId).toBe(resumed.id);
  });

  it('emits session-added and session-changed', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-123');
    appState.removeSession(project.id, session.id);

    const addedCb = vi.fn();
    const changedCb = vi.fn();
    appState.on('session-added', addedCb);
    appState.on('session-changed', changedCb);

    const archived = appState.getSessionHistory(project.id)[0];
    appState.resumeFromHistory(project.id, archived.id);
    expect(addedCb).toHaveBeenCalledTimes(1);
    expect(changedCb).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.resumeFromHistory('nonexistent', 'any')).toBeUndefined();
  });

  it('returns undefined for nonexistent archived id', () => {
    const project = addProject();
    expect(appState.resumeFromHistory(project.id, 'nonexistent')).toBeUndefined();
  });

  it('returns undefined when archived session has no cliSessionId', () => {
    mockCostData(); // need cost data so session gets archived despite no cliSessionId
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    // Don't set cliSessionId
    appState.removeSession(project.id, session.id);

    const archived = appState.getSessionHistory(project.id)[0];
    expect(archived.cliSessionId).toBeNull();
    expect(appState.resumeFromHistory(project.id, archived.id)).toBeUndefined();
  });

  it('activates existing tab instead of creating duplicate when cliSessionId matches', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-dup');
    appState.removeSession(project.id, session.id);

    // Resume once — creates a new tab
    const archived = appState.getSessionHistory(project.id)[0];
    const first = appState.resumeFromHistory(project.id, archived.id)!;
    expect(appState.activeProject!.sessions).toHaveLength(1);

    // Add another session to switch away
    appState.addSession(project.id, 'S2');
    expect(appState.activeProject!.activeSessionId).not.toBe(first.id);

    // Resume same history entry again — should activate existing tab, not create a new one
    const second = appState.resumeFromHistory(project.id, archived.id)!;
    expect(second.id).toBe(first.id);
    expect(appState.activeProject!.sessions).toHaveLength(2); // S1 resumed + S2, not 3
    expect(appState.activeProject!.activeSessionId).toBe(first.id);
  });

  it('does not emit session-added when activating existing tab', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-dup');
    appState.removeSession(project.id, session.id);

    const archived = appState.getSessionHistory(project.id)[0];
    appState.resumeFromHistory(project.id, archived.id);

    const addedCb = vi.fn();
    appState.on('session-added', addedCb);
    appState.resumeFromHistory(project.id, archived.id);
    expect(addedCb).not.toHaveBeenCalled();
  });

  it('persists', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-123');
    appState.removeSession(project.id, session.id);
    mockSave.mockClear();

    const archived = appState.getSessionHistory(project.id)[0];
    appState.resumeFromHistory(project.id, archived.id);
    expect(mockSave).toHaveBeenCalled();
  });

  it('adds resumed session to splitPanes when in swarm mode', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-swarm');
    appState.removeSession(project.id, session.id);

    // Switch to swarm mode
    project.layout.mode = 'swarm';
    project.layout.splitPanes = [];

    const archived = appState.getSessionHistory(project.id)[0];
    const resumed = appState.resumeFromHistory(project.id, archived.id)!;
    expect(resumed).toBeDefined();
    expect(project.layout.splitPanes).toContain(resumed.id);
  });

  it('does not add to splitPanes when in tabs mode', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-tabs');
    appState.removeSession(project.id, session.id);

    project.layout.mode = 'tabs';
    project.layout.splitPanes = [];

    const archived = appState.getSessionHistory(project.id)[0];
    const resumed = appState.resumeFromHistory(project.id, archived.id)!;
    expect(resumed).toBeDefined();
    expect(project.layout.splitPanes).toHaveLength(0);
  });
});

describe('renameSession() history sync', () => {
  it('updates matching history entry name on rename', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'Original')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-sync');
    appState.removeSession(project.id, session.id);

    const resumed = appState.resumeFromHistory(project.id, appState.getSessionHistory(project.id)[0].id)!;
    appState.renameSession(project.id, resumed.id, 'Updated');
    expect(appState.getSessionHistory(project.id)[0].name).toBe('Updated');
  });

  it('emits history-changed on rename', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    appState.updateSessionCliId(project.id, session.id, 'cli-sync');
    appState.removeSession(project.id, session.id);

    const resumed = appState.resumeFromHistory(project.id, appState.getSessionHistory(project.id)[0].id)!;
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.renameSession(project.id, resumed.id, 'New Name');
    expect(cb).toHaveBeenCalledWith(project.id);
  });

  it('does not affect history when session has no cliSessionId', () => {
    const project = addProject();
    const session = appState.addSession(project.id, 'S1')!;
    const cb = vi.fn();
    appState.on('history-changed', cb);
    appState.renameSession(project.id, session.id, 'Renamed');
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('openCliSession()', () => {
  it('creates a new session with the given cliSessionId', () => {
    const project = addProject();
    const session = appState.openCliSession(project.id, 'cli-abc-123', 'My Session')!;
    expect(session).toBeDefined();
    expect(session.cliSessionId).toBe('cli-abc-123');
    expect(session.name).toBe('My Session');
    expect(session.providerId).toBe('claude');
  });

  it('sets the new session as active', () => {
    const project = addProject();
    const session = appState.openCliSession(project.id, 'cli-abc-123', 'My Session')!;
    expect(appState.activeProject!.activeSessionId).toBe(session.id);
  });

  it('activates existing tab when cliSessionId already open', () => {
    const project = addProject();
    const first = appState.openCliSession(project.id, 'cli-same', 'Session A')!;
    appState.addSession(project.id, 'Other');
    expect(appState.activeProject!.activeSessionId).not.toBe(first.id);

    const second = appState.openCliSession(project.id, 'cli-same', 'Session A')!;
    expect(second.id).toBe(first.id);
    expect(appState.activeProject!.sessions).toHaveLength(2); // no duplicate created
  });

  it('emits session-added for new session', () => {
    const project = addProject();
    const addedCb = vi.fn();
    appState.on('session-added', addedCb);
    appState.openCliSession(project.id, 'cli-xyz', 'S');
    expect(addedCb).toHaveBeenCalledTimes(1);
  });

  it('does not emit session-added when activating existing tab', () => {
    const project = addProject();
    appState.openCliSession(project.id, 'cli-dup', 'S');
    const addedCb = vi.fn();
    appState.on('session-added', addedCb);
    appState.openCliSession(project.id, 'cli-dup', 'S');
    expect(addedCb).not.toHaveBeenCalled();
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.openCliSession('no-such-project', 'cli-123', 'S')).toBeUndefined();
  });

  it('persists state after opening session', () => {
    const project = addProject();
    mockSave.mockClear();
    appState.openCliSession(project.id, 'cli-persist', 'S');
    expect(mockSave).toHaveBeenCalled();
  });

  it('appends to swarm splitPanes when in swarm mode', () => {
    const project = addProject();
    appState.toggleSwarm();
    const session = appState.openCliSession(project.id, 'cli-swarm', 'S')!;
    expect(appState.activeProject!.layout.splitPanes).toContain(session.id);
  });
});

