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

describe('addDiffViewerSession()', () => {
  it('creates a diff-viewer session', () => {
    const project = addProject();
    const session = appState.addDiffViewerSession(project.id, '/path/to/file.ts', 'staged')!;
    expect(session.type).toBe('diff-viewer');
    expect(session.diffFilePath).toBe('/path/to/file.ts');
    expect(session.diffArea).toBe('staged');
    expect(session.name).toBe('file.ts');
  });

  it('deduplicates existing same file+area+worktree', () => {
    const project = addProject();
    const s1 = appState.addDiffViewerSession(project.id, '/f.ts', 'staged', '/wt')!;
    const s2 = appState.addDiffViewerSession(project.id, '/f.ts', 'staged', '/wt')!;
    expect(s2.id).toBe(s1.id);
    expect(appState.activeProject!.sessions).toHaveLength(1);
  });

  it('does not deduplicate different area', () => {
    const project = addProject();
    appState.addDiffViewerSession(project.id, '/f.ts', 'staged');
    appState.addDiffViewerSession(project.id, '/f.ts', 'unstaged');
    expect(appState.activeProject!.sessions).toHaveLength(2);
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.addDiffViewerSession('nope', '/f', 'staged')).toBeUndefined();
  });
});

describe('addFileReaderSession()', () => {
  it('creates a file-reader session', () => {
    const project = addProject();
    const session = appState.addFileReaderSession(project.id, '/path/to/readme.md')!;
    expect(session.type).toBe('file-reader');
    expect(session.fileReaderPath).toBe('/path/to/readme.md');
    expect(session.name).toBe('readme.md');
  });

  it('deduplicates existing same path', () => {
    const project = addProject();
    const s1 = appState.addFileReaderSession(project.id, '/f.ts')!;
    const s2 = appState.addFileReaderSession(project.id, '/f.ts')!;
    expect(s2.id).toBe(s1.id);
    expect(appState.activeProject!.sessions).toHaveLength(1);
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.addFileReaderSession('nope', '/f')).toBeUndefined();
  });
});

describe('addMcpInspectorSession()', () => {
  it('creates an mcp-inspector session', () => {
    const project = addProject();
    const session = appState.addMcpInspectorSession(project.id, 'Inspector')!;
    expect(session.type).toBe('mcp-inspector');
    expect(session.name).toBe('Inspector');
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.addMcpInspectorSession('nope', 'I')).toBeUndefined();
  });
});

describe('openKanbanTab()', () => {
  it('creates a kanban session with locked name', () => {
    const project = addProject('Acme');
    const session = appState.openKanbanTab(project.id)!;
    expect(session.type).toBe('kanban');
    expect(session.name).toBe('Acme - Kanban');
    expect(project.activeSessionId).toBe(session.id);
  });

  it('reuses an existing kanban session instead of creating a duplicate', () => {
    const project = addProject('Acme');
    const first = appState.openKanbanTab(project.id)!;
    const second = appState.openKanbanTab(project.id)!;
    expect(second.id).toBe(first.id);
    expect(project.sessions.filter((s) => s.type === 'kanban')).toHaveLength(1);
  });
});

describe('openProjectTab()', () => {
  it('creates a project-tab session named "<project> - Overview"', () => {
    const project = addProject('Acme');
    const session = appState.openProjectTab(project.id)!;
    expect(session.type).toBe('project-tab');
    expect(session.name).toBe('Acme - Overview');
  });
});

describe('addPlanSession()', () => {
  it('uses providerIdOverride when provided', () => {
    const project = addProject();
    const session = appState.addPlanSession(project.id, 'Plan', true, 'copilot')!;
    expect(session.providerId).toBe('copilot');
  });

  it('providerIdOverride wins over preferences.defaultProvider', () => {
    appState.setPreference('defaultProvider', 'gemini');
    const project = addProject();
    const session = appState.addPlanSession(project.id, 'Plan', true, 'copilot')!;
    expect(session.providerId).toBe('copilot');
  });

  it('falls back to preferences.defaultProvider when override absent', () => {
    appState.setPreference('defaultProvider', 'gemini');
    const project = addProject();
    const session = appState.addPlanSession(project.id, 'Plan', true)!;
    expect(session.providerId).toBe('gemini');
  });

  it('returns undefined for nonexistent project', () => {
    expect(appState.addPlanSession('no-such-project', 'Plan', true, 'claude')).toBeUndefined();
  });
});

