// Audit row 35: the per-host SSH trust store the interactive `ssh -tt` lanes
// point at. The seed content (token spelling, keytype, 0600) and the argv the
// store contributes are the whole contract; both lanes' wiring is asserted in
// pty-manager.test.ts and the seeding call site in enrollment.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import type { HostRecord } from '../../shared/types';

vi.mock('electron', () => ({ app: { getPath: () => '/mock/userData' } }));
vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import * as fs from 'fs';
import { hostTrustSshArgs, hostTrustStorePath, knownHostsLine, knownHostsToken, seedHostTrustStore } from './host-trust';

const mockExistsSync = vi.mocked(fs.existsSync);

/** SSH wire public-key blob: `string(keytype) string(key-material)`. */
function wireBlob(keytype: string, body = 'keymaterial'): Buffer {
  const str = (b: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([str(Buffer.from(keytype, 'ascii')), str(Buffer.from(body, 'utf8'))]);
}

const record: HostRecord = {
  id: 'host-1',
  name: 'Lab',
  user: 'dev',
  host: '192.0.2.242', // pii-allow: RFC 5737 documentation address
  port: 22,
  authKind: 'key',
  managedKey: true,
  enrollmentStatus: 'enrolled',
  hostKeyFingerprint: `SHA256:${'A'.repeat(43)}=`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

describe('knownHostsToken (row 35)', () => {
  it('uses the bare host on port 22 and the bracketed host:port elsewhere', () => {
    expect(knownHostsToken('192.0.2.242', 22)).toBe('192.0.2.242');
    // ssh stores/looks up `[host]:port` whenever -p is not the default, so a
    // plain-host line would never match and the host reads as unknown.
    expect(knownHostsToken('192.0.2.242', 2222)).toBe('[192.0.2.242]:2222');
    // The registry's bracketed IPv6 spelling loses the brackets (ssh strips them).
    expect(knownHostsToken('[fd00::5]', 22)).toBe('fd00::5');
    expect(knownHostsToken('[fd00::5]', 2222)).toBe('[fd00::5]:2222');
    expect(knownHostsToken('build.example.com', 22)).toBe('build.example.com');
  });
});

describe('seedHostTrustStore (row 35)', () => {
  it('writes one <token> <keytype> <base64> line at 0600 under hosts/<id>/', () => {
    const key = wireBlob('ssh-ed25519');
    const file = seedHostTrustStore({ ...record, port: 2222 }, key);

    expect(file).toBe(path.join('/mock/userData', 'hosts', 'host-1', 'known_hosts'));
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(file), { recursive: true, mode: 0o700 });
    expect(fs.writeFileSync).toHaveBeenCalledWith(file, `[192.0.2.242]:2222 ssh-ed25519 ${key.toString('base64')}\n`, {
      mode: 0o600,
    });
  });

  it('re-seeding a rotated key replaces the file (re-pin is the only writer)', () => {
    seedHostTrustStore(record, wireBlob('ssh-ed25519', 'old'));
    seedHostTrustStore(record, wireBlob('ecdsa-sha2-nistp256', 'new'));
    const last = vi.mocked(fs.writeFileSync).mock.calls.at(-1)!;
    expect(last[1]).toBe(`192.0.2.242 ecdsa-sha2-nistp256 ${wireBlob('ecdsa-sha2-nistp256', 'new').toString('base64')}\n`);
  });

  it('refuses a blob whose keytype is not an SSH key type (no junk line in a trust store)', () => {
    expect(() => seedHostTrustStore(record, Buffer.from('garbage without a length prefix'))).toThrow(/not a recognised SSH public key blob/);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('knownHostsLine carries exactly the three fields ssh parses', () => {
    const key = wireBlob('ssh-rsa');
    expect(knownHostsLine(record, key).split(' ')).toEqual(['192.0.2.242', 'ssh-rsa', key.toString('base64')]);
  });
});

describe('hostTrustSshArgs (row 35)', () => {
  it('adds no option when the host was never seeded (user-store passthrough)', () => {
    expect(hostTrustSshArgs(record)).toEqual([]);
  });

  it('points ssh at the store and refuses unknown keys once seeded', () => {
    mockExistsSync.mockImplementation((p) => String(p) === path.join('/mock/userData', 'hosts', 'host-1', 'known_hosts'));
    expect(hostTrustSshArgs(record)).toEqual([
      '-o',
      `UserKnownHostsFile=${path.join('/mock/userData', 'hosts', 'host-1', 'known_hosts')}`,
      // Without `yes` an unseeded key raises ssh's y/n prompt, which APPENDS the
      // attacker's key to this file — the exact hole row 35 closes.
      '-o',
      'StrictHostKeyChecking=yes',
    ]);
  });
});
