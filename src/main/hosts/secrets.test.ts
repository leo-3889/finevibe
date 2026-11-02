import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock electron: safeStorage with a reversible "encryption" (base64 of a
// prefix) + availability toggles; app.getPath unused thanks to the file seam.
let available = true;
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const t = b.toString('utf8');
      if (!t.startsWith('enc:')) throw new Error('bad ciphertext');
      return t.slice(4);
    },
  },
}));

import {
  MAX_CACHED_SECRETS,
  SECRET_PROBE_RETRY_MS,
  deleteHostSecret,
  getHostSecret,
  secretsAvailable,
  setHostSecret,
  setSecretsAvailableForTests,
  setSecretsFileForTests,
} from './secrets';

let file = '';

beforeEach(() => {
  available = true;
  setSecretsAvailableForTests(null); // re-probe the mock
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hostsecrets-')), 'host-secrets.json');
  setSecretsFileForTests(file);
});

afterEach(() => {
  setSecretsFileForTests(null);
  setSecretsAvailableForTests(null);
});

describe('secretsAvailable', () => {
  it('mirrors safeStorage availability', () => {
    expect(secretsAvailable()).toBe(true);
    available = false;
    setSecretsAvailableForTests(null);
    expect(secretsAvailable()).toBe(false);
  });

  // Row 100: a keyring that comes up after boot (D-Bus / secret service started
  // late) used to stay invisible for the whole process, because the first
  // `false` was cached forever.
  it('re-probes a failed check once the retry window passes', () => {
    vi.useFakeTimers();
    try {
      available = false;
      setSecretsAvailableForTests(null);
      expect(secretsAvailable()).toBe(false);
      available = true;
      // Inside the window the cached negative still serves (no per-call probe).
      vi.advanceTimersByTime(SECRET_PROBE_RETRY_MS - 1);
      expect(secretsAvailable()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(secretsAvailable()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps caching a successful check (a working keyring is not re-probed)', () => {
    expect(secretsAvailable()).toBe(true);
    available = false;
    expect(secretsAvailable()).toBe(true);
  });
});

describe('set/get/delete host secret', () => {
  it('round-trips a password through encrypted storage', () => {
    setHostSecret('host-1', 's3cret');
    expect(getHostSecret('host-1')).toBe('s3cret');
    deleteHostSecret('host-1');
    expect(getHostSecret('host-1')).toBeNull();
  });

  it('never writes plaintext to disk', () => {
    setHostSecret('host-1', 's3cret');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('s3cret');
    expect(raw).toContain('host-1');
  });

  it('returns null for unknown ids', () => {
    expect(getHostSecret('nope')).toBeNull();
  });

  it('blocks set when storage is unavailable (R1: no plaintext fallback)', () => {
    available = false;
    setSecretsAvailableForTests(false);
    expect(() => setHostSecret('host-1', 's3cret')).toThrow(/secure storage unavailable/);
    expect(fs.existsSync(file)).toBe(false);
    expect(getHostSecret('host-1')).toBeNull();
  });

  it('survives a reload (cache reads from disk)', () => {
    setHostSecret('host-1', 'pw');
    setSecretsFileForTests(file); // reset the cache, keep the file
    expect(getHostSecret('host-1')).toBe('pw');
  });

  // Row 46: the cache is capped (LRU) so it cannot grow with every host ever
  // enrolled. That is only safe because every mutation is a read-modify-write
  // of the FILE — a naive "write the whole cache back" would silently drop the
  // evicted hosts' ciphertext on the next set.
  it('keeps every secret intact past the cache cap', () => {
    const ids = Array.from({ length: MAX_CACHED_SECRETS + 4 }, (_, i) => `host-${i}`);
    for (const id of ids) setHostSecret(id, `pw-${id}`);
    for (const id of ids) expect(getHostSecret(id)).toBe(`pw-${id}`);
    setHostSecret('one-more', 'pw-one-more');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual([...ids, 'one-more'].sort());
  });

  // Row 100: deleting never decrypts, so the availability gate only orphaned
  // the ciphertext of a host whose secret could not be dropped.
  it('deletes the file entry while storage is unavailable', () => {
    setHostSecret('host-1', 'pw');
    available = false;
    setSecretsAvailableForTests(false);
    deleteHostSecret('host-1');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('delete of an unknown id leaves the file untouched', () => {
    setHostSecret('host-1', 'pw');
    deleteHostSecret('ghost');
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)).toEqual(['host-1']);
  });
});
