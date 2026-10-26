import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();
const mockWatchProject = vi.fn();
const mockGetStatus = vi.fn();
const mockGetWorktrees = vi.fn();
const mockOnChanged = vi.fn(() => () => {});

vi.stubGlobal('window', {
  finevibe: {
    store: { load: mockLoad, save: mockSave },
    // PA-25: state.ts prefetches transcript availability on cli-id bind.
    session: { transcriptExists: vi.fn(async () => true) },
    git: {
      watchProject: mockWatchProject,
      getStatus: mockGetStatus,
      getWorktrees: mockGetWorktrees,
      onChanged: mockOnChanged,
    },
  },
});

// git-status's startPolling reads document.hidden and registers a
// visibilitychange listener; provide a minimal stub for the node env.
vi.stubGlobal('document', {
  hidden: false,
  addEventListener: vi.fn(),
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

// Avoid pulling in the full session-activity dependency graph; git-status only
// needs its onChange export to register a status-transition listener.
vi.mock('./session-activity.js', () => ({
  onChange: vi.fn(),
}));

import { appState, _resetForTesting as resetState } from './state';
import {
  startPolling,
  stopPolling,
  setActiveWorktree,
  getActiveGitPath,
  getGitStatus,
  onChange,
  refreshGitStatus,
  _resetForTesting as resetGit,
} from './git-status';

const layout = { mode: 'tabs' as const, splitPanes: [], splitDirection: 'horizontal' as const };

function project(id: string, path: string) {
  return { id, name: id, path, sessions: [], activeSessionId: null, layout };
}

function persisted(projects: ReturnType<typeof project>[], activeProjectId: string | null) {
  return {
    version: 1,
    projects,
    activeProjectId,
    preferences: { soundOnSessionWaiting: true, debugMode: false },
  };
}

const cleanStatus = {
  isGitRepo: true,
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: 1,
  modified: 2,
  untracked: 0,
  conflicted: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockGetStatus.mockResolvedValue(cleanStatus);
  mockGetWorktrees.mockResolvedValue([]);
  resetState();
  resetGit();
});

afterEach(() => {
  stopPolling();
});

describe('git-status state-loaded handling', () => {
  it('watches the project and polls on initial load with an active project but no session', async () => {
    // Cold start: polling begins before state is loaded, so there is no active
    // project yet — nothing should be watched or polled at this point.
    mockLoad.mockResolvedValue(persisted([project('p1', '/proj')], 'p1'));
    startPolling();
    expect(mockWatchProject).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();

    // Loading persisted state emits only 'state-loaded' (not 'project-changed'),
    // which previously left the git panel without any status. The new handler
    // must kick off a watch + poll so a bare project shows its git changes.
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));

    expect(mockWatchProject).toHaveBeenCalledWith('/proj');
  });

  it('polls the newly active project on switch even though the poll timer is already running', async () => {
    // Load with two projects, p1 active — this starts the 60s poll timer.
    mockLoad.mockResolvedValue(persisted([project('p1', '/proj'), project('p2', '/proj2')], 'p1'));
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));
    // Let p1's poll fully settle so no poll is in flight at switch time.
    await vi.waitFor(() => expect(mockGetStatus).toHaveResolved());

    mockWatchProject.mockClear();
    mockGetStatus.mockClear();

    // Switch to p2. The timer is already running, so startInterval() no-ops —
    // the immediate refresh must come from the explicit poll().
    appState.setActiveProject('p2');

    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj2'));
    expect(mockWatchProject).toHaveBeenCalledWith('/proj2');
  });

  it('re-polls the newly active project when a poll was still in flight during the switch', async () => {
    // First getStatus hangs, so a poll stays in flight across the switch. With
    // a plain `if (polling) return` guard the switch poll would be dropped and
    // p2 never fetched until the 60s tick; coalescing must re-poll for p2.
    let releaseFirst!: (v: typeof cleanStatus) => void;
    const firstStatus = new Promise<typeof cleanStatus>((r) => { releaseFirst = r; });
    mockGetStatus.mockReturnValueOnce(firstStatus).mockResolvedValue(cleanStatus);

    mockLoad.mockResolvedValue(persisted([project('p1', '/proj'), project('p2', '/proj2')], 'p1'));
    startPolling();
    await appState.load();
    // p1's poll is now in flight, parked on the hanging getStatus('/proj').
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));

    // Switch while the poll is in flight — must be coalesced, not dropped.
    appState.setActiveProject('p2');

    // Release p1's poll; the coalesced re-poll should then fetch p2.
    releaseFirst(cleanStatus);

    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj2'));
  });

  it('does not watch or poll on load when there is no active project', async () => {
    mockLoad.mockResolvedValue(null); // keeps state empty → no active project
    startPolling();

    await appState.load();
    // Give any stray async work a chance to run.
    await Promise.resolve();

    expect(mockWatchProject).not.toHaveBeenCalled();
    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});

describe('git-status session-changed debounce + key gate (PA-10)', () => {
  type SessionSeed = { id: string; name: string; providerId: string; cliSessionId: string | null };
  function projectWithSessions(id: string, path: string, sessions: SessionSeed[], activeSessionId: string) {
    return { ...project(id, path), sessions, activeSessionId };
  }
  function loadWithSession() {
    mockLoad.mockResolvedValue(persisted(
      [projectWithSessions('p1', '/proj', [{ id: 's1', name: 'S1', providerId: 'claude', cliSessionId: null }], 's1')],
      'p1',
    ));
  }

  it('skips the session-driven poll when (project, worktree) is unchanged', async () => {
    loadWithSession();
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));

    // CLI-id adoption: emits session-changed for the SAME session, same worktree.
    mockGetStatus.mockClear();
    appState.updateSessionCliId('p1', 's1', 'cli-1');

    // Past the 300 ms debounce window: the key gate must drop the poll.
    await new Promise((r) => setTimeout(r, 420));
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('coalesces a session-changed burst into one trailing poll', async () => {
    mockLoad.mockResolvedValue(persisted(
      [projectWithSessions('p1', '/proj', [
        { id: 's1', name: 'S1', providerId: 'claude', cliSessionId: null },
        { id: 's2', name: 'S2', providerId: 'claude', cliSessionId: null },
      ], 's1')],
      'p1',
    ));
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));
    mockGetStatus.mockClear();

    appState.setActiveSession('p1', 's2');
    appState.setActiveSession('p1', 's1');
    expect(mockGetStatus).not.toHaveBeenCalled(); // trailing, not leading

    // One trailing poll for the pair (the final key matches the last fetch,
    // so with s1 back as active the gate may skip entirely — both are ≤1).
    await new Promise((r) => setTimeout(r, 420));
    expect(mockGetStatus.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('S3-04: a tab switch in the same worktree does NOT re-poll (session is not part of the key)', async () => {
    mockLoad.mockResolvedValue(persisted(
      [projectWithSessions('p1', '/proj', [
        { id: 's1', name: 'S1', providerId: 'claude', cliSessionId: null },
        { id: 's2', name: 'S2', providerId: 'claude', cliSessionId: null },
      ], 's1')],
      'p1',
    ));
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));
    mockGetStatus.mockClear();

    appState.setActiveSession('p1', 's2');

    // Past the 300 ms debounce: git status is a pure function of
    // (project, worktree) — the old key included the session id, so the
    // click always differed from lastFetchKey and re-spawned git.
    await new Promise((r) => setTimeout(r, 420));
    expect(mockGetStatus).not.toHaveBeenCalled();
  });
});

// C2R-03 / C2R-05 / C2R-06: the session-changed fan-out carries a kind
// (state.ts SessionChangedPayload); the git panel must react to an actual
// activation, not to every title/CLI-id adoption, must drop every cache key
// of a removed project (plain + composite), and must detect the worktree once
// per burst for the FINAL session.
describe('git-status session-changed payload gating (C2R-03)', () => {
  function loadTwoSessions() {
    mockLoad.mockResolvedValue(persisted(
      [{
        id: 'p1', name: 'p1', path: '/proj', activeSessionId: 's1',
        sessions: [
          { id: 's1', name: 'S1', providerId: 'claude', cliSessionId: null },
          { id: 's2', name: 'S2', providerId: 'claude', cliSessionId: null },
        ],
        layout,
      }],
      'p1',
    ));
  }

  it('keeps a manual worktree override across a metadata adoption and drops it on activation', async () => {
    loadTwoSessions();
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));

    setActiveWorktree('p1', '/wt-b');
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/wt-b'));
    expect(getActiveGitPath('p1')).toBe('/wt-b');

    // CLI-id adoption: kind 'metadata'. The override is a user choice, so an
    // auto-title / cli-id adoption must NOT snap the panel back to the
    // auto-detected worktree (pre-fix it deleted on every fan-out).
    appState.updateSessionCliId('p1', 's1', 'cli-1');
    await new Promise((r) => setTimeout(r, 420));
    expect(getActiveGitPath('p1')).toBe('/wt-b');

    // A real activation is a session switch: auto-detection takes over again.
    appState.setActiveSession('p1', 's2');
    await new Promise((r) => setTimeout(r, 420));
    expect(getActiveGitPath('p1')).toBe('/proj');
  });
});

describe('git-status project-removed cache prune (C2R-05)', () => {
  // PRIVATE ids (order-independence audit): a shuffled predecessor's
  // session-changed continuation re-sets sessionWorktreeMap['s1'] AFTER
  // resetGit clears it; unique session/project ids make that leak inert.
  const projectP1 = () => ({
    id: 'p-c2r', name: 'p-c2r', path: '/c2r/proj', activeSessionId: 's-c2r',
    sessions: [{ id: 's-c2r', name: 'S1', providerId: 'claude', cliSessionId: null }],
    layout,
  });

  it('drops the composite worktree cache keys, not just the plain one', async () => {
    // Two worktrees so the manual override survives refreshWorktrees' cleanup
    // during the first phase and the poll runs under the composite `p1:/wt-b`
    // key. Removal then prunes the override (C5G-02), so the re-open below
    // polls the project's default path, not `/wt-b`.
    // Delta window (order-independence audit): a shuffled predecessor's
    // trailing debounce poll can straddle the test boundary; only polls
    // started by THIS case are evidence.
    const base = mockGetStatus.mock.calls.length;
    const polls = () => mockGetStatus.mock.calls.slice(base).map((c) => c[0] as string);
    mockGetWorktrees.mockResolvedValue([
      { path: '/c2r/proj', branch: 'main', isMain: true },
      { path: '/c2r/wt-b', branch: 'feature', isMain: false },
    ]);
    mockLoad.mockResolvedValue(persisted([projectP1()], 'p-c2r'));
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(polls()).toContain('/c2r/proj'));

    // Polls cache under BOTH keys: the plain projectId and `${projectId}:${gitPath}`.
    setActiveWorktree('p-c2r', '/c2r/wt-b');
    await vi.waitFor(() => expect(polls()).toContain('/c2r/wt-b'));

    const seen = vi.fn();
    onChange(seen);

    appState.removeProject('p-c2r');
    expect(getGitStatus('p-c2r')).toBeNull();

    // Re-open the SAME project id (persisted ids survive a reload) with an
    // identical status. The listeners must fire again: that only happens when
    // no cache entry survived the removal. Pre-fix the composite `p1:/wt-b`
    // entry leaked, its JSON compared equal, and the project came back with a
    // silently dead git badge.
    mockLoad.mockResolvedValue(persisted([projectP1()], 'p-c2r'));
    await appState.load();

    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith('p-c2r', cleanStatus));
    // C5G-02: removal pruned the manualOverride, so the re-opened project no
    // longer pins `/wt-b` — the active path falls back to the project default.
    expect(getActiveGitPath('p-c2r')).toBe('/c2r/proj');
    expect(polls().at(-1)).toBe('/c2r/proj');
  });
});

describe('git-status worktree detection cost (C2R-06)', () => {
  const getCwd = vi.fn(async () => '/wt-b');

  beforeEach(() => {
    (window.finevibe as unknown as { pty: { getCwd: typeof getCwd } }).pty = { getCwd };
    getCwd.mockClear();
  });

  it('does not pay a getCwd IPC when the project has no extra worktrees', async () => {
    mockLoad.mockResolvedValue(persisted(
      [{
        id: 'p1', name: 'p1', path: '/proj', activeSessionId: 's1',
        sessions: [{ id: 's1', name: 'S1', providerId: 'claude', cliSessionId: null }],
        layout,
      }],
      'p1',
    ));
    mockGetWorktrees.mockResolvedValue([{ path: '/proj', branch: 'main', isMain: true }]);
    startPolling();
    await appState.load();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledWith('/proj'));
    getCwd.mockClear();

    // Poll pass (detectSessionWorktree) + a session-changed burst: with a
    // single worktree the cached list is the local bail, so no IPC at all.
    appState.setActiveSession('p1', 's1');
    await new Promise((r) => setTimeout(r, 420));
    refreshGitStatus();
    await vi.waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2));
    expect(getCwd).not.toHaveBeenCalled();
  });
});
