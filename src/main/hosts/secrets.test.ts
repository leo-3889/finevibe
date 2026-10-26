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
});
