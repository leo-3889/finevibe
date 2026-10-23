import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
// The decrypt.ts pipeline branches on the platform flags at call time;
// force the Linux path so decryptChromeValue is testable on any host.
vi.mock('../platform', () => ({ isMac: false, isWin: false, isLinux: true }));

import { execFileSync } from 'child_process';
import { decryptValue, getKeyError, _resetCache } from './decrypt-linux';
import { decryptChromeValue } from './decrypt';

const mockExec = vi.mocked(execFileSync);
const FALLBACK_PASS = 'peanuts';

beforeEach(() => {
  vi.clearAllMocks();
  _resetCache();
});

function encryptValue(plaintext: string, passphrase: string): Buffer {
  const key = crypto.pbkdf2Sync(passphrase, 'saltysalt', 1, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

describe('decrypt-linux', () => {
  // P2-48: an unreachable keyring (headless D-Bus) blocked the app behind a
  // hung secret-tool call — the lookup must be bounded.
  it('queries secret-tool with a bounded timeout', () => {
    mockExec.mockReturnValue('keyring-passphrase\n');
    decryptValue(encryptValue('abc', 'keyring-passphrase'));
    expect(mockExec).toHaveBeenCalledWith(
      'secret-tool',
      ['lookup', 'application', 'chrome'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('decrypts with the keyring passphrase returned by secret-tool', () => {
    mockExec.mockReturnValue('keyring-passphrase\n');
    expect(decryptValue(encryptValue('abc', 'keyring-passphrase')).toString('utf-8')).toBe('abc');
    expect(getKeyError()).toBeNull();
  });

  // P2-49 honesty: when no keyring passphrase exists, the default-keyring
  // fallback is used but the result carries why the keyring was unavailable.
  it('falls back to the default keyring password and records why', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    });
    expect(decryptValue(encryptValue('abc', FALLBACK_PASS)).toString('utf-8')).toBe('abc');
    expect(getKeyError()).toMatch(/keyring/i);
  });

  it('maps a secret-tool timeout to the keyring-unavailable reason', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync secret-tool ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    decryptValue(encryptValue('abc', FALLBACK_PASS));
    expect(getKeyError()).toMatch(/timed out|keyring/i);
  });
});

// P2-49: the real Linux failure mode — secret-tool missing (keyringError
// recorded, peanuts fallback key derived) while the cookies are encrypted
// with the keyring key. The throw must carry BOTH the actionable keyring
// diagnosis and the raw decrypt failure; it used to carry only 'bad decrypt'.
describe('decryptChromeValue (Linux pipeline, keyring fallback)', () => {
  it('keeps the keyring diagnosis alongside the bad-decrypt reason', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    });
    // 'abcd' (16-byte payload): the peanuts-key decryption of a
    // keyring-key ciphertext deterministically fails PKCS#7 padding — a
    // 3-byte plaintext's payload happened to pass the padding check.
    const res = decryptChromeValue(encryptValue('abcd', 'keyring-passphrase'), false);
    expect(res.text).toBeNull();
    expect(res.keyError).toMatch(/keyring password not found/i);
    expect(res.keyError).toMatch(/bad decrypt/i);
  });
});
