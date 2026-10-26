import { describe, expect, it } from 'vitest';
import { isRegistryHostTarget, migrateLegacySessionSshHosts, parseSshHost, validateHostRecordShape } from './ssh-host';
import type { HostRecord, ProjectRecord, SessionRecord } from './types';

const VALID_HOST: HostRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'strix',
  user: 'dev',
  host: '192.168.2.242',
  port: 22,
  authKind: 'key',
  privateKeyPath: '/home/finevibe/hosts/3f2504e0-4f89-41d3-9a0c-0305e82c3301/id_ed25519',
  managedKey: true,
  enrollmentStatus: 'enrolled',
};

describe('parseSshHost', () => {
  it('accepts plain hosts', () => {
    expect(parseSshHost('myserver')).toEqual({ host: 'myserver' });
    expect(parseSshHost(' lab.example.com ')).toEqual({ host: 'lab.example.com' });
    expect(parseSshHost('10.0.0.8')).toEqual({ host: '10.0.0.8' });
  });

  it('accepts user@host and normalizes', () => {
    expect(parseSshHost('root@lab.example.com')).toEqual({ host: 'root@lab.example.com', user: 'root' });
    expect(parseSshHost('dev.d-1@host')).toEqual({ host: 'dev.d-1@host', user: 'dev.d-1' });
  });

  it('rejects ports, ssh:// URLs, whitespace, and empty', () => {
    expect(parseSshHost('host:22')).toBeNull();
    expect(parseSshHost('ssh://host')).toBeNull();
    expect(parseSshHost('two words')).toBeNull();
    expect(parseSshHost('a b@c')).toBeNull();
    expect(parseSshHost('')).toBeNull();
    expect(parseSshHost('   ')).toBeNull();
  });

  it('rejects option-injection and shell metacharacters', () => {
    expect(parseSshHost('-oProxyCommand=evil')).toBeNull();
    expect(parseSshHost('host;rm')).toBeNull();
    expect(parseSshHost('host$X')).toBeNull();
    expect(parseSshHost('host`x`')).toBeNull();
    expect(parseSshHost('@host')).toBeNull();
    expect(parseSshHost('user@@host')).toBeNull();
  });

  it('rejects malformed hostnames', () => {
    expect(parseSshHost('-host')).toBeNull();
    expect(parseSshHost('host-')).toBeNull();
    expect(parseSshHost('host..name')).toBeNull();
    expect(parseSshHost('x'.repeat(254))).toBeNull();
    expect(parseSshHost('x'.repeat(253))).toEqual({ host: 'x'.repeat(253) });
  });
});

describe('validateHostRecordShape', () => {
  it('accepts a valid key-auth record unchanged', () => {
    expect(validateHostRecordShape(VALID_HOST)).toEqual(VALID_HOST);
  });

  it('accepts password auth without a key and IPv6 bracketed hosts', () => {
    const pw = { ...VALID_HOST, authKind: 'password' as const, privateKeyPath: undefined, managedKey: false };
    expect(validateHostRecordShape(pw)?.authKind).toBe('password');
    const v6 = { ...VALID_HOST, host: '[fe80::1]' };
    expect(validateHostRecordShape(v6)?.host).toBe('[fe80::1]');
  });

  it('rejects bad shapes: non-object, bad uuid, bad port, bad status, bad authKind', () => {
    expect(validateHostRecordShape(null)).toBeNull();
    expect(validateHostRecordShape('x')).toBeNull();
    expect(validateHostRecordShape([])).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, id: 'not-a-uuid' })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, port: 0 })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, port: 65536 })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, port: 22.5 })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, enrollmentStatus: 'connected' })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, authKind: 'sshkey' })).toBeNull();
  });

  it('rejects key auth without privateKeyPath, and bad optional fields', () => {
    const { privateKeyPath: _p, ...noKey } = VALID_HOST;
    expect(validateHostRecordShape(noKey)).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, lastProbeOk: 'yes' })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, prerequisites: { git: { ok: 'yes' } } })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, name: 'x'.repeat(65) })).toBeNull();
  });

  it('normalizes: trims name, lowercases id, drops unknown keys', () => {
    const raw = { ...VALID_HOST, name: '  strix  ', id: VALID_HOST.id.toUpperCase(), smuggled: 'x' };
    const out = validateHostRecordShape(raw);
    expect(out).not.toBeNull();
    expect(out?.name).toBe('strix');
    expect(out?.id).toBe(VALID_HOST.id);
    expect('smuggled' in (out as object)).toBe(false);
  });

  it('gates the identity color (plan §7): valid #rrggbb survives, anything else drops the record', () => {
    expect(validateHostRecordShape({ ...VALID_HOST, color: '#4c9aff' })?.color).toBe('#4c9aff');
    expect(validateHostRecordShape({ ...VALID_HOST, color: 'url(evil)' })).toBeNull();
    expect(validateHostRecordShape({ ...VALID_HOST, color: '#fff' })).toBeNull();
  });

  it('accepts the full optional surface', () => {
    const full = {
      ...VALID_HOST,
      enrollmentDetail: 'provider codex missing',
      enrolledAt: '2026-10-25T00:00:00.000Z',
      lastProbeAt: '2026-10-25T00:00:00.000Z',
      lastProbeOk: true,
      hostKeyFingerprint: 'SHA256:abc123',
      prerequisites: { git: { ok: true, version: '2.45.0', path: '/usr/bin/git' } },
      defaultFolder: '/home/dev/projects',
      memoryServer: true,
    };
    expect(validateHostRecordShape(full)).toEqual(full);
  });
});

describe('isRegistryHostTarget', () => {
  it('accepts what the registry stores, incl. bracketed IPv6 (audit T1 #2)', () => {
    expect(isRegistryHostTarget('dev', '192.168.2.242')).toBe(true);
    expect(isRegistryHostTarget('dev', 'host.example.com')).toBe(true);
    expect(isRegistryHostTarget('dev', '[::1]')).toBe(true);
  });

  it('rejects argv/quoting smuggles in user or host', () => {
    expect(isRegistryHostTarget('dev;rm', 'h')).toBe(false);
    expect(isRegistryHostTarget('-oProxyJump=x', 'h')).toBe(false);
    expect(isRegistryHostTarget('dev', 'h; rm -rf /')).toBe(false);
    expect(isRegistryHostTarget('dev', '::1')).toBe(false); // unbracketed: not the ssh argv spelling
  });
});

describe('validateHostRecordShape — settingsSync (T3)', () => {
  const base = () => ({ ...VALID_HOST, settingsSync: { providers: ['pi'], lastSyncAt: 'x', lastSyncHashes: { '~/.pi/agent/settings.json': 'ab' } } });
  it('accepts the canonical shape', () => {
    expect(validateHostRecordShape(base())).not.toBeNull();
  });
  it('drops records whose hash keys are not home-relative posix paths (audit T3 #4)', () => {
    for (const key of ['../../etc/x', '/abs/path', 'win\\path', '~/.pi/../x']) {
      const rec = base();
      rec.settingsSync = { ...rec.settingsSync, lastSyncHashes: { [key]: 'ab' } } as typeof rec.settingsSync;
      expect(validateHostRecordShape(rec)).toBeNull();
    }
  });
});

describe('migrateLegacySessionSshHosts (parent §11, sshHost retirement)', () => {
  const host = (id: string, hostname: string): HostRecord => ({ ...VALID_HOST, id, host: hostname });
  const session = (over: Partial<SessionRecord> = {}): SessionRecord =>
    ({ id: 's1', name: 'S1', type: 'terminal', ...over }) as SessionRecord;
  const project = (sessions: SessionRecord[]): ProjectRecord =>
    ({ id: 'p1', path: '/p', sessions }) as ProjectRecord;

  it('a unique hostname match adopts the registry host id and drops the free text', () => {
    const projects = [project([session({ sshHost: 'lab.example.com' })])];
    migrateLegacySessionSshHosts(projects, [host('h1', 'lab.example.com')]);
    expect(projects[0].sessions[0].hostId).toBe('h1');
    expect(projects[0].sessions[0].sshHost).toBeUndefined();
  });

  it('unregistered and AMBIGUOUS hostnames keep sshHost for the legacy wrap', () => {
    const ghost = session({ sshHost: 'nowhere.example.com' });
    const dupA = session({ sshHost: 'dup.example.com' });
    const projects = [project([ghost, dupA])];
    migrateLegacySessionSshHosts(projects, [
      host('h1', 'dup.example.com'),
      host('h2', 'dup.example.com'),
    ]);
    expect(ghost.sshHost).toBe('nowhere.example.com');
    expect(ghost.hostId).toBeUndefined();
    expect(dupA.sshHost).toBe('dup.example.com');
    expect(dupA.hostId).toBeUndefined();
  });

  it('clean sessions are untouched', () => {
    const plain = session({ hostId: 'local' });
    migrateLegacySessionSshHosts([project([plain])], [host('h1', 'lab.example.com')]);
    expect(plain.hostId).toBe('local');
  });
});
