import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// Conventions from decrypt-linux.test.ts: the spawn boundary is mocked so no
// real powershell.exe is touched on any host, and the platform flags are
// forced so the decrypt.ts Windows pipeline is testable everywhere. `fs` and
// `./paths` are mocked to fake the Chrome "Local State" master-key file.
vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../platform', () => ({ isMac: false, isWin: true, isLinux: false }));

const fixture = vi.hoisted(() => ({
  userDataDir: 'C:\\fake\\User Data' as string | null,
  localState: '{}',
}));
vi.mock('fs', () => ({ readFileSync: vi.fn(() => fixture.localState) }));
vi.mock('./paths', () => ({
  chromeUserDataDir: () => fixture.userDataDir,
  localStatePath: (dir: string) => `${dir}/Local State`,
}));

import { execFileSync } from 'child_process';
import { decryptValue, detectVersion, _resetCache } from './decrypt-win';
import { decryptChromeValue } from './decrypt';

const mockExec = vi.mocked(execFileSync);
const MASTER_KEY = crypto.randomBytes(32);

function localStateWithKey(key: Buffer | null): string {
  if (!key) return JSON.stringify({});
  // Chrome prefixes the DPAPI blob with the ASCII bytes "DPAPI".
  const blob = Buffer.concat([Buffer.from('DPAPI', 'ascii'), key]);
  return JSON.stringify({ os_crypt: { encrypted_key: blob.toString('base64') } });
}

function encryptValue(plaintext: string, key: Buffer): Buffer {
  // v10 layout: [3-byte prefix][12-byte IV][ciphertext][16-byte auth tag]
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), iv, enc, cipher.getAuthTag()]);
}

const LEGACY_BLOB = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(24, 7)]);

beforeEach(() => {
  vi.clearAllMocks();
  _resetCache();
  fixture.userDataDir = 'C:\\fake\\User Data';
  fixture.localState = localStateWithKey(MASTER_KEY);
  mockExec.mockImplementation(() => {
    throw new Error('powershell.exe spawn reached the test boundary — mock every DPAPI call');
  });
});

describe('detectVersion (Windows)', () => {
  it('classifies v10, v11, v20, legacy-DPAPI and plain blobs', () => {
    expect(detectVersion(Buffer.concat([Buffer.from('v10'), Buffer.alloc(40)]))).toBe('v10');
    expect(detectVersion(Buffer.concat([Buffer.from('v11'), Buffer.alloc(40)]))).toBe('v11');
    // Chrome 127+ writes the App-Bound prefix 'v20' on Windows; recognizing
    // it is the difference between a clean skip and importing binary garbage.
    expect(detectVersion(Buffer.concat([Buffer.from('v20'), Buffer.alloc(40)]))).toBe('v20');
    expect(detectVersion(LEGACY_BLOB)).toBe('legacy');
    expect(detectVersion(Buffer.alloc(0))).toBe('plain');
    expect(detectVersion(Buffer.from('hello', 'utf-8'))).toBe('plain');
  });
});

describe('decryptValue (Windows)', () => {
  it('skips v20 App-Bound rows on the null channel without spawning PowerShell', () => {
    const v20 = Buffer.concat([Buffer.from('v20'), Buffer.alloc(32, 9)]);
    expect(decryptValue(v20)).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('keeps skipping v11-tagged rows on the same channel', () => {
    expect(decryptValue(Buffer.concat([Buffer.from('v11'), Buffer.alloc(32, 9)]))).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('passes plain values through', () => {
    expect(decryptValue(Buffer.from('hello', 'utf-8'))!.toString('utf-8')).toBe('hello');
    expect(decryptValue(Buffer.alloc(0))!.length).toBe(0);
  });

  it('decrypts v10 with the DPAPI-unprotected master key via a bounded PowerShell spawn', () => {
    mockExec.mockReturnValue(MASTER_KEY.toString('base64'));
    const plain = decryptValue(encryptValue('secret-cookie', MASTER_KEY));
    expect(plain!.toString('utf-8')).toBe('secret-cookie');
    expect(mockExec).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', expect.any(String)],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('throws an actionable message when os_crypt.encrypted_key is absent (Chrome 127+ app-bound)', () => {
    // Chrome 127+ moves the cookie key to app_bound_encrypted_key (APPB,
    // decryptable only from a Chrome-named process) and may drop
    // os_crypt.encrypted_key; the v10 rows then have no master key at all.
    fixture.localState = localStateWithKey(null);
    expect(() => decryptValue(encryptValue('x', MASTER_KEY))).toThrow(
      /app-bound encryption: master key unavailable \(Chrome 127\+\); v20 cookies cannot be imported/,
    );
  });

  it('decrypts legacy DPAPI-direct rows through the same spawn', () => {
    mockExec.mockReturnValue(Buffer.from('legacy-plain', 'utf-8').toString('base64'));
    expect(decryptValue(LEGACY_BLOB)!.toString('utf-8')).toBe('legacy-plain');
  });

  it('caps the legacy path at one failing spawn (C3M-04 cached reason)', () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error('powershell boom');
    });
    expect(() => decryptValue(LEGACY_BLOB)).toThrow('powershell boom');
    expect(() => decryptValue(LEGACY_BLOB)).toThrow(/legacy DPAPI decrypt failed/);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('decryptChromeValue (Windows pipeline)', () => {
  it('maps the App-Bound null to skipped app-bound', () => {
    const res = decryptChromeValue(Buffer.concat([Buffer.from('v20'), Buffer.alloc(32, 9)]), false);
    expect(res.text).toBeNull();
    expect(res.skipped).toBe('app-bound');
    expect(res.keyError).toBeUndefined();
  });

  it('routes the missing-master-key throw into keyError (P2-49 shape)', () => {
    fixture.localState = localStateWithKey(null);
    const res = decryptChromeValue(encryptValue('x', MASTER_KEY), false);
    expect(res.text).toBeNull();
    expect(res.keyError).toMatch(/app-bound encryption: master key unavailable/i);
    expect(res.keyError).toMatch(/v20 cookies cannot be imported/);
  });
});
