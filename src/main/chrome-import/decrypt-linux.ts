import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

const SALT = 'saltysalt';
const ITERATIONS = 1;
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, ' ');
const FALLBACK_PASS = 'peanuts';

let cachedKey: Buffer | null = null;

function trySecretTool(): string | null {
  for (const app of ['chrome', 'chromium']) {
    try {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'application', app],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const v = out.trim();
      if (v) return v;
    } catch {
      // not found, try next
    }
  }
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

export function _resetCache(): void {
  cachedKey = null;
}
