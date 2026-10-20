import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const fixture = vi.hoisted(() => ({ profileDir: '' }));

vi.mock('../platform', () => ({ isWin: false, isMac: true, isLinux: false }));
vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./paths', () => ({
  chromeUserDataDir: () => '/mock/user-data',
  chromeProfileDir: () => fixture.profileDir,
  localStatePath: (u: string) => path.posix.join(u, 'Local State'),
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({ cookies: { set: vi.fn(async () => {}) } }),
  },
}));

import { execFileSync } from 'child_process';
import { runImport } from './importer';

const mockExec = vi.mocked(execFileSync);

function listSnapshots(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('vibeyard-chrome-import-'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-import-profile-'));
  const db = new Database(path.join(fixture.profileDir, 'Cookies'));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta VALUES('version', '24')").run();
  db.exec(
    'CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)',
  );
  db.prepare('INSERT INTO cookies VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '.example.com', 'sid', Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 7)]), '', '/', 0, 1, 0, 1,
  );
  db.close();
});

afterEach(() => {
  fs.rmSync(fixture.profileDir, { recursive: true, force: true });
});

describe('runImport', () => {
  // P2-49: keychain denial used to yield {ok:true, cookieCount:0, errors:[]}
  // and was persisted as a completed import.
  it('reports failure with the keychain denial reason (not ok:true)', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('access denied');
    });
    const onProgress = vi.fn();
    const result = await runImport({ profileId: 'Default' }, onProgress);
    expect(result.ok).toBe(false);
    expect(result.cookieCount).toBe(0);
    expect(result.errors.join(' ')).toMatch(/keychain/i);
  });

  // P2-48: a hung keychain prompt (execFileSync timeout) must map to the
  // same honest failure shape, not a crash and not a fake success.
  it('maps a keychain timeout to a failed import with the timeout reason', async () => {
    const timeoutErr = Object.assign(new Error('spawnSync /usr/bin/security ETIMEDOUT'), { code: 'ETIMEDOUT' });
    mockExec.mockImplementation(() => {
      throw timeoutErr;
    });
    const result = await runImport({ profileId: 'Default' }, vi.fn());
    expect(result.ok).toBe(false);
    expect(result.cookieCount).toBe(0);
    expect(result.errors.join(' ')).toMatch(/timed out/i);
  });

  it('sweeps the snapshot temp dir when decryption fails', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('access denied');
    });
    const before = listSnapshots();
    await runImport({ profileId: 'Default' }, vi.fn());
    const after = listSnapshots();
    expect(after.filter((d) => !before.includes(d))).toEqual([]);
  });
});
