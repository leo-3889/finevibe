import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, ' ');

let cachedKey: Buffer | null = null;

function getKeychainPassphrase(): string {
  // Triggers a Keychain access prompt the first time.
  const out = execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-wa', 'Chrome'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.trim();
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const pass = getKeychainPassphrase();
  cachedKey = crypto.pbkdf2Sync(pass, SALT, ITERATIONS, KEY_LENGTH, 'sha1');
  return cachedKey;
}

/** Decrypts a Chrome v10 cookie/password value on macOS. */
export function decryptValue(encrypted: Buffer): Buffer {
  if (encrypted.length === 0) return Buffer.alloc(0);
  if (encrypted[0] === 0x76 /* 'v' */ && encrypted[1] === 0x31 /* '1' */ && encrypted[2] === 0x30 /* '0' */) {
    encrypted = encrypted.subarray(3);
  } else {
    // Not Chrome-encrypted; return as-is.
    return Buffer.from(encrypted);
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  // Chrome doesn't include the PKCS#7 padding bytes count flag, but Node handles it.
  const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return out;
}

/**
 * For Chrome cookie DB schema version >= 24, the decrypted payload is prefixed
 * with a 32-byte SHA-256 domain hash that must be stripped.
 */
export function stripDomainHash(plaintext: Buffer, hasDomainHash: boolean): string {
  if (hasDomainHash && plaintext.length >= 32) {
    return plaintext.subarray(32).toString('utf-8');
  }
  return plaintext.toString('utf-8');
}

export function _resetCache(): void {
  cachedKey = null;
}
