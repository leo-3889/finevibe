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

/**
 * Bound on the in-memory secret cache (module-map-governance allowlist, audit
 * row 46). The ciphertext file is the source of truth — every mutation is a
 * read-modify-write of it — so an LRU-evicted entry is re-read on demand and
 * never dropped on the next write.
 */
export const MAX_CACHED_SECRETS = 64;

/**
 * How long a NEGATIVE safeStorage probe may serve before it is re-checked
 * (audit row 100). A keyring that comes up after boot (gnome-keykeeper
 * started late, D-Bus socket not ready) used to lock every secret flow out for
 * the process lifetime, because the very first answer was cached forever.
 * Positive results stay cached — re-probing a working keyring is the churn we
 * were avoiding.
 */
export const SECRET_PROBE_RETRY_MS = 60_000;

let cachedAvailable: boolean | null = null;
let cachedAvailableAt = 0;
const cache = new Map<string, string>();

/** True when this platform can encrypt at rest (Electron safeStorage). */
export function secretsAvailable(): boolean {
  const now = Date.now();
  if (cachedAvailable === null || (cachedAvailable === false && now - cachedAvailableAt >= SECRET_PROBE_RETRY_MS)) {
    let probed: boolean;
    try {
      probed = safeStorage.isEncryptionAvailable();
    } catch {
      probed = false;
    }
    cachedAvailable = probed;
    cachedAvailableAt = now;
  }
  return cachedAvailable;
}

/** Test seam: force the availability answer (pass null to re-probe). */
export function setSecretsAvailableForTests(value: boolean | null): void {
  cachedAvailable = value;
  cachedAvailableAt = Date.now();
}

function secretsFilePath(): string {
  return path.join(app.getPath('userData'), SECRETS_FILE_NAME);
}

let filePathOverride: string | null = null;
/** Test seam: point the store at a temp file instead of userData. */
export function setSecretsFileForTests(file: string | null): void {
  filePathOverride = file;
  cache.clear();
}

function resolveSecretsFile(): string {
  return filePathOverride ?? secretsFilePath();
}

/** The whole ciphertext file ({} when missing/unreadable/malformed). */
function readStore(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveSecretsFile(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function cacheSet(hostId: string, value: string): void {
  // Insertion order doubles as recency (the fs-utils target-LRU idiom):
  // re-inserting on a hit makes the size cap evict the least recently used
  // ciphertext, not the first host ever stored.
  cache.delete(hostId);
  cache.set(hostId, value);
  while (cache.size > MAX_CACHED_SECRETS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** One ciphertext entry, read through the capped cache. */
function readEntry(hostId: string): string | undefined {
  const hit = cache.get(hostId);
  if (hit !== undefined) {
    cacheSet(hostId, hit);
    return hit;
  }
  const entry = readStore()[hostId];
  if (entry !== undefined) cacheSet(hostId, entry);
  return entry;
}

/**
 * Read-modify-write one entry, atomically. Writing the freshly-read file (not
 * the cache) is what lets the cache stay bounded: an entry that was evicted
 * from memory is still on disk and survives this write.
 */
function mutateEntry(hostId: string, value: string | null): void {
  const store = readStore();
  if (value === null) {
    if (!(hostId in store)) return;
    delete store[hostId];
  } else {
    store[hostId] = value;
  }
  const file = resolveSecretsFile();
  const tmp = `${file}.tmp`;
  // safeStorage output is base64; the file itself is plaintext-encrypted
  // bytes encoded as JSON — mode 0600 like state.json siblings.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache.delete(hostId);
  if (value !== null) cacheSet(hostId, value);
}

/** Encrypt and store the secret for `hostId`. Throws when unavailable. */
export function setHostSecret(hostId: string, secret: string): void {
  if (!secretsAvailable()) {
    throw new Error('secure storage unavailable: secrets cannot be stored on this platform');
  }
  mutateEntry(hostId, safeStorage.encryptString(secret).toString('base64'));
}

/** Decrypt the secret for `hostId`, or null when none is stored. */
export function getHostSecret(hostId: string): string | null {
  if (!secretsAvailable()) return null;
  const entry = readEntry(hostId);
  if (!entry) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry, 'base64'));
  } catch {
    return null;
  }
}

/** Remove the secret for `hostId` (used by "forget password" and host delete). */
export function deleteHostSecret(hostId: string): void {
  // Row 100: NO availability gate. Deleting never decrypts, and the old
  // early-return stranded the ciphertext of a deleted host in
  // host-secrets.json forever on a machine whose keyring went away.
  mutateEntry(hostId, null);
}
