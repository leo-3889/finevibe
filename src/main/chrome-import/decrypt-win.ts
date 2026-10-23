import * as crypto from 'crypto';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { chromeUserDataDir, localStatePath } from './paths';

let cachedKey: Buffer | null = null;
/**
 * C3M-04: first legacy-DPAPI row failure, cached so the spawn is capped at
 * one per import (mirrors the P2-48 bounded-lookup contract): the failing
 * row throws (the caller maps it to keyError), every remaining legacy row
 * rethrows the cached reason without touching PowerShell.
 */
let legacyKeyError: string | null = null;

/** Bounded so a hung PowerShell spawn cannot block the import. */
const DPAPI_TIMEOUT_MS = 15_000;

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
    timeout: DPAPI_TIMEOUT_MS,
  });
  return Buffer.from(out.trim(), 'base64');
}

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) throw new Error('Chrome user data directory not found');
  const statePath = localStatePath(userDataDir);
  const raw = fs.readFileSync(statePath, 'utf-8');
  let parsed: LocalState;
  try {
    parsed = JSON.parse(raw) as LocalState;
  } catch {
    // A half-written / hand-edited Local State used to surface a bare
    // `SyntaxError: Unexpected token` in the import UI.
    throw new Error(`Chrome "Local State" is not valid JSON: ${statePath}`);
  }
  const b64 = parsed.os_crypt?.encrypted_key;
  if (!b64) {
    // Chrome 127+ on Windows moves the cookie key to the app-bound
    // `app_bound_encrypted_key` (APPB, decryptable only from a Chrome-named
    // process) and may stop writing `os_crypt.encrypted_key` entirely. The
    // bare 'encrypted_key not found' read as a corrupt install; name the
    // real cause so the modal's keyError line tells the user why v20 rows
    // cannot be imported.
    throw new Error(
      'Chrome app-bound encryption: master key unavailable (Chrome 127+); v20 cookies cannot be imported',
    );
  }
  const blob = Buffer.from(b64, 'base64');
  // Chrome prefixes the DPAPI blob with the ASCII bytes "DPAPI".
  if (blob.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('encrypted_key missing DPAPI prefix');
  }
  cachedKey = dpapiUnprotect(blob.subarray(5).toString('base64'));
  return cachedKey;
}

/**
 * Returns the protocol version: 'v10' (AES-GCM), 'v11'/'v20' (App-Bound
 * Encryption, undecryptable out-of-process — Chrome 127+ writes 'v20' on
 * Windows; keep recognizing 'v11' so any v11-tagged row skips on the same
 * channel instead of falling to 'plain'), 'legacy' (DPAPI-direct), or 'plain'.
 */
export function detectVersion(encrypted: Buffer): 'v10' | 'v11' | 'v20' | 'legacy' | 'plain' {
  if (encrypted.length === 0) return 'plain';
  const head = encrypted.subarray(0, 3).toString('ascii');
  if (head === 'v10') return 'v10';
  if (head === 'v11') return 'v11';
  if (head === 'v20') return 'v20';
  // Legacy DPAPI-direct format starts with 0x01 0x00 0x00 0x00 (CryptoAPI structure marker)
  if (encrypted[0] === 0x01 && encrypted[1] === 0x00 && encrypted[2] === 0x00 && encrypted[3] === 0x00) return 'legacy';
  return 'plain';
}

/** Decrypts a Chrome value on Windows. Returns null for App-Bound (v11/v20). */
export function decryptValue(encrypted: Buffer): Buffer | null {
  if (encrypted.length === 0) return Buffer.alloc(0);
  const version = detectVersion(encrypted);
  if (version === 'v11' || version === 'v20') return null;
  if (version === 'plain') return Buffer.from(encrypted);
  if (version === 'legacy') {
    if (legacyKeyError) throw new Error(legacyKeyError);
    try {
      return dpapiUnprotect(encrypted.toString('base64'));
    } catch (err) {
      legacyKeyError = `legacy DPAPI decrypt failed: ${(err as Error).message}`;
      throw err;
    }
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

export function _resetCache(): void {
  cachedKey = null;
  legacyKeyError = null;
}
