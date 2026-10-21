import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('os', () => ({
  homedir: () => '/Users/test',
}));

vi.mock('../platform', () => ({
  isWin: false,
}));

const mockFileExists = vi.fn();
const mockDirExists = vi.fn();
const mockReadDirSafe = vi.fn();
const mockReadFileSafe = vi.fn();

vi.mock('../fs-utils', () => ({
  fileExists: (p: string) => mockFileExists(p),
  dirExists: (p: string) => mockDirExists(p),
  readDirSafe: (p: string) => mockReadDirSafe(p),
  readFileSafe: (p: string) => mockReadFileSafe(p),
}));

import { findBinaryInNvm, nvmDefaultNodeBinDir } from './nvm';

const defaultNvmDir = '/Users/test/.nvm';
const defaultVersionsDir = path.join(defaultNvmDir, 'versions', 'node');

beforeEach(() => {
  delete process.env.NVM_DIR;
  mockFileExists.mockReset().mockReturnValue(false);
  mockDirExists.mockReset().mockReturnValue(false);
  mockReadDirSafe.mockReset().mockReturnValue([]);
  mockReadFileSafe.mockReset().mockReturnValue(null);
});

afterEach(() => {
  delete process.env.NVM_DIR;
});

describe('findBinaryInNvm', () => {
  it('returns null when nvm versions dir does not exist', () => {
    mockDirExists.mockReturnValue(false);
    expect(findBinaryInNvm('claude')).toBeNull();
  });

  it('finds binary under the default version when alias/default is set', () => {
    const version = 'v24.11.1';
    const expected = path.join(defaultVersionsDir, version, 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(defaultNvmDir, 'alias', 'default') ? `${version}\n` : null,
    );
    mockFileExists.mockImplementation((p) => p === expected);

    expect(findBinaryInNvm('claude')).toBe(expected);
  });

  it('iterates versions when alias/default is missing', () => {
    const expected = path.join(defaultVersionsDir, 'v22.0.0', 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockReturnValue(null);
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v20.0.0', 'v22.0.0', 'v24.0.0'] : [],
    );
    mockFileExists.mockImplementation((p) => p === expected);

    expect(findBinaryInNvm('claude')).toBe(expected);
  });

  it('falls through to iteration when alias/default names a version without the binary', () => {
    const fallbackVersion = 'v22.0.0';
    const expected = path.join(defaultVersionsDir, fallbackVersion, 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(defaultNvmDir, 'alias', 'default') ? 'v24.11.1\n' : null,
    );
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v24.11.1', fallbackVersion] : [],
    );
    mockFileExists.mockImplementation((p) => p === expected);

    expect(findBinaryInNvm('claude')).toBe(expected);
  });

  it('respects the NVM_DIR env override', () => {
    const customDir = '/opt/nvm';
    const customVersionsDir = path.join(customDir, 'versions', 'node');
    const expected = path.join(customVersionsDir, 'v24.11.1', 'bin', 'claude');
    process.env.NVM_DIR = customDir;
    mockDirExists.mockImplementation((p) => p === customVersionsDir);
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(customDir, 'alias', 'default') ? 'v24.11.1' : null,
    );
    mockFileExists.mockImplementation((p) => p === expected);

    expect(findBinaryInNvm('claude')).toBe(expected);
  });

  it('returns null when no version contains the binary', () => {
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v22.0.0'] : [],
    );
    mockFileExists.mockReturnValue(false);

    expect(findBinaryInNvm('claude')).toBeNull();
  });

  // P2-27: `alias/default` often stores an ALIAS ('lts/*', 'lts/iron'),
  // not a version. Read raw it yields versions/node/lts/* — a path that
  // can never exist — and selection silently fell to raw readdir order,
  // i.e. the oldest installed version.
  it('follows alias/default → lts/* → alias/lts/* to the newest LTS', () => {
    const iron = path.join(defaultVersionsDir, 'v22.14.0', 'bin', 'claude');
    const hydrogen = path.join(defaultVersionsDir, 'v18.20.4', 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockImplementation((p) => {
      if (p === path.join(defaultNvmDir, 'alias', 'default')) return 'lts/*\n';
      if (p === path.join(defaultNvmDir, 'alias', 'lts', 'hydrogen')) return 'v18.20.4\n';
      if (p === path.join(defaultNvmDir, 'alias', 'lts', 'iron')) return 'v22.14.0\n';
      return null;
    });
    mockReadDirSafe.mockImplementation((p) => {
      if (p === path.join(defaultNvmDir, 'alias', 'lts')) return ['hydrogen', 'iron'];
      if (p === defaultVersionsDir) return ['v18.20.4', 'v22.14.0'];
      return [];
    });
    // Both versions carry the binary — the old raw-readdir order picked
    // v18.20.4 (oldest installed), not the LTS the default alias points at.
    mockFileExists.mockImplementation((p) => p === iron || p === hydrogen);

    expect(findBinaryInNvm('claude')).toBe(iron);
  });

  it('follows alias/default → lts/<codename> to its aliased version', () => {
    const iron = path.join(defaultVersionsDir, 'v22.14.0', 'bin', 'claude');
    const older = path.join(defaultVersionsDir, 'v20.0.0', 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockImplementation((p) => {
      if (p === path.join(defaultNvmDir, 'alias', 'default')) return 'lts/iron\n';
      if (p === path.join(defaultNvmDir, 'alias', 'lts', 'iron')) return 'v22.14.0\n';
      return null;
    });
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v20.0.0', 'v22.14.0'] : [],
    );
    mockFileExists.mockImplementation((p) => p === iron || p === older);

    expect(findBinaryInNvm('claude')).toBe(iron);
  });

  it('falls back to the newest installed version when the chain names an uninstalled version', () => {
    // alias/default = a concrete version that is NOT installed; the scan
    // must prefer the NEWEST installed (v20), not readdir order (v9 first).
    const expected = path.join(defaultVersionsDir, 'v20.0.0', 'bin', 'claude');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir);
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(defaultNvmDir, 'alias', 'default') ? 'v24.11.1\n' : null,
    );
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v9.0.0', 'v20.0.0', 'v12.0.0'] : [],
    );
    mockFileExists.mockImplementation((p) => p === expected);

    expect(findBinaryInNvm('claude')).toBe(expected);
  });
});

describe('nvmDefaultNodeBinDir', () => {
  it('returns null when nvm versions dir does not exist', () => {
    expect(nvmDefaultNodeBinDir()).toBeNull();
  });

  it('prefers the default version bin dir', () => {
    const version = 'v24.11.1';
    const expected = path.join(defaultVersionsDir, version, 'bin');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir || p === expected);
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(defaultNvmDir, 'alias', 'default') ? version : null,
    );

    expect(nvmDefaultNodeBinDir()).toBe(expected);
  });

  it('falls back to the first version dir when no default is set', () => {
    const expected = path.join(defaultVersionsDir, 'v22.0.0', 'bin');
    mockDirExists.mockImplementation((p) => p === defaultVersionsDir || p === expected);
    mockReadFileSafe.mockReturnValue(null);
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v22.0.0', 'v24.0.0'] : [],
    );

    expect(nvmDefaultNodeBinDir()).toBe(expected);
  });

  it('falls back to the newest installed version when the alias chain breaks', () => {
    // P2-27: alias/default names a codename with no alias file. The old
    // code yielded versions/node/lts/ghost — never a real dir — then the
    // scan fell to raw readdir order (v9 first). The chain-break fallback
    // must name the NEWEST installed version.
    const expected = path.join(defaultVersionsDir, 'v20.0.0', 'bin');
    mockDirExists.mockImplementation(
      (p) => p === defaultVersionsDir || String(p).endsWith(`${path.sep}bin`),
    );
    mockReadFileSafe.mockImplementation((p) =>
      p === path.join(defaultNvmDir, 'alias', 'default') ? 'lts/ghost\n' : null,
    );
    mockReadDirSafe.mockImplementation((p) =>
      p === defaultVersionsDir ? ['v9.0.0', 'v20.0.0', 'v12.0.0'] : [],
    );

    expect(nvmDefaultNodeBinDir()).toBe(expected);
  });
});
