import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

const SALT = 'saltysalt';
const ITERATIONS = 1;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, ' ');
const FALLBACK_PASS = 'peanuts';

let cachedKey: Buffer | null = null;
let keyringError: string | null = null;

/** Bounded so a keyring/D-Bus unlock that can never be answered (headless)
 * cannot block the app. */
const KEYRING_TIMEOUT_MS = 10_000;

function trySecretTool(): string | null {
  let timedOut = false;
  for (const app of ['chrome', 'chromium']) {
    try {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'application', app],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: KEYRING_TIMEOUT_MS },
      );
      const v = out.trim();
      if (v) return v;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ETIMEDOUT') timedOut = true;
      // not found, try next
    }
  }
  keyringError = timedOut
    ? 'Chrome keyring lookup timed out; used the default keyring password'
    : 'Chrome keyring password not found (secret-tool lookup failed); used the default keyring password';
  return null;
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const pass = trySecretTool() || FALLBACK_PASS;
  cachedKey = crypto.pbkdf2Sync(pass, SALT, ITERATIONS, KEY_LENGTH, 'sha1');
  return cachedKey;
}

export function decryptValue(encrypted: Buffer): Buffer {
  if (encrypted.length === 0) return Buffer.alloc(0);
  if (encrypted[0] === 0x76 && (encrypted[1] === 0x31) && (encrypted[2] === 0x30 || encrypted[2] === 0x31)) {
    // v10 or v11 (gnome-keyring marker); both use the same scheme on Linux.
    encrypted = encrypted.subarray(3);
  } else {
    return Buffer.from(encrypted);
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function stripDomainHash(plaintext: Buffer, hasDomainHash: boolean): string {
  if (hasDomainHash && plaintext.length >= 32) {
    return plaintext.subarray(32).toString('utf-8');
  }
  return plaintext.toString('utf-8');
}

/** Why the keyring passphrase lookup fell back to the default password, if it did. */
export function getKeyError(): string | null {
  return keyringError;
}

export function _resetCache(): void {
  cachedKey = null;
  keyringError = null;
}
