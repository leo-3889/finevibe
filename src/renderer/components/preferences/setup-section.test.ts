import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 2 host scoping (docs/hosts.md coherence principle): the Setup section
// checks the machine named by its scope select. These tests pin the remote
// branch: checks go through the host-routed checkBinary, LOCAL-only
// validations (settings.validate / reinstall) never run for a remote scope,
// and un-enrolled hosts get the honest enroll-first row.

const mockState = vi.hoisted(() => ({
  activeHostId: 'local',
  setActiveHost: vi.fn(),
}));

const mockRegistry = vi.hoisted(() => ({
  hosts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../state.js', () => ({ appState: mockState }));
vi.mock('../../host-registry.js', () => ({
  getEnrolledHosts: () => mockRegistry.hosts.filter((h) => h.enrollmentStatus === 'enrolled' || h.enrollmentStatus === 'partial'),
  getHost: (id: string) => mockRegistry.hosts.find((h) => h.id === id),
}));

const selectState = vi.hoisted(() => {
  const instances = new Map<string, { options: Array<{ value: string; label: string }>; value: string; element: Record<string, any>; onChange?: (v: string) => void }>();
  return { instances, reset() { instances.clear(); } };
});

vi.mock('../custom-select.js', () => ({
  createCustomSelect: (id: string, options: Array<{ value: string; label: string }>, defaultValue: string, onChange?: (v: string) => void) => {
    const element = makeElement('div');
    const instance = { options, value: defaultValue, element, onChange };
    selectState.instances.set(id, instance);
    return instance;
  },
}));

type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

function makeElement(tagName = 'div'): Record<string, any> {
  const children: Record<string, any>[] = [];
  const listeners: ListenerMap = {};
  const element: Record<string, any> = {
    tagName,
    children,
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    appendChild(child: Record<string, any>) { children.push(child); return child; },
    addEventListener(event: string, cb: (...args: unknown[]) => void) { (listeners[event] ??= []).push(cb); },
    dispatchEvent(event: { type: string }) { for (const cb of listeners[event.type] ?? []) cb(event); },
  };
  return element;
}

function collect(root: Record<string, any>, cls: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const c of root.children ?? []) {
    const tokens = String(c.className ?? '').split(/\s+/);
    if (tokens.includes(cls)) out.push(c);
    out.push(...collect(c, cls));
  }
  return out;
}

const META = [
  { id: 'claude', displayName: 'Claude Code', binaryName: 'claude', capabilities: { profiles: true, costTracking: true, hookStatus: true, contextWindow: true } },
  { id: 'pi', displayName: 'Pi', binaryName: 'pi', capabilities: { profiles: true, costTracking: false, hookStatus: true } },
];

const checkBinary = vi.fn();
const validate = vi.fn();
const reinstall = vi.fn();

const ctx = {
  isActiveSection: () => true,
  rerenderSection: vi.fn(),
  setSetupBadge: vi.fn(),
  getActiveProject: () => null,
};

const host = {
  id: 'host-1',
  name: 'workbox',
  enrollmentStatus: 'enrolled',
  settingsSync: { providers: ['pi'] },
};

async function render() {
  const { createSetupSection } = await import('./setup-section.js');
  const container = makeElement('div');
  await createSetupSection(ctx as any).render(container);
  return container;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  selectState.reset();
  mockState.activeHostId = 'local';
  mockRegistry.hosts = [{ ...host }];
  checkBinary.mockResolvedValue(true);
  validate.mockResolvedValue({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });

  vi.stubGlobal('document', { createElement: (t: string) => makeElement(t) });
  vi.stubGlobal('window', {
    finevibe: {
      provider: { listProviders: async () => META, checkBinary },
      settings: { validate, reinstall },
    },
  });
});

describe('Setup section host scope', () => {
  it('shows a scope select with Local + enrolled hosts; default local runs the local checks', async () => {
    const container = await render();
    const scope = selectState.instances.get('setup-host-scope')!;
    expect(scope.options.map((o) => o.label)).toEqual(['Local', 'workbox']);
    // Local scope: checkBinary is called WITHOUT a hostId arg at all (byte-identical wire)
    expect(checkBinary).toHaveBeenCalledWith('claude');
    expect(validate).toHaveBeenCalled();
    expect(collect(container, 'setup-provider-header').map((n) => n.textContent)).toEqual(['Claude Code', 'Pi']);
  });

  it('scope change drives setActiveHost (sidebar-synced) and a re-render', async () => {
    await render();
    selectState.instances.get('setup-host-scope')!.onChange!('host-1');
    expect(mockState.setActiveHost).toHaveBeenCalledWith('host-1');
    expect(ctx.rerenderSection).toHaveBeenCalledWith('setup');
  });

  it('remote scope: binaries probed ON the host, local validations never run', async () => {
    mockState.activeHostId = 'host-1';
    const container = await render();
    expect(checkBinary).toHaveBeenCalledWith('claude', 'host-1');
    expect(checkBinary).toHaveBeenCalledWith('pi', 'host-1');
    expect(validate).not.toHaveBeenCalled();
    expect(collect(container, 'setup-check-row').length).toBeGreaterThan(0);
  });

  it('remote missing binary row offers Re-check (not a local Fix) with host-named help', async () => {
    mockState.activeHostId = 'host-1';
    checkBinary.mockImplementation(async (id: string) => id !== 'claude');
    const container = await render();
    const rows = collect(container, 'setup-check-row');
    const claudeBinaryRow = rows.find((r) => JSON.stringify(r).includes('Claude Code'))!;
    const btn = collect(claudeBinaryRow, 'setup-fix-btn')[0];
    expect(btn.textContent).toBe('Re-check');
    btn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 0));
    expect(reinstall).not.toHaveBeenCalled();
    expect(ctx.rerenderSection).toHaveBeenCalledWith('setup');
  });

  it('remote settings rows show the Settings-sync tier, not local statusLine/hooks', async () => {
    mockState.activeHostId = 'host-1';
    const container = await render();
    const statuses = collect(container, 'setup-check-status').map((n) => n.textContent);
    // pi is in settingsSync.providers -> Synced; claude is not -> Not synced.
    expect(statuses).toContain('Synced');
    expect(statuses).toContain('Not synced');
    expect(statuses).not.toContain('Status line configured');
  });

  it('un-enrolled (failed) host: enroll-first row only, no probes', async () => {
    mockState.activeHostId = 'host-1';
    mockRegistry.hosts = [{ ...host, enrollmentStatus: 'failed' }];
    const container = await render();
    expect(checkBinary).not.toHaveBeenCalled();
    const labels = collect(container, 'setup-check-label').map((n) => n.textContent);
    expect(labels).toEqual(['Enroll this host first']);
  });

  it('scoped host deleted mid-session falls back to Local scope', async () => {
    mockState.activeHostId = 'host-1';
    mockRegistry.hosts = [];
    await render();
    expect(mockState.setActiveHost).toHaveBeenCalledWith('local');
    expect(ctx.rerenderSection).toHaveBeenCalledWith('setup');
  });
});
