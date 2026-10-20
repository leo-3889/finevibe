import Database from 'better-sqlite3';
import type { CookiesSetDetails } from 'electron';
import { decryptChromeValue } from './decrypt';

/** Converts Chrome's WebKit microsecond timestamp (since 1601-01-01) to Unix seconds. */
function webkitToUnixSeconds(microseconds: bigint | number): number | undefined {
  const us = typeof microseconds === 'bigint' ? microseconds : BigInt(Math.trunc(microseconds));
  if (us === 0n) return undefined;
  // microseconds between 1601-01-01 and 1970-01-01:
  const EPOCH_DIFF_US = 11644473600000000n;
  const unixMicro = us - EPOCH_DIFF_US;
  if (unixMicro <= 0n) return undefined;
  return Number(unixMicro / 1000000n);
}

interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  value: string;
  path: string;
  expires_utc: bigint;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

function mapSameSite(n: number): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  // Chromium uses: -1 unspecified, 0 no_restriction, 1 lax, 2 strict
  if (n === 0) return 'no_restriction';
  if (n === 1) return 'lax';
  if (n === 2) return 'strict';
  return 'unspecified';
}

export interface CookieReadResult {
  records: CookiesSetDetails[];
  skippedV11: number;
  /**
   * Why encrypted values could not be decrypted (keychain/keyring denial,
   * timeout, decrypt failure). Null when every encrypted value decrypted.
   * The importer surfaces this so a key-unavailable run is never reported
   * as a successful import of 0 cookies (P2-49).
   */
  keyError: string | null;
}

/** Reads cookies from a snapshotted Cookies SQLite DB and returns Electron-ready records. */
export function readCookies(cookiesDbPath: string): CookieReadResult {
  // P2-44: open read-write. The snapshot is a page copy of a live DB; when
  // Chrome was mid-transaction the header flags a hot journal and SQLite
  // needs write access to roll it back — readonly fails with SQLITE_READONLY
  // and the import silently yields 0 cookies.
  const db = new Database(cookiesDbPath, { fileMustExist: true });
  try {
    let hasDomainHash = false;
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key='version'").get() as { value?: string } | undefined;
      const version = meta?.value ? parseInt(meta.value, 10) : 0;
      if (version >= 24) hasDomainHash = true;
    } catch {
      // meta is optional; cookie rows are still readable without it.
    }

    const rows = db.prepare(
      'SELECT host_key, name, encrypted_value, value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
    ).all() as CookieRow[];

    const records: CookiesSetDetails[] = [];
    let skippedV11 = 0;
    let keyError: string | null = null;

    for (const row of rows) {
      let plain = row.value;
      if (!plain && row.encrypted_value && row.encrypted_value.length > 0) {
        try {
          const result = decryptChromeValue(row.encrypted_value, hasDomainHash);
          if (result.skipped === 'v11') {
            skippedV11++;
            continue;
          }
          if (result.keyError) {
            // P2-49: keep the first reason so the import can report why
            // rows are missing instead of claiming an empty success.
            keyError ??= result.keyError;
            continue;
          }
          plain = result.text ?? '';
        } catch (err) {
          keyError ??= (err as Error).message;
          continue;
        }
      }

      const host = row.host_key;
      const domain = host.startsWith('.') ? host : undefined;
      const hostOnly = host.startsWith('.') ? host.slice(1) : host;
      const secure = !!row.is_secure;
      const url = `${secure ? 'https' : 'http'}://${hostOnly}${row.path || '/'}`;
      const expirationDate = webkitToUnixSeconds(row.expires_utc);

      records.push({
        url,
        name: row.name,
        value: plain,
        domain,
        path: row.path,
        secure,
        httpOnly: !!row.is_httponly,
        expirationDate,
        sameSite: mapSameSite(row.samesite),
      });
    }

    return { records, skippedV11, keyError };
  } finally {
    // P2-45: release the handle on every path. A query throw used to skip
    // close(), leaking the handle onto the temp snapshot, which then cannot
    // be removed (EBUSY on Windows) and sits in the temp dir permanently.
    db.close();
  }
}
