// Host secrets store (multi-host Phase 1).
//
// Passwords and key passphrases never live in state.json. They go through
// Electron `safeStorage` (OS keychain) into `~/.finevibe/host-secrets.json`
// as `{ [hostId]: base64 }`, 0600, written atomically like store.ts
// `writeStateAtomically`. When safeStorage is unavailable (headless Linux
// without a keyring — plan §8 R1), the store reports unavailable and
// password flows are blocked; key-auth flows work without it.
//
// Secrets are write-only over IPC: no channel ever returns a password, and
// the wizard never echoes it back.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app, safeStorage } from 'electron';

const SECRETS_FILE_NAME = 'host-secrets.json';

let cachedAvailable: boolean | null = null;
let cache: Record<string, string> | null = null;

/** True when this platform can encrypt at rest (Electron safeStorage). */
export function secretsAvailable(): boolean {
  if (cachedAvailable === null) {
    try {
      cachedAvailable = safeStorage.isEncryptionAvailable();
    } catch {
      cachedAvailable = false;
    }
  }
  return cachedAvailable;
}

/** Test seam: force the availability answer (pass null to re-probe). */
export function setSecretsAvailableForTests(value: boolean | null): void {
  cachedAvailable = value;
}

function secretsFilePath(): string {
  return path.join(app.getPath('userData'), SECRETS_FILE_NAME);
}

let filePathOverride: string | null = null;
/** Test seam: point the store at a temp file instead of userData. */
export function setSecretsFileForTests(file: string | null): void {
  filePathOverride = file;
  cache = null;
}

function resolveSecretsFile(): string {
  return filePathOverride ?? secretsFilePath();
}

function loadCache(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(resolveSecretsFile(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    cache = {};
  }
  return cache;
}

function writeCache(): void {
  const file = resolveSecretsFile();
  const tmp = `${file}.tmp`;
  const data = JSON.stringify(cache ?? {}, null, 2);
  // safeStorage output is base64; the file itself is plaintext-encrypted
  // bytes encoded as JSON — mode 0600 like state.json siblings.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Encrypt and store the secret for `hostId`. Throws when unavailable. */
export function setHostSecret(hostId: string, secret: string): void {
  if (!secretsAvailable()) {
    throw new Error('secure storage unavailable: secrets cannot be stored on this platform');
  }
  const encrypted = safeStorage.encryptString(secret).toString('base64');
  loadCache()[hostId] = encrypted;
  writeCache();
}

/** Decrypt the secret for `hostId`, or null when none is stored. */
export function getHostSecret(hostId: string): string | null {
  if (!secretsAvailable()) return null;
  const entry = loadCache()[hostId];
  if (!entry) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry, 'base64'));
  } catch {
    return null;
  }
}

/** Remove the secret for `hostId` (used by "forget password" and host delete). */
export function deleteHostSecret(hostId: string): void {
  if (!secretsAvailable()) return;
  if (!(hostId in loadCache())) return;
  delete (cache as Record<string, string>)[hostId];
  writeCache();
}
