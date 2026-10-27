// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostsSection } from './hosts-section.js';
import type { HostRecord } from '../../../shared/types.js';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  openShell: vi.fn(),
  generateKey: vi.fn(),
  secretsAvailable: vi.fn(),
  setSecret: vi.fn(),
  forgetPassword: vi.fn(),
  test: vi.fn(),
  approveHostKey: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  syncSettings: vi.fn(),
  syncStatus: vi.fn(),
  onStatus: vi.fn(),
}));

const modal = vi.hoisted(() => ({
  showModal: vi.fn(),
  closeModal: vi.fn(),
  setModalError: vi.fn(),
  showConfirmDialog: vi.fn(),
}));

const shellTab = vi.hoisted(() => vi.fn());
const confirmCalls: Array<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void }> = [];

vi.mock('../../i18n.js', () => ({
  t: (key: string, vars?: Record<string, string>) =>
    Object.entries(vars ?? {}).reduce((s, [k, v]) => s.replace(`{${k}}`, v), key) + (vars ? ` ${JSON.stringify(vars)}` : ''),
}));
vi.mock('../modal.js', () => ({
  showModal: (...args: unknown[]) => modal.showModal(...args),
  closeModal: (...args: unknown[]) => modal.closeModal(...args),
  setModalError: (...args: unknown[]) => modal.setModalError(...args),
  showConfirmDialog: (title: string, message: string, opts: { confirmLabel?: string; onConfirm: () => void }) => {
    confirmCalls.push({ title, message, ...(opts.confirmLabel !== undefined ? { confirmLabel: opts.confirmLabel } : {}), onConfirm: opts.onConfirm });
    modal.showConfirmDialog(title, message, opts);
  },
}));
vi.mock('../project-terminal.js', () => ({ openRemoteShellTab: (id: string, name: string) => shellTab(id, name) }));

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'h1', name: 'box', user: 'dev', host: '10.0.0.5', port: 22,
    authKind: 'key', managedKey: false, privateKeyPath: '/k', enrollmentStatus: 'draft',
    defaultFolder: '~/.finevibe', createdAt: 0, updatedAt: 0, ...overrides,
  };
}

function makeCtx(container?: HTMLElement, section?: { render: (c: HTMLElement) => void }) {
  return {
    isActiveSection: () => true,
    rerenderSection: () => {
      if (container && section) section.render(container);
    },
    setSetupBadge: vi.fn(),
  } as never;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function texts(root: ParentNode, sel: string): string[] {
  return [...root.querySelectorAll(sel)].map((n) => n.textContent ?? '');
}

const steps = (ok: boolean) => [{ step: 'connect', ok, ...(ok ? {} : { detail: 'ECONNREFUSED' }) }];

beforeEach(() => {
  vi.clearAllMocks();
  confirmCalls.length = 0;
  document.body.innerHTML = '';
  Object.assign(window, {
    finevibe: {
      hosts: {
        list: api.list, create: api.create, update: api.update, delete: api.del,
        openShell: api.openShell, generateKey: api.generateKey, secretsAvailable: api.secretsAvailable,
        setSecret: api.setSecret, forgetPassword: api.forgetPassword, test: api.test,
        approveHostKey: api.approveHostKey, enroll: api.enroll, unenroll: api.unenroll,
        syncSettings: api.syncSettings, syncStatus: api.syncStatus, onStatus: api.onStatus,
      },
      fs: { browseDirectory: vi.fn() },
    },
  });
  api.list.mockResolvedValue([]);
  api.secretsAvailable.mockResolvedValue(true);
  api.onStatus.mockReturnValue(() => {});
});

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = makeCtx(container);
  const section = createHostsSection(ctx);
  (ctx as { rerenderSection: () => void }).rerenderSection = () => section.render(container);
  section.render(container);
  await flush();
  return { section, container };
}

describe('hosts-section', () => {
  it('renders empty state and the R1 banner when secrets are unavailable', async () => {
    api.secretsAvailable.mockResolvedValue(false);
    const { container } = await mount();
    expect(container.querySelector('.hosts-empty')).not.toBeNull();
    expect(container.querySelector('.hosts-r1-banner')).not.toBeNull();
  });

  it('renders a card per host with status dot, target, and badges failed hosts', async () => {
    api.list.mockResolvedValue([host({ enrollmentStatus: 'failed' }), host({ id: 'h2', name: 'srv', enrollmentStatus: 'enrolled' })]);
    const { container, section } = await mount();
    expect(container.querySelectorAll('.hosts-card').length).toBe(2);
    expect(container.querySelector('.hosts-dot')!.className).toContain('failed');
    expect(texts(container, '.hosts-card-target')).toContain('dev@10.0.0.5:22');
    expect(section).toBeDefined();
  });

  it('test → new fingerprint → approve → enroll chain', async () => {
    api.list.mockResolvedValue([host()]);
    api.test.mockResolvedValue({ ok: false, newFingerprint: 'SHA256:abc', hostKeyChanged: false, steps: steps(true) });
    api.enroll.mockResolvedValue({ ok: true, steps: steps(true) });
    const { container } = await mount();
    (container.querySelector('button[data-act="test"]') as HTMLButtonElement).click();
    await flush();
    expect(api.test).toHaveBeenCalledWith('h1');
    expect(confirmCalls[0].message).toContain('SHA256:abc');
    confirmCalls[0].onConfirm();
    await flush();
    expect(api.approveHostKey).toHaveBeenCalledWith('h1', 'SHA256:abc');
    expect(api.enroll).toHaveBeenCalledWith('h1');
  });

  it('wizard: key auth with no path generates a key, seeds id, stores secret, runs test', async () => {
    api.generateKey.mockResolvedValue({ id: 'gen1', privateKeyPath: '/cfg/hosts/gen1/id_ed25519', publicKey: 'ssh-ed25519 x' });
    api.create.mockImplementation(async (draft: HostRecord) => ({ ...host(), ...draft }));
    api.test.mockResolvedValue({ ok: true, hostKeyChanged: false, steps: steps(true) });
    const { container } = await mount();
    (container.querySelector('.hosts-add-btn') as HTMLButtonElement).click();
    expect(modal.showModal).toHaveBeenCalledTimes(1);
    const onConfirm = modal.showModal.mock.calls[0][2] as (v: Record<string, string>) => Promise<void>;
    await onConfirm({ name: 'box', user: 'dev', host: '10.0.0.5', port: '22', authKind: 'key', keyPath: '', secret: 'pp' });
    expect(api.generateKey).toHaveBeenCalled();
    expect(api.create.mock.calls[0][0]).toMatchObject({ id: 'gen1', managedKey: true, enrollmentStatus: 'draft' });
    expect(api.setSecret).toHaveBeenCalledWith('gen1', 'keypass', 'pp');
    expect(api.test).toHaveBeenCalled();
  });

  it('wizard rejects an out-of-range port via setModalError', async () => {
    const { container } = await mount();
    (container.querySelector('.hosts-add-btn') as HTMLButtonElement).click();
    const onConfirm = modal.showModal.mock.calls[0][2] as (v: Record<string, string>) => Promise<void>;
    await onConfirm({ name: 'a', user: 'u', host: 'h', port: '99999', authKind: 'key', keyPath: '/k', secret: '' });
    expect(modal.setModalError).toHaveBeenCalledWith('port', expect.any(String));
    expect(api.create).not.toHaveBeenCalled();
  });

  it('wizard: provider sync checkboxes persist as settingsSync.providers', async () => {
    api.create.mockImplementation(async (draft: HostRecord) => ({ ...host(), ...draft }));
    api.test.mockResolvedValue({ ok: true, hostKeyChanged: false, steps: steps(true) });
    const { container } = await mount();
    (container.querySelector('.hosts-add-btn') as HTMLButtonElement).click();
    const fields = modal.showModal.mock.calls[0][1] as Array<{ id: string }>;
    for (const id of ['sync_pi', 'sync_pi-bolt', 'sync_omp']) expect(fields.some((f) => f.id === id)).toBe(true);
    const onConfirm = modal.showModal.mock.calls[0][2] as (v: Record<string, string>) => Promise<void>;
    await onConfirm({ name: 'box', user: 'dev', host: 'h', port: '22', authKind: 'key', keyPath: '/k', secret: '', sync_pi: 'true', 'sync_pi-bolt': 'false', sync_omp: 'true' });
    expect(api.create.mock.calls[0][0]).toMatchObject({ settingsSync: { providers: ['pi', 'omp'] } });
  });

  it('card: sync button + last-sync line; drift answer re-pushes with confirmOverwrite', async () => {
    api.list.mockResolvedValue([host({ enrollmentStatus: 'enrolled', settingsSync: { providers: ['pi'], lastSyncAt: '2026-01-01T00:00:00.000Z' } })]);
    api.syncSettings.mockResolvedValueOnce({ ok: false, drift: ['~/.pi/agent/settings.json'], steps: [] });
    const { container } = await mount();
    expect(texts(container, '.hosts-card-probe').some((s) => s.includes('2026-01-01'))).toBe(true);
    const btn = container.querySelector('button[data-act="sync"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    await flush();
    expect(api.syncSettings).toHaveBeenCalledWith('h1', ['pi'], false);
    // Drift → Overwrite/Cancel confirm; Cancel leaves the host untouched.
    expect(confirmCalls[0].confirmLabel).toBe('hosts.overwrite');
    expect(confirmCalls[0].message).toContain('~/.pi/agent/settings.json');
    api.syncSettings.mockResolvedValueOnce({ ok: true, steps: [{ step: 'sync', ok: true, detail: '2 file(s) pushed' }] });
    confirmCalls[0].onConfirm();
    await flush();
    expect(api.syncSettings).toHaveBeenLastCalledWith('h1', ['pi'], true);
  });

  it('card: sync is disabled for a host without opted-in providers', async () => {
    api.list.mockResolvedValue([host({ enrollmentStatus: 'enrolled' })]);
    const { container } = await mount();
    expect((container.querySelector('button[data-act="sync"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('open shell calls openRemoteShellTab and shows the needs-project note on false', async () => {
    api.list.mockResolvedValue([host({ enrollmentStatus: 'enrolled' })]);
    shellTab.mockResolvedValue(false);
    const { container } = await mount();
    (container.querySelector('button[data-act="shell"]') as HTMLButtonElement).click();
    await flush();
    expect(shellTab).toHaveBeenCalledWith('h1', 'box');
    expect(texts(container, '.hosts-step')[0]).toContain('✗ hosts.step.shell');
  });

  it('remove of an enrolled host unenrolls before delete after confirm', async () => {
    api.list.mockResolvedValue([host({ enrollmentStatus: 'enrolled' })]);
    const { container } = await mount();
    (container.querySelector('button[data-act="remove"]') as HTMLButtonElement).click();
    expect(confirmCalls[0].title).toBe('hosts.remove');
    confirmCalls[0].onConfirm();
    await flush();
    expect(api.unenroll).toHaveBeenCalledWith('h1');
    expect(api.del).toHaveBeenCalledWith('h1');
  });

});
