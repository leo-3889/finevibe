// Audit rows 31/32/34 on the `hosts:*` IPC boundary: what main ACCEPTS from the
// renderer. Sibling of hosts-domains.test.ts (rows 46/46b) and uses the same
// registration harness, but keeps `../hosts/keys` REAL — the key-path
// containment is that module's gate, and the registry / enrollment stubs make
// sure only the patch that reaches them is under test (host-registry.test.ts
// covers storage, keys.test.ts covers the gate's own path arithmetic).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const registry = vi.hoisted(() => ({
  getHost: vi.fn(),
  listHosts: vi.fn(() => []),
  createHost: vi.fn(),
  updateHost: vi.fn(),
  deleteHost: vi.fn(),
}));
const enrollHost = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true, steps: [] })));

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'fv-hosts-ipc-'));
const USER_DATA = join(TMP_ROOT, 'user-data');
const MANAGED_KEY = join(USER_DATA, 'hosts', 'h1', 'id_ed25519');
const HOME_KEY = join(homedir(), '.ssh', 'id_ed25519');
mkdirSync(join(USER_DATA, 'hosts', 'h1'), { recursive: true });

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: () => {},
  },
}));
vi.mock('../hosts/host-registry', () => ({
  HostValidationError: class extends Error {},
  ...registry,
}));
vi.mock('../hosts/enrollment', () => ({ enrollHost, testHost: vi.fn(), unenrollHost: vi.fn() }));
vi.mock('../hosts/settings-sync', () => ({ syncSettingsToHost: vi.fn() }));
vi.mock('../hosts/remote-fs', () => ({
  invalidateRemoteHome: vi.fn(),
  cloneRemoteRepo: vi.fn(),
  ensureRemoteDir: vi.fn(),
  listRemoteDirs: vi.fn(),
  statRemotePath: vi.fn(),
}));
vi.mock('../hosts/secrets', () => ({
  deleteHostSecret: vi.fn(),
  setHostSecret: vi.fn(),
  secretsAvailable: vi.fn(() => true),
}));
vi.mock('../pty-manager', () => ({ spawnShellPty: vi.fn() }));
vi.mock('../main-window', () => ({ getMainWindow: () => null }));

import { registerHostsDomains } from './hosts-domains';

/** A pin is exactly `fingerprintOf()` output: `SHA256:` + 43 base64 chars + '='. */
const VALID_PIN = `SHA256:${'A'.repeat(43)}=`;

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`channel ${channel} was not registered`);
  return handler({} as never, ...args);
}

beforeEach(() => {
  handlers.clear();
  for (const mock of Object.values({ ...registry, enrollHost })) mock.mockReset();
  registry.getHost.mockReturnValue(null);
  registry.updateHost.mockImplementation((_id: string, patch: Record<string, unknown>) => ({ ...patch }));
  registry.createHost.mockImplementation((draft: Record<string, unknown>) => ({ ...draft }));
  registerHostsDomains({ createPtyDataSink: () => Object.assign(() => {}, { flush: () => {} }) });
});

describe('hosts:update field allowlist (audit 31)', () => {
  it('drops renderer patches for main-owned fields', () => {
    const patch = {
      name: 'remote1', user: 'dev', host: '192.0.2.242', port: 22, authKind: 'password',
      // The forged consent + probe state: none of these may reach the registry.
      enrollmentStatus: 'enrolled', enrollmentDetail: 'forged',
      hostKeyFingerprint: VALID_PIN, prerequisites: { claude: { ok: true, path: '$(rm -rf /)' } },
      enrolledAt: 'yesterday', lastProbeAt: 'yesterday', lastProbeOk: true,
      managedKey: true, id: 'evil',
    };
    expect(call('hosts:update', 'h1', patch)).toEqual({
      name: 'remote1', user: 'dev', host: '192.0.2.242', port: 22, authKind: 'password',
    });
  });

  it('passes the fields the edit form owns', () => {
    expect(call('hosts:update', 'h1', { defaultFolder: '~/work', settingsSync: { providers: ['pi'] }, color: '#123456' }))
      .toEqual({ defaultFolder: '~/work', settingsSync: { providers: ['pi'] }, color: '#123456' });
  });

  it('survives a non-object patch', () => {
    expect(call('hosts:update', 'h1', null)).toEqual({});
  });
});

describe('hosts:approveHostKey pin grammar (audit 32)', () => {
  beforeEach(() => registry.getHost.mockReturnValue({ id: 'h1' }));

  it('refuses an empty pin (an empty pin silently disables pinning)', () => {
    expect(call('hosts:approveHostKey', 'h1', '')).toBeNull();
    expect(registry.updateHost).not.toHaveBeenCalled();
  });

  it('refuses a non-SHA256 pin', () => {
    expect(call('hosts:approveHostKey', 'h1', '00:11:22:aa:bb')).toBeNull();
    expect(registry.updateHost).not.toHaveBeenCalled();
  });

  it('refuses a wrong-length / wrong-charset digest', () => {
    expect(call('hosts:approveHostKey', 'h1', `SHA256:${'A'.repeat(40)}`)).toBeNull();
    expect(call('hosts:approveHostKey', 'h1', `SHA256:${'A'.repeat(42)}!`)).toBeNull();
    expect(registry.updateHost).not.toHaveBeenCalled();
  });

  it('accepts the exact fingerprintOf() shape', () => {
    expect(call('hosts:approveHostKey', 'h1', VALID_PIN)).toEqual({ hostKeyFingerprint: VALID_PIN });
  });

  // Row 118 review: the enroll channel is pin-blind - the pin is main-owned
  // (approveHostKey is the only writer), so NOTHING a renderer passes on this
  // channel reaches enrollHost, well-formed pins included.
  it('hosts:enroll never forwards a renderer pin to enrollHost', async () => {
    registry.getHost.mockReturnValue({ id: 'h1' });
    await call('hosts:enroll', 'h1', { pin: '' });
    await call('hosts:enroll', 'h1', { pin: 'bogus' });
    await call('hosts:enroll', 'h1', { pin: VALID_PIN });
    for (const args of enrollHost.mock.calls) expect(args).toHaveLength(2);
  });
});

describe('hosts key-path containment (audit 34)', () => {
  it('refuses a key path outside the managed dir and ~/.ssh', () => {
    registry.getHost.mockReturnValue({ id: 'h1', privateKeyPath: MANAGED_KEY });
    expect(() => call('hosts:update', 'h1', { privateKeyPath: '/etc/passwd' })).toThrow(/privateKeyPath/);
    expect(registry.updateHost).not.toHaveBeenCalled();
  });

  it('keeps a stored out-of-tree key editable', () => {
    registry.getHost.mockReturnValue({ id: 'h1', privateKeyPath: '/opt/keys/id_ed25519' });
    call('hosts:update', 'h1', { name: 'renamed', privateKeyPath: '/opt/keys/id_ed25519' });
    expect(registry.updateHost).toHaveBeenCalledWith('h1', { name: 'renamed', privateKeyPath: '/opt/keys/id_ed25519' });
  });

  it('derives managedKey from the path instead of trusting the patch', () => {
    registry.getHost.mockReturnValue({ id: 'h1', privateKeyPath: '/opt/keys/id_ed25519' });
    // A browsed ~/.ssh key is NOT finevibe-managed: enrolling it must not deploy
    // its public half, and deleting the host must not unlink it.
    call('hosts:update', 'h1', { privateKeyPath: HOME_KEY, managedKey: true });
    expect(registry.updateHost).toHaveBeenLastCalledWith('h1', { privateKeyPath: HOME_KEY, managedKey: false });
    call('hosts:update', 'h1', { privateKeyPath: MANAGED_KEY, managedKey: false });
    expect(registry.updateHost).toHaveBeenLastCalledWith('h1', { privateKeyPath: MANAGED_KEY, managedKey: true });
  });

  it('hosts:create gates the draft the same way', () => {
    expect(() => call('hosts:create', { name: 'remote1', privateKeyPath: join(TMP_ROOT, 'stolen', 'id_ed25519') }))
      .toThrow(/privateKeyPath/);
    expect(registry.createHost).not.toHaveBeenCalled();
    call('hosts:create', { name: 'remote1', privateKeyPath: MANAGED_KEY, managedKey: false });
    expect(registry.createHost).toHaveBeenLastCalledWith(
      expect.objectContaining({ privateKeyPath: MANAGED_KEY, managedKey: true }),
    );
    call('hosts:create', 'not-an-object');
    expect(registry.createHost).toHaveBeenLastCalledWith('not-an-object');
  });
});
