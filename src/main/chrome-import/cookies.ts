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
}

/** Reads cookies from a snapshotted Cookies SQLite DB and returns Electron-ready records. */
export function readCookies(cookiesDbPath: string): CookieReadResult {
  const db = new Database(cookiesDbPath, { readonly: true, fileMustExist: true });
  let hasDomainHash = false;
  try {
    const meta = db.prepare("SELECT value FROM meta WHERE key='version'").get() as { value?: string } | undefined;
    const version = meta?.value ? parseInt(meta.value, 10) : 0;
    if (version >= 24) hasDomainHash = true;
  } catch {
    // ignore
  }

  const rows = db.prepare(
    'SELECT host_key, name, encrypted_value, value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies',
  ).all() as CookieRow[];

  const records: CookiesSetDetails[] = [];
  let skippedV11 = 0;

  for (const row of rows) {
    let plain = row.value;
    if (!plain && row.encrypted_value && row.encrypted_value.length > 0) {
      try {
        const result = decryptChromeValue(row.encrypted_value, hasDomainHash);
        if (result.skipped === 'v11') {
          skippedV11++;
          continue;
        }
        plain = result.text ?? '';
      } catch {
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

  db.close();
  return { records, skippedV11 };
}
