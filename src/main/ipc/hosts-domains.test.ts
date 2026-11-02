// Audit rows 46 (hosts:setSecret host gate) and 46b (the `auth-ok` producer):
// the two `hosts:*` handlers whose gates live in the IPC layer. Registration is
// real (channels + handler bodies come from the module under test); every
// module the registrations import is a stub, so no ssh2 / store / pty loads.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const getHost = vi.hoisted(() => vi.fn());
const updateHost = vi.hoisted(() => vi.fn());
const setHostSecret = vi.hoisted(() => vi.fn());
const testHost = vi.hoisted(() => vi.fn());
const statRemotePath = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userData' },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: () => {},
  },
}));
vi.mock('../hosts/host-registry', () => ({
  HostValidationError: class extends Error {},
  getHost,
  listHosts: vi.fn(() => []),
  createHost: vi.fn(),
  updateHost,
  deleteHost: vi.fn(),
}));
vi.mock('../hosts/enrollment', () => ({
  enrollHost: vi.fn(),
  testHost,
  unenrollHost: vi.fn(),
}));
vi.mock('../hosts/secrets', () => ({
  deleteHostSecret: vi.fn(),
  setHostSecret,
  secretsAvailable: vi.fn(() => true),
}));
vi.mock('../hosts/settings-sync', () => ({ syncSettingsToHost: vi.fn() }));
vi.mock('../hosts/remote-fs', () => ({
  invalidateRemoteHome: vi.fn(),
  cloneRemoteRepo: vi.fn(),
  ensureRemoteDir: vi.fn(),
  listRemoteDirs: vi.fn(),
  statRemotePath,
}));
vi.mock('../hosts/keys', () => ({
  generateManagedKeypair: vi.fn(),
  isManagedKeyPath: vi.fn(() => true),
  isRendererKeyPathAllowed: vi.fn(() => true),
}));
vi.mock('../pty-manager', () => ({ spawnShellPty: vi.fn() }));
vi.mock('../main-window', () => ({ getMainWindow: vi.fn(() => null) }));

import { registerHostsDomains } from './hosts-domains';

beforeEach(() => {
  handlers.clear();
  getHost.mockReset().mockReturnValue(null);
  updateHost.mockReset();
  setHostSecret.mockReset();
  testHost.mockReset();
  registerHostsDomains({ createPtyDataSink: () => Object.assign(() => {}, { flush: () => {} }) });
});

function call(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`channel ${channel} was not registered`);
  return handler({} as never, ...args);
}

describe('hosts:setSecret', () => {
  // Row 46: the secret store is keyed by host id. Without the gate a stale id
  // (double submit, a host deleted while the modal was open) wrote a
  // ciphertext entry no record would ever read or clear.
  it('writes password/keypass under the documented keys for a real host', () => {
    getHost.mockReturnValue({ id: 'lab' });
    expect(() => call('hosts:setSecret', 'lab', 'password', 'pw')).not.toThrow();
    expect(setHostSecret).toHaveBeenLastCalledWith('lab', 'pw');
    expect(() => call('hosts:setSecret', 'lab', 'keypass', 'pp')).not.toThrow();
    expect(setHostSecret).toHaveBeenLastCalledWith('keypass:lab', 'pp');
  });

  it('refuses an id with no registry host and stores nothing', () => {
    getHost.mockReturnValue(null);
    expect(() => call('hosts:setSecret', 'gone', 'password', 'pw')).toThrow(/unknown host/);
    expect(setHostSecret).not.toHaveBeenCalled();
  });
});

// Audit row 93 pin: `hosts:stat` feeds the Add-project DIR BROWSER, so it
// stays on the host-exists + enrolled gate and path safety ALONE — the browser
// has to name folders that are not projects yet. The contained twins are the
// tree rails (fs:exists / fs:stat / fs:isDirectory), which call
// isRemotePathInKnownProject before reaching remote-fs; gating this channel is
// what would leave the Add-project modal blind to a fresh folder.
describe('hosts:stat (dir-browser lane, row 93)', () => {
  it('answers for a path outside every known project, ungated', async () => {
    getHost.mockReturnValue({ id: 'lab', enrollmentStatus: 'enrolled' });
    statRemotePath.mockResolvedValue({ ok: true, isDirectory: true, size: 4096, mtimeMs: 1 });
    await expect(call('hosts:stat', 'lab', '/srv/brand-new-folder'))
      .resolves.toMatchObject({ ok: true, isDirectory: true });
    expect(statRemotePath).toHaveBeenCalledWith('lab', '/srv/brand-new-folder');
  });
});

describe('hosts:test status producer (row 46)', () => {
  const draft = { id: 'lab', enrollmentStatus: 'draft' } as HostRecord;

  it('persists auth-ok when the auth probe passes on a draft', async () => {
    getHost.mockReturnValue(draft);
    testHost.mockResolvedValue({ ok: true, hostKeyChanged: false, steps: [] });
    await expect(call('hosts:test', 'lab')).resolves.toMatchObject({ ok: true });
    expect(updateHost).toHaveBeenCalledWith('lab', { enrollmentStatus: 'auth-ok' });
  });

  it('never demotes an enrolled host on a re-test', async () => {
    getHost.mockReturnValue({ ...draft, enrollmentStatus: 'enrolled' });
    testHost.mockResolvedValue({ ok: true, hostKeyChanged: false, steps: [] });
    await call('hosts:test', 'lab');
    expect(updateHost).not.toHaveBeenCalled();
  });

  it('never promotes a failed auth probe', async () => {
    getHost.mockReturnValue(draft);
    testHost.mockResolvedValue({ ok: false, hostKeyChanged: false, steps: [{ step: 'connect', ok: false }] });
    await call('hosts:test', 'lab');
    expect(updateHost).not.toHaveBeenCalled();
  });
});
