import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'child_process';
import { decryptValue, getKeyError, _resetCache } from './decrypt-linux';

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
