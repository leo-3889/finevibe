import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\test',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
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
}));

import * as fs from 'fs';
import { resolveBinary, validateBinaryExists, invalidateBinaryCache } from './resolve-binary';

const mockStatSync = vi.mocked(fs.statSync);

const fileStat = { isFile: () => true } as fs.Stats;

// Must match the mocked getFullPath() above (P2-26 cache validation key).
const MOCKED_PATH = 'C:\\Windows\\system32;C:\\Users\\test\\AppData\\Roaming\\npm';

beforeEach(() => {
  vi.clearAllMocks();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  mockExecSync.mockImplementation(() => { throw new Error('not found'); });
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
