import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const fixture = vi.hoisted(() => ({ profileDir: '', isMac: true }));

// Getter mock (prompt-utils.test.ts pattern): decrypt.ts reads `isMac` at
// call time, so the P2-49 Linux tests flip the platform in-process.
vi.mock('../platform', () => ({
  get isMac() { return fixture.isMac; },
  get isWin() { return false; },
  get isLinux() { return !fixture.isMac; },
}));
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
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('finevibe-chrome-import-'));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.isMac = true;
  fixture.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-import-profile-'));
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

// CI's `npm ci` builds better-sqlite3 for the Electron ABI (the app packages
// against Electron); vitest on plain Node cannot load that binding there.
// These tests build a real Cookies fixture, so skip the suite when the
// binding does not load (the root hooks touch it too).
const sqliteUsable = (() => {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(sqliteUsable)('runImport', () => {
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

  // P2-49 (Linux): secret-tool missing → keyring diagnosis + `peanuts`
  // fallback. The fixture row is encrypted with a keyring key, so the
  // fallback decrypt throws `bad decrypt` and nothing imports.
  function mockSecretToolMissing(): void {
    fixture.isMac = false;
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    });
  }

  it('Linux zero cookies: keyring + bad decrypt stays a hard error', async () => {
    mockSecretToolMissing();
    const result = await runImport({ profileId: 'Default' }, vi.fn());
    expect(result.ok).toBe(false);
    expect(result.cookieCount).toBe(0);
    expect(result.errors.join(' ')).toMatch(/keyring/i);
    expect(result.errors.join(' ')).toMatch(/bad decrypt/i);
    expect(result.warnings ?? []).toEqual([]);
  });

  // P2-49: once cookies land, the key problem must surface as a warning —
  // the old gate returned ok:false on the peanuts-legacy success path.
  it('Linux partial import: keyError is a warning, not a failure', async () => {
    mockSecretToolMissing();
    // A plaintext-value row needs no decryption, so it imports while the
    // encrypted fixture row keeps reporting the keyring problem.
    const db = new Database(path.join(fixture.profileDir, 'Cookies'));
    db.prepare('INSERT INTO cookies VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '.ok.example', 'plain', Buffer.alloc(0), 'plain-value', '/', 0, 1, 0, 1,
    );
    db.close();
    const result = await runImport({ profileId: 'Default' }, vi.fn());
    expect(result.ok).toBe(true);
    expect(result.cookieCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect((result.warnings ?? []).join(' ')).toMatch(/keyring/i);
  });
});
