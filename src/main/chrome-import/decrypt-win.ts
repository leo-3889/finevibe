import * as crypto from 'crypto';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { chromeUserDataDir, localStatePath } from './paths';

let cachedKey: Buffer | null = null;

interface LocalState {
  os_crypt?: { encrypted_key?: string };
}

function dpapiUnprotect(encryptedB64: string): Buffer {
  // Shell out to PowerShell so we don't need a native DPAPI addon.
  const script =
    '$bytes = [Convert]::FromBase64String($env:VBY_DPAPI_INPUT);' +
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Console]::Out.Write([Convert]::ToBase64String($plain))';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf-8',
    env: { ...process.env, VBY_DPAPI_INPUT: encryptedB64 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Buffer.from(out.trim(), 'base64');
}

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) throw new Error('Chrome user data directory not found');
  const raw = fs.readFileSync(localStatePath(userDataDir), 'utf-8');
  const parsed = JSON.parse(raw) as LocalState;
  const b64 = parsed.os_crypt?.encrypted_key;
  if (!b64) throw new Error('encrypted_key not found in Local State');
  const blob = Buffer.from(b64, 'base64');
  // Chrome prefixes the DPAPI blob with the ASCII bytes "DPAPI".
  if (blob.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('encrypted_key missing DPAPI prefix');
  }
  cachedKey = dpapiUnprotect(blob.subarray(5).toString('base64'));
  return cachedKey;
}

/** Returns the protocol version: 'v10' (AES-GCM), 'v11' (App-Bound, unsupported), 'legacy' (DPAPI-direct), or 'plain'. */
export function detectVersion(encrypted: Buffer): 'v10' | 'v11' | 'legacy' | 'plain' {
  if (encrypted.length === 0) return 'plain';
  const head = encrypted.subarray(0, 3).toString('ascii');
  if (head === 'v10') return 'v10';
  if (head === 'v11') return 'v11';
  // Legacy DPAPI-direct format starts with 0x01 0x00 0x00 0x00 (CryptoAPI structure marker)
  if (encrypted[0] === 0x01 && encrypted[1] === 0x00 && encrypted[2] === 0x00 && encrypted[3] === 0x00) return 'legacy';
  return 'plain';
}

/** Decrypts a Chrome value on Windows. Returns null for v11 (unsupported). */
export function decryptValue(encrypted: Buffer): Buffer | null {
  if (encrypted.length === 0) return Buffer.alloc(0);
  const version = detectVersion(encrypted);
  if (version === 'v11') return null;
  if (version === 'plain') return Buffer.from(encrypted);
  if (version === 'legacy') {
    return dpapiUnprotect(encrypted.toString('base64'));
  }
  // v10: [3-byte prefix][12-byte IV][ciphertext][16-byte auth tag]
  const key = getMasterKey();
  const iv = encrypted.subarray(3, 15);
  const tagStart = encrypted.length - 16;
  const ciphertext = encrypted.subarray(15, tagStart);
  const tag = encrypted.subarray(tagStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
