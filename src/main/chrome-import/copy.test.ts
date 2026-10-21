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
