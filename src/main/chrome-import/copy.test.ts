import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// P2-46 spy: wrap the fs copy primitives so every call the snapshot step
// makes is observable (the ESM namespace itself is not spy-able).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
import { snapshotProfile, sweepImportTempDirs, IMPORT_TEMP_PREFIX, IMPORT_TEMP_MAX_AGE_MS } from './copy';

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
      expect(copied).toEqual(['Cookies']);
      expect(snap.cookiesPath).toBe(path.join(snap.dir, 'Cookies'));
    } finally {
      snap.cleanup();
    }
  });

  // P2-46: the importer reads only `cookiesPath`, so the `Login Data`
  // credential DB was pure duplication — a plaintext-at-rest risk copy of
  // saved credentials into a 0755 temp dir that nothing ever opened. The
  // copy step must never touch it, not even through the EBUSY fallback.
  it('never copies the Login Data credential DB (P2-46)', () => {
    fs.writeFileSync(path.join(profileDir, 'Login Data'), 'SECRET-CREDENTIAL-MARKER');
    const copyFileSync = vi.mocked(fs.copyFileSync);
    const readFileSync = vi.mocked(fs.readFileSync);
    const writeFileSync = vi.mocked(fs.writeFileSync);
    copyFileSync.mockClear();
    readFileSync.mockClear();
    writeFileSync.mockClear();
    const snap = snapshotProfile(profileDir);
    try {
      const sources = [
        ...copyFileSync.mock.calls.map((c) => String(c[0])),
        ...readFileSync.mock.calls.map((c) => String(c[0])),
      ];
      expect(sources.some((s) => s.includes('Login Data'))).toBe(false);
      // The buffered readFileSync+writeFileSync fallback must not smuggle
      // the credential contents through either.
      expect(
        writeFileSync.mock.calls.some((c) => String(c[1]).includes('SECRET-CREDENTIAL-MARKER')),
      ).toBe(false);
      expect(snap).not.toHaveProperty('loginDataPath');
      // The cookie path is untouched: Cookies is still copied exactly once.
      expect(
        sources.filter((s) => s === path.join(profileDir, 'Cookies')),
      ).toEqual([path.join(profileDir, 'Cookies')]);
      expect(fs.readdirSync(snap.dir)).toEqual(['Cookies']);
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

// P2-47: quit/crash mid-import used to leave the cookie snapshot under
// vibeyard-chrome-import-* in the OS temp dir for the machine's life. The
// sweep mirrors the vibeyard-screenshots prune (ipc-handlers): 24h age
// bound, swallow-per-entry, directories only.
describe('sweepImportTempDirs', () => {
  let tmp: string;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function makeImportDir(name: string, ageMs: number): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Cookies'), 'fixture');
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, old, old);
    return dir;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-sweep-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('removes stale import dirs (older than the bound) and returns the count', () => {
    const stale = makeImportDir(`${IMPORT_TEMP_PREFIX}stale1`, 2 * DAY_MS);
    expect(sweepImportTempDirs({ tmpDir: tmp })).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('never removes a fresh dir (an in-flight import is not garbage)', () => {
    const fresh = makeImportDir(`${IMPORT_TEMP_PREFIX}fresh`, 0);
    expect(sweepImportTempDirs({ tmpDir: tmp })).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('maxAgeMs: 0 removes even fresh dirs (the after-import call site: the dir THIS import made)', () => {
    const fresh = makeImportDir(`${IMPORT_TEMP_PREFIX}justmade`, 0);
    expect(sweepImportTempDirs({ tmpDir: tmp, maxAgeMs: 0 })).toBe(1);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('leaves non-matching prefixes and matching files untouched', () => {
    const near = makeImportDir('vibeyard-chrome-importX-nope', 2 * DAY_MS);
    const other = makeImportDir('chrome-import-abc', 2 * DAY_MS);
    const screenshots = makeImportDir('vibeyard-screenshots', 2 * DAY_MS);
    const stray = path.join(tmp, `${IMPORT_TEMP_PREFIX}stray-file`);
    fs.writeFileSync(stray, 'fixture');
    expect(sweepImportTempDirs({ tmpDir: tmp })).toBe(0);
    expect(fs.existsSync(near)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(screenshots)).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('counts only the stale dirs in a mixed sweep', () => {
    makeImportDir(`${IMPORT_TEMP_PREFIX}s1`, 2 * DAY_MS);
    makeImportDir(`${IMPORT_TEMP_PREFIX}s2`, IMPORT_TEMP_MAX_AGE_MS + 60_000);
    const fresh = makeImportDir(`${IMPORT_TEMP_PREFIX}young`, DAY_MS - 60_000);
    expect(sweepImportTempDirs({ tmpDir: tmp })).toBe(2);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('swallows an unreadable entry, keeps sweeping, never throws', () => {
    const stale = makeImportDir(`${IMPORT_TEMP_PREFIX}stale`, 2 * DAY_MS);
    const link = path.join(tmp, `${IMPORT_TEMP_PREFIX}dangling`);
    let madeLink = true;
    try {
      // statSync on a dangling link throws ENOENT — the per-entry swallow.
      fs.symlinkSync(
        path.join(tmp, 'no-such-target'),
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      madeLink = false; // Windows without dev-mode: junction creation denied
    }
    expect(() => sweepImportTempDirs({ tmpDir: tmp })).not.toThrow();
    expect(fs.existsSync(stale)).toBe(false);
    // lstat, not existsSync: existsSync follows the dangling link and sees
    // the missing target, not the surviving entry.
    if (madeLink) expect(() => fs.lstatSync(link)).not.toThrow();
  });

  it('returns 0 on a missing tmp dir', () => {
    expect(sweepImportTempDirs({ tmpDir: path.join(tmp, 'nope') })).toBe(0);
  });

  // Producer/sweeper seam pin: snapshotProfile is the sole producer of the
  // prefix, and its real temp dir (real os.tmpdir(), no seam) is exactly
  // what the boot sweep removes once stale.
  it('sweeps a production snapshot once it is stale', () => {
    const snap = snapshotProfile(profileDir);
    try {
      expect(path.basename(snap.dir).startsWith(IMPORT_TEMP_PREFIX)).toBe(true);
      const old = new Date(Date.now() - 2 * DAY_MS);
      fs.utimesSync(snap.dir, old, old);
      expect(sweepImportTempDirs()).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(snap.dir)).toBe(false);
    } finally {
      snap.cleanup();
    }
  });
});
