import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => 'mock-keychain-passphrase\n'),
}));

import { execFileSync } from 'child_process';
import { decryptValue, stripDomainHash, _resetCache } from './decrypt-mac';

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
    expect(out.toString('utf-8')).toBe('session-token-abc');
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
    expect(decryptValue(plain).toString('utf-8')).toBe('plain-cookie');
  });

  it('returns empty for empty input', () => {
    expect(decryptValue(Buffer.alloc(0)).length).toBe(0);
  });

  it('stripDomainHash removes 32 bytes when hasDomainHash is true', () => {
    const hash = Buffer.alloc(32, 0xff);
    const value = Buffer.from('actual-value');
    const combined = Buffer.concat([hash, value]);
    expect(stripDomainHash(combined, true)).toBe('actual-value');
    expect(stripDomainHash(combined, false)).toBe(combined.toString('utf-8'));
  });
});
