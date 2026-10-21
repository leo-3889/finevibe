import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, ' ');

let cachedKey: Buffer | null = null;
let keychainError: string | null = null;

/** Bounded so a keychain prompt the user never answers cannot freeze the app. */
const KEYCHAIN_TIMEOUT_MS = 15_000;

function getKeychainPassphrase(): string | null {
  // Triggers a Keychain access prompt the first time. Denial and timeout
  // both map to a recorded reason (P2-48) instead of a per-row throw.
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-wa', 'Chrome'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return out.trim();
  } catch (err) {
    keychainError =
      (err as NodeJS.ErrnoException).code === 'ETIMEDOUT'
        ? 'macOS keychain prompt timed out'
        : 'macOS keychain access denied';
    return null;
  }
}

function getKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const pass = getKeychainPassphrase();
  if (pass === null) return null;
  cachedKey = crypto.pbkdf2Sync(pass, SALT, ITERATIONS, KEY_LENGTH, 'sha1');
  return cachedKey;
}

/**
 * Decrypts a Chrome v10 cookie/password value on macOS.
 * Returns null when the keychain passphrase is unavailable (denied or
 * timed out); call getKeyError() for the reason.
 */
export function decryptValue(encrypted: Buffer): Buffer | null {
  if (encrypted.length === 0) return Buffer.alloc(0);
  if (encrypted[0] === 0x76 /* 'v' */ && encrypted[1] === 0x31 /* '1' */ && encrypted[2] === 0x30 /* '0' */) {
    encrypted = encrypted.subarray(3);
  } else {
    // Not Chrome-encrypted; return as-is.
    return Buffer.from(encrypted);
  }
  const key = getKey();
  if (key === null) return null;
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

/** First keychain failure reason recorded by decryptValue, if any. */
export function getKeyError(): string | null {
  return keychainError;
}

export function _resetCache(): void {
  cachedKey = null;
  keychainError = null;
}
