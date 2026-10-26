// Settings push (per-host providers T3): seam-mocked end-to-end — the same
// scripted-fake idiom as enrollment.test.ts. Local + remote lanes are two
// in-memory maps behind the mocked provider-fs; exec is a scripted log.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import type { HostRecord, ProviderId } from '../../shared/types';

// Local lane = what buildSettingsBundle reads (hostId undefined); remote lane
// = what the push writes (hostId record.id). Directories carry a trailing /.
const localFiles = new Map<string, string>();
const localDirs = new Set<string>();
const remote = new Map<string, string>();

const plane = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  listDir: vi.fn(),
}));
vi.mock('./provider-fs', () => ({
  readProviderFile: plane.read,
  writeProviderFile: plane.write,
  listProviderDir: plane.listDir,
}));

const execLog: string[] = [];
let nodePresent = true;
vi.mock('./ssh-client', () => ({
  exec: vi.fn(async (_record: unknown, command: string) => {
    execLog.push(command);
    if (command.includes('npm install') && !nodePresent) throw new Error('node: not found');
    return '';
  }),
}));

const updates: Record<string, unknown>[] = [];
vi.mock('./host-registry', () => ({
  updateHost: vi.fn((id: string, patch: Record<string, unknown>) => {
    updates.push(patch);
    return { id, ...patch };
  }),
}));

import { remotePathArg, syncSettingsToHost } from './settings-sync';

const record: HostRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'strix',
  user: 'dev',
  host: '192.168.2.242',
  port: 22,
  authKind: 'key',
  managedKey: true,
  privateKeyPath: '/k',
  enrollmentStatus: 'enrolled',
  prerequisites: { node: { ok: true, path: '/usr/bin/node' } },
};

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const PI_SET = {
  '~/.pi/agent/settings.json': '{"model":"opus"}\n',
  '~/.pi/agent/AGENTS.md': '# rules\n',
  '~/.pi/agent/skills/a/SKILL.md': 'skill a\n',
};
const OMP_SET = {
  '~/.omp/agent/settings.json': '{"theme":"dark"}\n',
  '~/.omp/plugins/package.json': '{"dependencies":{"p":"1"}}\n',
  '~/.omp/plugins/omp-plugins.lock.json': '{}\n',
};

function seedLocal(files: Record<string, string>, dirs: string[] = []): void {
  localFiles.clear();
  localDirs.clear();
  for (const [k, v] of Object.entries(files)) localFiles.set(k, v);
  for (const d of dirs) localDirs.add(d);
}

beforeEach(() => {
  plane.read.mockReset().mockImplementation(async (hostId: string | undefined, p: string) =>
    (hostId === undefined ? localFiles : remote).get(p) ?? null,
  );
  plane.write.mockReset().mockImplementation(async (hostId: string | undefined, p: string, content: string) => {
    (hostId === undefined ? localFiles : remote).set(p, content);
  });
  plane.listDir.mockReset().mockImplementation(async (hostId: string | undefined, d: string) => {
    if (hostId !== undefined) return null; // the bundle reads the local lane only
    if (!localDirs.has(d)) return null;
    const names = new Set<string>();
    for (const p of [...localFiles.keys()]) {
      if (p.startsWith(d) && !p.slice(d.length).includes('/')) names.add(p.slice(d.length));
    }
    for (const x of localDirs) {
      if (x === d || !x.startsWith(d)) continue;
      const rest = x.slice(d.length).replace(/\/$/, '');
      if (rest && !rest.includes('/')) names.add(rest);
    }
    return [...names];
  });
  execLog.length = 0;
  updates.length = 0;
  remote.clear();
  nodePresent = true;
});

describe('remotePathArg', () => {
  it('quotes and expands `~/` for the remote shell, escaping $ ` \\ "', () => {
    expect(remotePathArg('~/.pi/agent')).toBe('"$HOME/.pi/agent"');
    expect(remotePathArg("~/.pi/agent/it's `id` $(x)")).toBe('"$HOME/.pi/agent/it\'s \\`id\\` \\$(x)"');
  });
});

describe('syncSettingsToHost — push e2e', () => {
  it('pushes the bundle, backs up, records hashes/providers, npm-installs manifests', async () => {
    seedLocal({ ...PI_SET, '~/.pi/agent/npm/package.json': '{}\n' }, ['~/.pi/agent/skills/', '~/.pi/agent/skills/a/']);
    remote.set('~/.pi/agent/settings.json', 'OLD REMOTE\n');
    // Foreign remote content with no stored hash is drift (audit T3 #1) —
    // this test's point is the push mechanics, so it arrives confirmed.
    const res = await syncSettingsToHost(record, ['pi', 'pi-bolt'], { confirmOverwrite: true });
    expect(res.ok).toBe(true);
    expect(remote.get('~/.pi/agent/settings.json')).toBe('{"model":"opus"}\n');
    expect(remote.get('~/.pi/agent/AGENTS.md')).toBe('# rules\n');
    expect(remote.get('~/.pi/agent/skills/a/SKILL.md')).toBe('skill a\n');
    // One `.bak` per path holding the pre-sync remote content.
    expect(remote.get('~/.pi/agent/settings.json.bak')).toBe('OLD REMOTE\n');
    expect(remote.get('~/.pi/agent/AGENTS.md.bak')).toBeUndefined(); // nothing existed → no backup
    // Parent dirs ride the exec lane (the seam never creates dirs).
    expect(execLog).toContain('mkdir -p "$HOME/.pi/agent"');
    expect(execLog).toContain('mkdir -p "$HOME/.pi/agent/skills/a"');
    // Manifest synced + node present → npm install on the host.
    expect(execLog).toContain('cd "$HOME/.pi/agent/npm" && npm install');
    const patch = updates[0] as { settingsSync?: { providers: ProviderId[]; lastSyncAt?: string; lastSyncHashes?: Record<string, string> } };
    expect(patch.settingsSync?.providers).toEqual(['pi', 'pi-bolt']);
    expect(patch.settingsSync?.lastSyncAt).toBeTruthy();
    expect(patch.settingsSync?.lastSyncHashes?.['~/.pi/agent/settings.json']).toBe(sha256('{"model":"opus"}\n'));
  });

  it('one `.bak` per shared path across pi + pi-bolt, replaced each sync', async () => {
    seedLocal({ '~/.pi/agent/settings.json': '{"v":2}\n', '~/.pi/agent/npm/package.json': '{}\n' });
    remote.set('~/.pi/agent/settings.json', '{"v":1}\n');
    // Foreign remote content → drift (audit T3 #1); this test exercises the
    // backup rotation, so it arrives confirmed.
    await syncSettingsToHost(record, ['pi', 'pi-bolt'], { confirmOverwrite: true });
    const baks = plane.write.mock.calls.filter(([, p]) => p === '~/.pi/agent/settings.json.bak');
    expect(baks).toHaveLength(1);
    expect(baks[0][2]).toBe('{"v":1}\n');
    // Second sync: the SAME single backup slot, now holding v2 (one backup,
    // replaced — never a v1.bak1 chain).
    plane.write.mockClear();
    await syncSettingsToHost(record, ['pi', 'pi-bolt']);
    const baks2 = plane.write.mock.calls.filter(([, p]) => p === '~/.pi/agent/settings.json.bak');
    expect(baks2).toHaveLength(1);
    expect(baks2[0][2]).toBe('{"v":2}\n');
    expect([...remote.keys()].filter((k) => k.endsWith('.bak')).sort()).toEqual([
      '~/.pi/agent/npm/package.json.bak', // each overwritten path owns exactly one slot
      '~/.pi/agent/settings.json.bak',
    ]);
  });

  it('omp: npm install runs in the plugins dir; absent node → skip with a warning', async () => {
    seedLocal(OMP_SET);
    const res = await syncSettingsToHost(record, ['omp']);
    expect(res.ok).toBe(true);
    expect(execLog).toContain('cd "$HOME/.omp/plugins" && npm install');
    expect(res.steps.find((s) => s.step === 'npm')?.ok).toBe(true);

    nodePresent = false;
    const rec = { ...record, prerequisites: { node: { ok: false } } };
    const res2 = await syncSettingsToHost(rec, ['omp']);
    expect(res2.ok).toBe(true); // files pushed; the install skip is a warning
    expect(res2.steps.find((s) => s.step === 'npm')).toMatchObject({ ok: false, detail: /node missing.*skipped/ });
    expect(execLog.filter((c) => c.includes('npm install'))).toHaveLength(1); // only the first run
  });

  it('refuses a non-enrolled host and a non-syncable selection', async () => {
    seedLocal(PI_SET);
    expect((await syncSettingsToHost({ ...record, enrollmentStatus: 'draft' }, ['pi'])).ok).toBe(false);
    expect((await syncSettingsToHost(record, ['claude'] as ProviderId[])).ok).toBe(false);
    expect(plane.write).not.toHaveBeenCalled();
  });

  it('a per-file failure is reported, and the good files still land', async () => {
    seedLocal({ ...PI_SET });
    plane.write.mockImplementation(async (hostId: string | undefined, p: string, content: string) => {
      if (hostId !== undefined && p === '~/.pi/agent/AGENTS.md') throw new Error('sftp failure');
      if (hostId !== undefined) remote.set(p, content);
    });
    const res = await syncSettingsToHost(record, ['pi']);
    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toContain('AGENTS.md');
    expect(remote.get('~/.pi/agent/settings.json')).toBeTruthy();
  });
});

describe('drift gate', () => {
  const withSync = (hashes: Record<string, string>): HostRecord => ({
    ...record,
    settingsSync: { providers: ['pi'], lastSyncAt: '2026-01-01T00:00:00.000Z', lastSyncHashes: hashes },
  });

  it('drifted remote content blocks the push until confirmed', async () => {
    seedLocal(PI_SET);
    const rec = withSync({ '~/.pi/agent/settings.json': sha256('{"model":"opus"}\n') });
    remote.set('~/.pi/agent/settings.json', 'locally edited on host\n');
    const res = await syncSettingsToHost(rec, ['pi']);
    expect(res.ok).toBe(false);
    expect(res.drift).toEqual(['~/.pi/agent/settings.json']);
    expect(plane.write).not.toHaveBeenCalled(); // nothing touched
    // Confirmed Overwrite: the push proceeds and re-baselines the hashes.
    const res2 = await syncSettingsToHost(rec, ['pi'], { confirmOverwrite: true });
    expect(res2.ok).toBe(true);
    expect(remote.get('~/.pi/agent/settings.json')).toBe('{"model":"opus"}\n');
    expect(remote.get('~/.pi/agent/settings.json.bak')).toBe('locally edited on host\n');
    const patch = updates[0] as { settingsSync?: { lastSyncHashes?: Record<string, string> } };
    expect(patch.settingsSync?.lastSyncHashes?.['~/.pi/agent/settings.json']).toBe(sha256('{"model":"opus"}\n'));
  });

  it('first sync with foreign content on the host asks first — no silent clobber (audit T3 #1)', async () => {
    seedLocal(PI_SET);
    // No stored hashes at all (never synced), host has its own file (T2 hooks).
    remote.set('~/.pi/agent/settings.json', '{"host":"own"}\n');
    const res = await syncSettingsToHost(record, ['pi']);
    expect(res.ok).toBe(false);
    expect(res.drift).toEqual(['~/.pi/agent/settings.json']);
    expect(plane.write).not.toHaveBeenCalled();
    // Confirmed: pushes, and the host's file is recoverable from .bak.
    const res2 = await syncSettingsToHost(record, ['pi'], { confirmOverwrite: true });
    expect(res2.ok).toBe(true);
    expect(remote.get('~/.pi/agent/settings.json.bak')).toBe('{"host":"own"}\n');
  });

  it('identical foreign content is not drift — first sync pushes freely (audit T3 #1)', async () => {
    seedLocal(PI_SET);
    remote.set('~/.pi/agent/settings.json', '{"model":"opus"}\n'); // byte-equal
    const res = await syncSettingsToHost(record, ['pi']);
    expect(res.ok).toBe(true);
    expect(res.drift).toBeUndefined();
  });

  it('npm install is skipped when the manifest write failed (audit T3 #2)', async () => {
    seedLocal({ ...PI_SET, '~/.pi/agent/npm/package.json': '{}\n' });
    plane.write.mockImplementation(async (hostId: string | undefined, p: string, content: string) => {
      if (hostId !== undefined && p === '~/.pi/agent/npm/package.json') throw new Error('sftp failure');
      if (hostId !== undefined) remote.set(p, content);
    });
    const res = await syncSettingsToHost(record, ['pi', 'pi-bolt']);
    expect(res.ok).toBe(false);
    expect(execLog.some((c) => c.includes('npm install'))).toBe(false);
  });

  it('matching remote content is not drift', async () => {
    seedLocal(PI_SET);
    remote.set('~/.pi/agent/settings.json', '{"model":"opus"}\n');
    const rec = withSync({ '~/.pi/agent/settings.json': sha256('{"model":"opus"}\n') });
    const res = await syncSettingsToHost(rec, ['pi']);
    expect(res.drift).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('a stored file deleted on the host counts as drift', async () => {
    seedLocal(PI_SET);
    const rec = withSync({ '~/.pi/agent/AGENTS.md': sha256('# rules\n') });
    const res = await syncSettingsToHost(rec, ['pi']);
    expect(res.drift).toEqual(['~/.pi/agent/AGENTS.md']);
  });
});
