import { beforeEach, describe, expect, it, vi } from 'vitest';

// sidebar.ts grabs a handful of DOM nodes at module load and pulls in a wide
// import graph; stub just enough of the browser globals so the module imports
// in the node test environment. We only exercise the pure profile-label helper.
class FakeElement {
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  dataset: Record<string, string> = {};
  appendChild(c: FakeElement) { this.children.push(c); return c; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  getBoundingClientRect() { return { top: 0, height: 0 }; }
  focus() {}
  remove() {}
}

function stubDom() {
  const doc = {
    getElementById: () => new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener: () => {},
    body: new FakeElement(),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { vibeyard: {} });
}

// Capability table matching the real provider registry: claude, pi and omp
// are profile-capable, the rest are not.
vi.mock('../provider-availability.js', () => ({
  loadProviderMetas: vi.fn(async () => {}),
  loadProviderAvailability: vi.fn(async () => {}),
  hasMultipleAvailableProviders: vi.fn(() => false),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getCachedProviderMetas: vi.fn(() => []),
  getAvailableProviderMetas: vi.fn(() => []),
  getTeamChatProviderMetas: vi.fn(() => []),
  getTeamCapableProviderIds: vi.fn(() => new Set()),
  getProviderCapabilities: vi.fn((id: string) => ({
    profiles: id === 'claude' || id === 'pi' || id === 'omp',
  })),
  getProviderDisplayName: vi.fn((id: string) => {
    const names: Record<string, string> = { claude: 'Claude Code', pi: 'Pi', omp: 'Oh my Pi' };
    return names[id] ?? id;
  }),
}));

describe('projectProfileLabel', () => {
  beforeEach(() => {
    vi.resetModules();
    stubDom();
  });

  function makeProfile(id: string, name: string, providerId = 'claude') {
    return { id, name, providerId, configDir: `/cfg/${id}`, managed: true, createdAt: 0 };
  }

  async function load() {
    const sidebar = await import('./sidebar.js');
    const { appState } = await import('../state.js');
    return { projectProfileLabel: sidebar.projectProfileLabel, appState };
  }

  it('returns undefined when zero or one claude profile exists', async () => {
    const { projectProfileLabel, appState } = await load();
    expect(projectProfileLabel({ defaultProfileId: undefined } as any)).toBeUndefined();
    appState.profiles.push(makeProfile('work', 'Work') as any);
    expect(projectProfileLabel({ defaultProfileId: 'work' } as any)).toBeUndefined();
  });

  it('labels a project with no explicit profile as "Default"', async () => {
    const { projectProfileLabel, appState } = await load();
    appState.profiles.push(makeProfile('work', 'Work') as any, makeProfile('home', 'Home') as any);
    appState.preferences.defaultProfiles = undefined;
    expect(projectProfileLabel({ defaultProfileId: undefined } as any)).toBe('Default');
  });

  it('uses the project default profile name when set', async () => {
    const { projectProfileLabel, appState } = await load();
    appState.profiles.push(makeProfile('work', 'Work') as any, makeProfile('home', 'Home') as any);
    expect(projectProfileLabel({ defaultProfileId: 'home' } as any)).toBe('Home');
  });

  it('ignores per-provider global defaults (the card has no provider context)', async () => {
    const { projectProfileLabel, appState } = await load();
    appState.profiles.push(makeProfile('work', 'Work') as any, makeProfile('home', 'Home') as any);
    appState.preferences.defaultProfiles = { claude: 'work' };
    expect(projectProfileLabel({ defaultProfileId: undefined } as any)).toBe('Default');
  });

  it('labels an unknown profile id as "Default"', async () => {
    const { projectProfileLabel, appState } = await load();
    appState.profiles.push(makeProfile('work', 'Work') as any, makeProfile('home', 'Home') as any);
    expect(projectProfileLabel({ defaultProfileId: 'ghost' } as any)).toBe('Default');
  });

  it('ignores non-profile-capable profiles when counting', async () => {
    const { projectProfileLabel, appState } = await load();
    // Two profiles total, but only one is profile-capable — gate stays closed.
    appState.profiles.push(makeProfile('work', 'Work', 'claude') as any, makeProfile('gem', 'Gem', 'gemini') as any);
    expect(projectProfileLabel({ defaultProfileId: 'work' } as any)).toBeUndefined();
  });

  it('counts pi profiles toward the badge', async () => {
    const { projectProfileLabel, appState } = await load();
    // One claude + one pi profile: two profile-capable profiles, gate opens.
    appState.profiles.push(makeProfile('work', 'Work', 'claude') as any, makeProfile('home', 'Home', 'pi') as any);
    expect(projectProfileLabel({ defaultProfileId: 'home' } as any)).toBe('Home');
  });
});

describe('profile-utils', () => {
  beforeEach(() => {
    vi.resetModules();
    stubDom();
  });

  function makeProfile(id: string, name: string, providerId = 'claude') {
    return { id, name, providerId, configDir: `/cfg/${id}`, managed: true, createdAt: 0 };
  }

  it('scopes profile options to a single coding tool with bare names', async () => {
    const { providerProfileOptions } = await import('../profile-utils.js');
    const { appState } = await import('../state.js');
    appState.profiles.push(
      makeProfile('work', 'Work', 'claude') as any,
      makeProfile('home', 'Home', 'pi') as any,
      makeProfile('omp1', 'OMP Work', 'omp') as any,
      makeProfile('gem', 'Gem', 'gemini') as any,
    );
    expect(providerProfileOptions('claude')).toEqual([{ value: 'work', label: 'Work' }]);
    expect(providerProfileOptions('pi')).toEqual([{ value: 'home', label: 'Home' }]);
    expect(providerProfileOptions('omp')).toEqual([{ value: 'omp1', label: 'OMP Work' }]);
    expect(providerProfileOptions('gemini')).toEqual([]);
  });

  it('resolves the project provider from the active session, else the global default', async () => {
    const { projectProviderId } = await import('../profile-utils.js');
    const { appState } = await import('../state.js');
    appState.preferences.defaultProvider = 'claude';
    expect(projectProviderId({ sessions: [], activeSessionId: null } as any)).toBe('claude');
    expect(projectProviderId({ sessions: [{ id: 's1', providerId: 'omp' }], activeSessionId: 's1' } as any)).toBe('omp');
    expect(projectProviderId({ sessions: [{ id: 's1', providerId: 'omp' }], activeSessionId: 's2' } as any)).toBe('claude');
  });

  it('returns only profile-capable profiles', async () => {
    const { profileCapableProfiles } = await import('../profile-utils.js');
    const { appState } = await import('../state.js');
    appState.profiles.push(
      makeProfile('work', 'Work', 'claude') as any,
      makeProfile('home', 'Home', 'pi') as any,
      makeProfile('gem', 'Gem', 'gemini') as any,
    );
    expect(profileCapableProfiles().map((p) => p.id)).toEqual(['work', 'home']);
  });
});

describe('projectRenderOrder', () => {
  beforeEach(() => {
    vi.resetModules();
    stubDom();
  });

  async function load() {
    const sidebar = await import('./sidebar.js');
    return sidebar.projectRenderOrder;
  }

  function proj(id: string) {
    return { id } as any;
  }

  it('preserves project order — the active project is not pinned to the top', async () => {
    const projectRenderOrder = await load();
    const projects = [proj('a'), proj('b'), proj('c')];
    const plan = projectRenderOrder(projects, 'c');
    expect(plan.map((e) => e.project.id)).toEqual(['a', 'b', 'c']);
    expect(plan.map((e) => e.isActive)).toEqual([false, false, true]);
  });

  it('flags exactly the active project in place', async () => {
    const projectRenderOrder = await load();
    const plan = projectRenderOrder([proj('a'), proj('b'), proj('c')], 'b');
    expect(plan.map((e) => e.project.id)).toEqual(['a', 'b', 'c']);
    expect(plan.find((e) => e.isActive)?.project.id).toBe('b');
    expect(plan.filter((e) => e.isActive)).toHaveLength(1);
  });

  it('marks nothing active when activeProjectId is null or unknown', async () => {
    const projectRenderOrder = await load();
    expect(projectRenderOrder([proj('a'), proj('b')], null).some((e) => e.isActive)).toBe(false);
    expect(projectRenderOrder([proj('a'), proj('b')], 'ghost').some((e) => e.isActive)).toBe(false);
  });

  it('returns an empty plan for no projects', async () => {
    const projectRenderOrder = await load();
    expect(projectRenderOrder([], null)).toEqual([]);
  });
});
