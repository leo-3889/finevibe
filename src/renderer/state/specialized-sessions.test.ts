import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

const mockProvision = vi.fn(async (id: string) => ({ configDir: `/cfg/${id}`, managed: true }));

vi.stubGlobal('window', {
  finevibe: {
    store: { load: mockLoad, save: mockSave },
    profiles: { provision: mockProvision },
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
import { resolveProfile, resolveProjectFilePath, isPlanModeSupported, resolvePlanModePreference } from './specialized-sessions.js';
import { getProviderCapabilities } from '../provider-availability.js';
import type { BoardData, BoardTask, CliProviderCapabilities, Profile, ProjectRecord, ProviderId } from '../../shared/types.js';
import { getCost } from '../session-cost.js';
const mockGetCost = vi.mocked(getCost);

const PROFILES: Profile[] = [
  { id: 'work', name: 'Work', providerId: 'claude', configDir: '/cfg/work', managed: true, createdAt: 0 },
  { id: 'cdx', name: 'Codex', providerId: 'codex', configDir: '/cfg/cdx', managed: true, createdAt: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockGetCost.mockReturnValue(null);
  _resetForTesting();
});

function addProject(name = 'Test', path = '/test') {
  return appState.addProject(name, path);
}

describe('project coding defaults', () => {
  it('applies saved project defaults to new sessions and plans, preserving existing sessions', async () => {
    const project = addProject();
    appState.profiles.push({ id: 'omp-work', name: 'Work', providerId: 'omp', configDir: '/cfg/omp', managed: true, createdAt: 0 });
    const old = appState.addSession(project.id, 'Old', undefined, 'claude')!;
    appState.setProjectCodingDefaults(project.id, 'omp', 'omp-work');
    expect(appState.addSession(project.id, 'New')).toMatchObject({ providerId: 'omp', profileId: 'omp-work' });
    expect(appState.addPlanSession(project.id, 'Plan')).toMatchObject({ providerId: 'omp', profileId: 'omp-work' });
    expect(old.providerId).toBe('claude');
    expect(appState.addSession(project.id, 'Override', undefined, 'pi')?.providerId).toBe('pi');
    appState.flushPersist();
    const saved = mockSave.mock.calls.at(-1)![0];
    mockLoad.mockResolvedValue(saved);
    await appState.load();
    expect(appState.projects[0]).toMatchObject({ defaultProvider: 'omp', defaultProfileId: 'omp-work' });
  });
  it('clears an incompatible profile when changing the provider and supports global fallback', () => {
    const project = addProject();
    appState.profiles.push(...PROFILES);
    appState.setProjectCodingDefaults(project.id, 'omp', 'work');
    expect(project.defaultProfileId).toBeUndefined();
    appState.preferences.defaultProvider = 'pi';
    appState.setProjectCodingDefaults(project.id, undefined);
    expect(appState.addSession(project.id, 'Global')?.providerId).toBe('pi');
  });
});

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

describe('resolveProjectFilePath()', () => {
  // Shared by addFileReaderSession and the pre-open existence check, so the two
  // can never disagree about which path they mean.
  const project = { path: '/p' } as ProjectRecord;

  it('joins a relative path onto the project path', () => {
    expect(resolveProjectFilePath(project, 'src/foo.ts')).toBe('/p/src/foo.ts');
  });

  it('leaves an absolute path alone', () => {
    expect(resolveProjectFilePath(project, '/elsewhere/foo.ts')).toBe('/elsewhere/foo.ts');
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

  it('deduplicates across absolute and project-relative path formats', () => {
    const project = addProject('Test', '/p');
    const s1 = appState.addFileReaderSession(project.id, '/p/src/foo.ts')!;
    const s2 = appState.addFileReaderSession(project.id, 'src/foo.ts')!;
    expect(s2.id).toBe(s1.id);
    expect(s1.fileReaderPath).toBe('/p/src/foo.ts');
    expect(project.sessions.filter((s) => s.type === 'file-reader')).toHaveLength(1);
  });

  it('stores relative paths normalized to absolute', () => {
    const project = addProject('Test', '/p');
    const session = appState.addFileReaderSession(project.id, 'src/foo.ts')!;
    expect(session.fileReaderPath).toBe('/p/src/foo.ts');
    expect(session.name).toBe('foo.ts');
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

describe('resolveProfile()', () => {
  it('prefers the session profile over project and prefs', () => {
    const r = resolveProfile({ profileId: 'work' }, { defaultProfileId: undefined }, {}, 'claude', PROFILES);
    expect(r?.id).toBe('work');
  });

  it('falls back to the project default when the session has none', () => {
    const r = resolveProfile({ profileId: undefined }, { defaultProfileId: 'work' }, {}, 'claude', PROFILES);
    expect(r?.id).toBe('work');
  });

  it('falls back to the provider global default when neither session nor project specify one', () => {
    const r = resolveProfile(undefined, undefined, { defaultProfiles: { claude: 'work' } }, 'claude', PROFILES);
    expect(r?.id).toBe('work');
  });

  it('does not apply one provider global default to another provider', () => {
    // 'work' is claude's global default, but the session runs gemini.
    expect(resolveProfile(undefined, undefined, { defaultProfiles: { claude: 'work' } }, 'gemini', PROFILES)).toBeUndefined();
  });

  it('returns undefined when nothing specifies a profile', () => {
    expect(resolveProfile(undefined, undefined, {}, 'claude', PROFILES)).toBeUndefined();
  });

  it('returns undefined when the profile targets a different provider', () => {
    // 'work' is a claude profile, but the session provider is gemini.
    expect(resolveProfile({ profileId: 'work' }, undefined, {}, 'gemini', PROFILES)).toBeUndefined();
  });

  it('returns undefined when the referenced profile no longer exists', () => {
    expect(resolveProfile({ profileId: 'gone' }, undefined, {}, 'claude', PROFILES)).toBeUndefined();
  });

  // Phase 1 host coherence: a profile is a directory on ONE machine.
  const HOST_PROFILES: Profile[] = [
    ...PROFILES,
    { id: 'rwork', name: 'Remote Work', providerId: 'claude', configDir: '/home/u/.claude-rwork', managed: true, createdAt: 0, hostId: 'host-1' },
  ];

  it('local launch (hostId=local) reads the bare prefs key', () => {
    const r = resolveProfile(undefined, undefined, { defaultProfiles: { claude: 'work' } }, 'claude', HOST_PROFILES, 'local');
    expect(r?.id).toBe('work');
  });

  it('remote launch reads only its own host-prefixed prefs key — never the local default', () => {
    const prefs = { defaultProfiles: { claude: 'work', 'host-1|claude': 'rwork' } };
    expect(resolveProfile(undefined, undefined, prefs, 'claude', HOST_PROFILES, 'host-1')?.id).toBe('rwork');
    // host-2 has no key of its own: bare launch, not the local profile.
    expect(resolveProfile(undefined, undefined, prefs, 'claude', HOST_PROFILES, 'host-2')).toBeUndefined();
  });

  it('drops a pinned profile that lives on a different machine', () => {
    // 'work' is a LOCAL profile; the session launches on host-1.
    expect(resolveProfile({ profileId: 'work' }, undefined, {}, 'claude', HOST_PROFILES, 'host-1')).toBeUndefined();
    // and symmetrically: a host profile pinned on a local launch.
    expect(resolveProfile({ profileId: 'rwork' }, undefined, {}, 'claude', HOST_PROFILES, 'local')).toBeUndefined();
    // right host → kept
    expect(resolveProfile({ profileId: 'rwork' }, undefined, {}, 'claude', HOST_PROFILES, 'host-1')?.id).toBe('rwork');
  });

  it('host check also gates the project-level pin', () => {
    expect(resolveProfile(undefined, { defaultProfileId: 'work' }, {}, 'claude', HOST_PROFILES, 'host-1')).toBeUndefined();
  });
});

describe('addSession profile pinning', () => {
  it('pins an explicitly chosen profile onto the session', async () => {
    const project = addProject();
    const profile = await appState.addProfile({ name: 'Work', providerId: 'claude' });
    const session = appState.addSession(project.id, 'S', undefined, 'claude', profile.id)!;
    expect(session.profileId).toBe(profile.id);
  });

  it('pins the project default profile when none is passed (sticky resolution)', async () => {
    const project = addProject();
    const profile = await appState.addProfile({ name: 'Work', providerId: 'claude' });
    appState.setProjectDefaultProfile(project.id, profile.id);
    const session = appState.addSession(project.id, 'S')!;
    expect(session.profileId).toBe(profile.id);
  });

  it('does not pin a claude profile onto a non-claude session', async () => {
    const project = addProject();
    const profile = await appState.addProfile({ name: 'Work', providerId: 'claude' });
    appState.setProjectDefaultProfile(project.id, profile.id);
    const session = appState.addSession(project.id, 'S', undefined, 'gemini')!;
    expect(session.profileId).toBeUndefined();
  });
});

describe('removeProfile reference cleanup', () => {
  it('deletes the profile and clears every reference, live and archived (P3-4)', async () => {
    const project = addProject();
    const profile = await appState.addProfile({ name: 'Work', providerId: 'claude' });
    appState.setProjectDefaultProfile(project.id, profile.id);
    appState.setProviderDefaultProfile('claude', profile.id);
    const session = appState.addSession(project.id, 'S', undefined, 'claude', profile.id)!;
    project.sessionHistory = [{ id: 'a', name: 'old', providerId: 'claude', cliSessionId: 'c', createdAt: '0', closedAt: '0', profileId: profile.id, cost: null }];
    const board: BoardData = project.board ?? { tasks: [], columns: [] };
    project.board = board;
    const task: BoardTask = { id: 't1', title: 'T', prompt: 'p', columnId: 'col-1', order: 0, profileId: profile.id, createdAt: 0, updatedAt: 0 };
    project.board.tasks.push(task);

    appState.removeProfile(profile.id);

    // Deletion completes — no early return, so every cleanup loop runs.
    expect(appState.getProfile(profile.id)).toBeUndefined();
    // The live session falls back to the provider default (profileId cleared)…
    expect(session.profileId).toBeUndefined();
    // …and the archived history row drops the id.
    expect(project.sessionHistory![0].profileId).toBeUndefined();
    expect(project.defaultProfileId).toBeUndefined();
    expect(appState.preferences.defaultProfiles?.claude).toBeUndefined();
    expect(task.profileId).toBeUndefined();
  });

  it('isProfileInUse ignores archived rows so a history-only reference stays deletable (P3-4)', async () => {
    const project = addProject();
    const profile = await appState.addProfile({ name: 'Work', providerId: 'claude' });
    project.sessionHistory = [{ id: 'a', name: 'old', providerId: 'claude', cliSessionId: 'c', createdAt: '0', closedAt: '0', profileId: profile.id, cost: null }];

    // UI delete-button gate: history rows must not disable it.
    expect(appState.isProfileInUse(profile.id)).toBe(false);

    appState.addSession(project.id, 'S', undefined, 'claude', profile.id);
    // A live session is the only thing that marks the profile in use.
    expect(appState.isProfileInUse(profile.id)).toBe(true);
  });
});


describe('isPlanModeSupported()', () => {
  // Mirrors the verified planModeArg matrix (docs/provider-contracts.md):
  // claude/copilot/gemini/omp carry a startup flag; codex is
  // verification-pending (flag unset); pi is a permanent non-goal.
  const capsMatrix = {
    claude: { planModeArg: '--permission-mode plan' },
    copilot: { planModeArg: '--mode plan' },
    gemini: { planModeArg: '--approval-mode=plan' },
    omp: { planModeArg: '--plan-yolo' },
    codex: {},
    pi: {},
  } as unknown as Record<string, CliProviderCapabilities>;

  it('is true exactly for providers with a planModeArg', () => {
    vi.mocked(getProviderCapabilities).mockImplementation((id) => capsMatrix[id] ?? null);
    expect(isPlanModeSupported('claude')).toBe(true);
    expect(isPlanModeSupported('copilot')).toBe(true);
    expect(isPlanModeSupported('gemini')).toBe(true);
    expect(isPlanModeSupported('omp')).toBe(true);
    expect(isPlanModeSupported('codex')).toBe(false);
    expect(isPlanModeSupported('pi')).toBe(false);
  });

  it('is false for an unknown provider (no cached capabilities)', () => {
    vi.mocked(getProviderCapabilities).mockReturnValue(null);
    expect(isPlanModeSupported('nonexistent' as ProviderId)).toBe(false);
  });
});

describe('resolvePlanModePreference()', () => {
  const capsMatrix = {
    claude: { planModeArg: '--permission-mode plan' },
    pi: {},
  } as unknown as Record<string, CliProviderCapabilities>;

  it('defaults to true for a supported provider with no stored preference', () => {
    vi.mocked(getProviderCapabilities).mockImplementation((id) => capsMatrix[id] ?? null);
    expect(resolvePlanModePreference({}, 'claude')).toBe(true);
  });

  it('is false for an unsupported provider even when the preference is true', () => {
    vi.mocked(getProviderCapabilities).mockImplementation((id) => capsMatrix[id] ?? null);
    expect(resolvePlanModePreference({ planModeDefaults: { pi: true } }, 'pi')).toBe(false);
  });

  it('honors an explicit false for a supported provider', () => {
    vi.mocked(getProviderCapabilities).mockImplementation((id) => capsMatrix[id] ?? null);
    expect(resolvePlanModePreference({ planModeDefaults: { claude: false } }, 'claude')).toBe(false);
  });
});
