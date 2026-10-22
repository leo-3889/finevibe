import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'mock-keychain-passphrase\n'),
}));

import { execFileSync } from 'child_process';
import { decryptValue, getKeyError, _resetCache } from './decrypt-mac';
import { stripDomainHash } from './domain-hash';

const mockExec = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockReturnValue('mock-keychain-passphrase\n');
  _resetCache();
});

function encryptValue(plaintext: string, passphrase = 'mock-keychain-passphrase'): Buffer {
  const key = crypto.pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

describe('decrypt-mac', () => {
  it('decrypts a v10 cookie value using the keychain passphrase', () => {
    const encrypted = encryptValue('session-token-abc');
    const out = decryptValue(encrypted);
    expect(out).not.toBeNull();
    expect(out!.toString('utf-8')).toBe('session-token-abc');
    expect(mockExec).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-wa', 'Chrome'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('caches the keychain key across calls', () => {
    decryptValue(encryptValue('one'));
    decryptValue(encryptValue('two'));
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('returns value as-is when not Chrome-encrypted (no v10 prefix)', () => {
    const plain = Buffer.from('plain-cookie');
    const out = decryptValue(plain);
    expect(out).not.toBeNull();
    expect(out!.toString('utf-8')).toBe('plain-cookie');
  });

  it('returns empty for empty input', () => {
    const out = decryptValue(Buffer.alloc(0));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(0);
  });

  it('stripDomainHash removes 32 bytes when hasDomainHash is true', () => {
    const hash = Buffer.alloc(32, 0xff);
    const value = Buffer.from('actual-value');
    const combined = Buffer.concat([hash, value]);
    expect(stripDomainHash(combined, true)).toBe('actual-value');
    expect(stripDomainHash(combined, false)).toBe(combined.toString('utf-8'));
  });
});

describe('decrypt-mac keychain failures (P2-48)', () => {
  it('runs the keychain lookup with a bounded timeout', () => {
    decryptValue(encryptValue('x'));
    expect(mockExec).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-wa', 'Chrome'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('returns null and a denial reason when keychain access is denied', () => {
    mockExec.mockImplementation(() => {
      throw new Error('access denied');
    });
    expect(decryptValue(encryptValue('x'))).toBeNull();
    expect(getKeyError()).toMatch(/keychain access denied/i);
  });

  it('maps a keychain prompt timeout to a timeout reason', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync /usr/bin/security ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });
    expect(decryptValue(encryptValue('x'))).toBeNull();
    expect(getKeyError()).toMatch(/timed out/i);
  });
});
