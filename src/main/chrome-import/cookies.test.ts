import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

// P2-49 honesty fixture: the macOS keychain path is driven by a
// child_process stub — denial/timeout must surface as a keyError on the
// read result, not be swallowed per row.
vi.mock('../platform', () => ({ isWin: false, isMac: true, isLinux: false }));
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('access denied');
  }),
}));

import { execFileSync } from 'child_process';
import { readCookies } from './cookies';

const mockExec = vi.mocked(execFileSync);

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  mockExec.mockImplementation(() => {
    throw new Error('access denied');
  });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-cookies-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCookiesDb(file: string, opts: { withCookiesTable?: boolean } = {}): string {
  const db = new Database(file);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta VALUES('version', '24')").run();
  if (opts.withCookiesTable !== false) {
    db.exec(
      'CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)',
    );
  }
  db.close();
  return file;
}

function insertCookie(file: string, row: { host_key: string; name: string; encrypted_value: Buffer; value: string }): void {
  const db = new Database(file);
  db.prepare('INSERT INTO cookies VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    row.host_key, row.name, row.encrypted_value, row.value, '/', 0, 1, 0, 1,
  );
  db.close();
}

// CI's `npm ci` builds better-sqlite3 for the Electron ABI (the app packages
// against Electron); vitest on plain Node cannot load that binding there.
// These tests need the real binding, so skip the suite when it does not load.
const sqliteUsable = (() => {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(sqliteUsable)('readCookies', () => {
  it('reads plaintext cookie rows from a snapshot opened read-write', () => {
    const file = makeCookiesDb(path.join(tmpDir, 'Cookies'));
    insertCookie(file, { host_key: '.example.com', name: 'sid', encrypted_value: Buffer.alloc(0), value: 'plain-value' });

    const result = readCookies(file);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.name).toBe('sid');
    expect(result.records[0]!.value).toBe('plain-value');
    expect(result.records[0]!.domain).toBe('.example.com');
    expect(result.keyError).toBeNull();
  });

  // P2-45: `db.close()` used to sit outside the try. A query throw leaked the
  // handle, so the temp snapshot could not be removed (EBUSY on Windows).
  it('releases the handle when a query throws', () => {
    const file = makeCookiesDb(path.join(tmpDir, 'Cookies'), { withCookiesTable: false });
    expect(() => readCookies(file)).toThrow(/no such table/i);
    // The snapshot dir must be removable right after the throw: on Windows
    // this fails while the leaked handle keeps the file open.
    expect(() => fs.rmSync(tmpDir, { recursive: true, force: true })).not.toThrow();
    expect(fs.existsSync(tmpDir)).toBe(false);
  });

  // P2-49: a keychain denial must be reported on the result, not swallowed
  // row-by-row so the import can claim `{ok: true, cookieCount: 0}`.
  it('surfaces a keychain denial as keyError instead of skipping rows silently', () => {
    const file = makeCookiesDb(path.join(tmpDir, 'Cookies'));
    insertCookie(file, { host_key: '.example.com', name: 'sid', encrypted_value: Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 7)]), value: '' });

    const result = readCookies(file);
    expect(result.records).toHaveLength(0);
    expect(result.keyError).toMatch(/keychain/i);
  });
});
