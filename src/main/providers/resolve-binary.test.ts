import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const mockExecSync = vi.fn();
const mockExecFile = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  // PA-01 async probes go through promisify(execFile).
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\test',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  // PA-01 disk tier: async stat + cache-file read/write.
  promises: {
    stat: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    writeFile: vi.fn(() => Promise.resolve()),
  },
}));

// Mock platform as Windows for these tests
vi.mock('../platform', () => ({
  isWin: true,
  pathSep: ';',
  whichCmd: 'where',
}));

// Mock pty-manager to avoid its module-level side effects
vi.mock('../pty-manager', () => ({
  getFullPath: () => 'C:\\Windows\\system32;C:\\Users\\test\\AppData\\Roaming\\npm',
  getFullPathAsync: () => Promise.resolve('C:\\Windows\\system32;C:\\Users\\test\\AppData\\Roaming\\npm'),
}));

import * as fs from 'fs';
import { resolveBinary, validateBinaryExists, invalidateBinaryCache, validateBinaryExistsAsync, configureProbeCacheDir } from './resolve-binary';

const mockStatSync = vi.mocked(fs.statSync);
const mockStatAsync = vi.mocked(fs.promises.stat);
const mockReadFile = vi.mocked(fs.promises.readFile);
const mockWriteFile = vi.mocked(fs.promises.writeFile);

const fileStat = { isFile: () => true } as fs.Stats;

// Must match the mocked getFullPath() above (P2-26 cache validation key).
const MOCKED_PATH = 'C:\\Windows\\system32;C:\\Users\\test\\AppData\\Roaming\\npm';

// Let queued microtasks (the coalesced disk-cache write) land.
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  mockExecSync.mockImplementation(() => { throw new Error('not found'); });
  mockExecFile.mockImplementation(() => { throw new Error('not found'); });
  mockStatAsync.mockImplementation(() => Promise.reject(new Error('ENOENT')));
  mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
  mockWriteFile.mockImplementation(() => Promise.resolve());
  // Disk tier OFF by default: the suites above pin the in-process behavior.
  configureProbeCacheDir(null);
  invalidateBinaryCache();
});

describe('resolveBinary (Windows)', () => {
  it('checks expanded candidate dirs including scoop shims', () => {
    const scoopPath = path.join('C:\\Users\\test', 'scoop', 'shims', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === scoopPath) return fileStat;
      throw new Error('ENOENT');
    });

    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(scoopPath);
    expect(cache.path).toBe(scoopPath);
  });

  it('checks volta bin directory', () => {
    const voltaPath = path.join('C:\\Users\\test', '.volta', 'bin', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === voltaPath) return fileStat;
      throw new Error('ENOENT');
    });

    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(voltaPath);
  });

  it('checks standalone installer subdirectory', () => {
    const standalonePath = path.join('C:\\Users\\test', 'AppData', 'Local', 'Programs', 'claude', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === standalonePath) return fileStat;
      throw new Error('ENOENT');
    });

    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(standalonePath);
  });

  it('checks chocolatey bin directory', () => {
    const chocoPath = path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === chocoPath) return fileStat;
      throw new Error('ENOENT');
    });

    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(chocoPath);
  });

  it('falls back to npm prefix -g discovery', () => {
    const customPrefix = 'D:\\custom-npm';
    const customPath = path.join(customPrefix, 'claude.cmd');

    // All static candidates fail, where fails
    mockStatSync.mockImplementation((p) => {
      if (String(p) === customPath) return fileStat;
      throw new Error('ENOENT');
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('npm prefix')) return `${customPrefix}\n`;
      throw new Error('not found');
    });

    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(customPath);
  });

  it('returns bare binary name when all methods fail', () => {
    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe('claude');
  });

  it('uses a cache entry while the binary exists and PATH is unchanged', () => {
    const cached = 'C:\\cached\\claude.cmd';
    mockStatSync.mockImplementation((p) => {
      if (String(p) === cached) return fileStat;
      throw new Error('ENOENT');
    });
    const cache = { path: cached, pathEnv: MOCKED_PATH };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(cached);
    // Cache validation is a single stat — no PATH/dir/nvm re-probes.
    expect(mockStatSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // P2-26: a stale shim permanently shadowed the PATH binary — the cache
  // must re-resolve when the cached file disappears or PATH changes.
  it('re-resolves when the cached binary disappears', () => {
    // statSync default: everything ENOENT, including the cached path.
    const cache = { path: 'C:\\cached\\claude.cmd', pathEnv: MOCKED_PATH };
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('where')) return 'C:\\bin\\claude.cmd\n';
      throw new Error('not found');
    });
    const result = resolveBinary('claude', cache);

    expect(result).toBe('C:\\bin\\claude.cmd');
    expect(cache.path).toBe('C:\\bin\\claude.cmd');
  });

  it('re-resolves when PATH changed since the cache was filled', () => {
    const scoopPath = path.join('C:\\Users\\test', 'scoop', 'shims', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === scoopPath) return fileStat;
      throw new Error('ENOENT');
    });
    const cache = { path: 'C:\\cached\\claude.cmd', pathEnv: 'D:\\old-path' };
    const result = resolveBinary('claude', cache);

    expect(result).toBe(scoopPath);
    expect(cache.pathEnv).toBe(MOCKED_PATH);
  });

  // P2-26: user PATH wins over common-dir shims. A scoop shim earlier in
  // the search dirs must NOT shadow the binary PATH points at.
  it('prefers the user PATH winner over a shim in a common dir', () => {
    const scoopPath = path.join('C:\\Users\\test', 'scoop', 'shims', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === scoopPath) return fileStat;
      throw new Error('ENOENT');
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('where')) return 'D:\\tools\\claude.cmd\n';
      throw new Error('not found');
    });
    const cache = { path: null as string | null };
    const result = resolveBinary('claude', cache);

    expect(result).toBe('D:\\tools\\claude.cmd');
    // The PATH probe runs before any common-dir stat.
    expect(mockStatSync).not.toHaveBeenCalled();
  });
});

describe('validateBinaryExists (Windows)', () => {
  it('returns ok when found in expanded candidate dirs', () => {
    const scoopPath = path.join('C:\\Users\\test', 'scoop', 'shims', 'claude.cmd');
    mockStatSync.mockImplementation((p) => {
      if (String(p) === scoopPath) return fileStat;
      throw new Error('ENOENT');
    });

    expect(validateBinaryExists('claude')).toBe(true);
  });

  it('returns ok when npm prefix -g finds the binary', () => {
    const customPrefix = 'D:\\custom-npm';
    const customPath = path.join(customPrefix, 'claude.cmd');

    mockStatSync.mockImplementation((p) => {
      if (String(p) === customPath) return fileStat;
      throw new Error('ENOENT');
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('npm prefix')) return `${customPrefix}\n`;
      throw new Error('not found');
    });

    expect(validateBinaryExists('claude')).toBe(true);
  });

  it('returns false when all methods fail', () => {
    expect(validateBinaryExists('claude')).toBe(false);
  });

  it('caches positive results: the second call spawns no probes', () => {
    // Resolve via `where` (subprocess) so the probe count is meaningful.
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('where')) return 'C:\\bin\\claude.cmd\n';
      throw new Error('not found');
    });

    expect(validateBinaryExists('claude')).toBe(true);
    const probesAfterFirst = mockExecSync.mock.calls.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    // Any probe on a cache hit throws: bin dirs, nvm, which and npm prefix
    // must all stay untouched on the second call (audit P3-5).
    mockExecSync.mockImplementation(() => { throw new Error('SUBPROCESS ON CACHE HIT'); });
    mockStatSync.mockImplementation(() => { throw new Error('FS PROBE ON CACHE HIT'); });

    expect(validateBinaryExists('claude')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(probesAfterFirst);
  });

  it('caches negative results for the TTL and re-probes after it expires', () => {
    vi.useFakeTimers();
    try {
      expect(validateBinaryExists('claude')).toBe(false);
      const probesAfterFirst = mockExecSync.mock.calls.length;
      expect(probesAfterFirst).toBeGreaterThan(0);

      expect(validateBinaryExists('claude')).toBe(false);
      expect(mockExecSync).toHaveBeenCalledTimes(probesAfterFirst);

      vi.setSystemTime(Date.now() + 31_000);
      expect(validateBinaryExists('claude')).toBe(false);
      expect(mockExecSync.mock.calls.length).toBeGreaterThan(probesAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidateBinaryCache clears the entry for one binary', () => {
    expect(validateBinaryExists('claude')).toBe(false);
    const probesAfterFirst = mockExecSync.mock.calls.length;

    invalidateBinaryCache('gemini');
    expect(validateBinaryExists('claude')).toBe(false);
    expect(mockExecSync).toHaveBeenCalledTimes(probesAfterFirst);

    invalidateBinaryCache('claude');
    expect(validateBinaryExists('claude')).toBe(false);
    expect(mockExecSync.mock.calls.length).toBeGreaterThan(probesAfterFirst);
  });
});

describe('validateBinaryExistsAsync — PA-01 cross-launch disk cache', () => {
  const CACHE_FILE = path.join('C:\\mock\\userData', 'binary-probe-cache.json');
  const scoopPath = path.join('C:\\Users\\test', 'scoop', 'shims', 'claude.cmd');

  function seedDiskCache(entry: Record<string, unknown>) {
    mockReadFile.mockImplementation((p) => {
      if (String(p) === CACHE_FILE) {
        return Promise.resolve(JSON.stringify({ claude: entry }) as unknown as never);
      }
      return Promise.reject(new Error('ENOENT'));
    });
  }

  beforeEach(() => {
    configureProbeCacheDir('C:\\mock\\userData');
  });

  it('trusts a fresh positive entry: availability without any probe', async () => {
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });
    mockStatAsync.mockImplementation((p) => (
      String(p) === scoopPath
        ? Promise.resolve({ mtimeMs: 1000, isFile: () => true } as never)
        : Promise.reject(new Error('ENOENT'))
    ));

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    // A trusted entry is not rewritten — no disk churn per launch.
    await flushAsync();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('invalidates per-entry when the binary mtime changed: full re-probe + persist', async () => {
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });
    // The CLI updated under the same path: mtime moved.
    mockStatAsync.mockImplementation((p) => (
      String(p) === scoopPath
        ? Promise.resolve({ mtimeMs: 2000, isFile: () => true } as never)
        : Promise.reject(new Error('ENOENT'))
    ));

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(true);
    await flushAsync();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(persisted.claude).toMatchObject({ exists: true, path: scoopPath, mtimeMs: 2000 });
  });

  it('invalidates per-entry when the recorded binary vanished: re-probe finds it missing', async () => {
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });
    // statSync-based nvm/common-dir probes and async stats all ENOENT: the
    // binary is gone.
    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(false);
    await flushAsync();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(String(mockWriteFile.mock.calls[0][1]));
    expect(persisted.claude).toMatchObject({ exists: false, path: null });
  });

  it('trusts a fresh negative entry inside the TTL — no probe, no re-stat', async () => {
    seedDiskCache({
      exists: false, path: null, mtimeMs: null, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(false);
    expect(mockStatAsync).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('re-probes when the PATH moved since the entry was written', async () => {
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: 'D:\\stale-path', checkedAt: Date.now(),
    });
    // Async probe: `where` (execFile) resolves the binary on the live PATH.
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown, out?: { stdout: string }) => void;
      cb(null, { stdout: 'D:\\tools\\claude.cmd\n' });
    });

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('stays entirely in-process when no cache dir is configured', async () => {
    configureProbeCacheDir(null);

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(false);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('invalidateBinaryCache clears the loaded disk entry and persists the drop', async () => {
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });
    mockStatAsync.mockImplementation((p) => (
      String(p) === scoopPath
        ? Promise.resolve({ mtimeMs: 1000, isFile: () => true } as never)
        : Promise.reject(new Error('ENOENT'))
    ));
    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(true);

    invalidateBinaryCache('claude');
    // The invalidation scenario is an uninstall: the phase-1 stat mock
    // (scoopPath fresh) is also what the re-probe's async dir walk reads,
    // so it must go ENOENT here — otherwise the probe legitimately
    // re-finds the binary the test just invalidated.
    mockStatAsync.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));
    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(false);
    await flushAsync();
    const persisted = JSON.parse(String(mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1][1]));
    expect(persisted.claude).toMatchObject({ exists: false });
  });

  it('boot-time invalidation before the first probe must not wipe the cache file', async () => {
    // registry.initProviders → invalidateAvailabilityCache lands on
    // invalidateBinaryCache() BEFORE any probe loaded the file. Clearing an
    // unloaded map must not delete the on-disk entries — persistence
    // depends on exactly this.
    seedDiskCache({
      exists: true, path: scoopPath, mtimeMs: 1000, pathEnv: MOCKED_PATH, checkedAt: Date.now(),
    });
    invalidateBinaryCache();
    mockStatAsync.mockImplementation((p) => (
      String(p) === scoopPath
        ? Promise.resolve({ mtimeMs: 1000, isFile: () => true } as never)
        : Promise.reject(new Error('ENOENT'))
    ));

    await expect(validateBinaryExistsAsync('claude')).resolves.toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
