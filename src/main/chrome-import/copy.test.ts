import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { snapshotProfile } from './copy';

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-copy-test-'));
  for (const fname of ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'History']) {
    fs.writeFileSync(path.join(profileDir, fname), 'fixture');
  }
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe('snapshotProfile', () => {
  // P2-44: copying the SQLite journal beside a page snapshot makes SQLite
  // treat the copy as mid-transaction; opened readonly it fails with
  // SQLITE_READONLY and the import silently yields 0 cookies. The journal
  // must not be part of the snapshot.
  it('does not copy the journal sidecars', () => {
    const snap = snapshotProfile(profileDir);
    try {
      const copied = fs.readdirSync(snap.dir).sort();
      expect(copied).toEqual(['Cookies', 'Login Data']);
      expect(snap.cookiesPath).toBe(path.join(snap.dir, 'Cookies'));
      expect(snap.loginDataPath).toBe(path.join(snap.dir, 'Login Data'));
    } finally {
      snap.cleanup();
    }
  });

  it('removes the temp dir on cleanup', () => {
    const snap = snapshotProfile(profileDir);
    snap.cleanup();
    expect(fs.existsSync(snap.dir)).toBe(false);
  });
});
