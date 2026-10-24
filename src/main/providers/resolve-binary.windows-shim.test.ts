import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F3: the composed Windows spawn contract for npm-style CLIs.
 *
 * `where pi-bolt` resolves the extensionless npm launcher (the shim npm
 * installs next to `pi-bolt.cmd`), and `resolveBinary` returns that FIRST
 * line verbatim. The pty spawn is only spawnable because pty-manager's
 * `resolveWindowsShell` wraps extensionless targets in `cmd.exe /c`, where
 * PATHEXT then picks the `.cmd`. Each half is pinned in isolation elsewhere
 * (resolve-binary.test.ts uses .cmd fixtures; pty-manager.test.ts pins the
 * wrapping); this file pins the CHAIN: shim out of resolveBinary → cmd.exe
 * target out of resolveWindowsShell.
 *
 * Mock style mirrors resolve-binary.test.ts; the pty-manager mock is the
 * real module with only the PATH probes overridden, so the test exercises
 * the real resolveWindowsShell. The heavy pty-manager import graph is
 * stubbed the way pty-manager.test.ts stubs it.
 */

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: vi.fn(() => { throw new Error('not found'); }),
}));

vi.mock('os', () => ({
  homedir: () => 'C:\\Users\\test',
  tmpdir: () => 'C:\\tmp',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readdirSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readlinkSync: vi.fn(() => { throw new Error('ENOENT'); }),
  promises: {
    stat: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    writeFile: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('node-pty', () => ({
  default: { spawn: vi.fn() },
  spawn: vi.fn(),
}));

// pty-manager's imports (via the providers registry) that this test must not
// load for real — same stub set pty-manager.test.ts uses for module loading.
vi.mock('./nvm', () => ({
  nvmDefaultNodeBinDir: () => null,
  findBinaryInNvm: () => null,
}));
vi.mock('../claude-keychain', () => ({
  getKeychainIsolationStatus: () => ({ status: 'supported', version: null }),
}));
vi.mock('../settings-guard', () => ({
  guardedProfileInstall: vi.fn(),
  guardedInstall: vi.fn(),
  validateSettings: () => ({}),
  reinstallSettings: vi.fn(),
  shouldWarnStatusLine: () => false,
}));

// Pin the platform to Windows (deterministic on any dev machine/CI).
vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return { ...actual, isWin: true, pathSep: ';', whichCmd: 'where' };
});

const MOCKED_PATH = 'C:\\Windows\\system32;C:\\Users\\test\\AppData\\Roaming\\npm';

// The real pty-manager (for resolveWindowsShell) with only the PATH probes pinned.
vi.mock('../pty-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pty-manager')>();
  return {
    ...actual,
    getFullPath: () => MOCKED_PATH,
    getFullPathAsync: () => Promise.resolve(MOCKED_PATH),
  };
});

import { resolveBinary } from './resolve-binary';
import { resolveWindowsShell } from '../pty-manager';

// The extensionless npm launcher `where` lists first, with the .cmd beside it.
const SHIM = 'C:\\Users\\test\\AppData\\Roaming\\npm\\pi-bolt';
const WHERE_OUTPUT = `${SHIM}\n${SHIM}.cmd\r\n`;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSync.mockImplementation(() => { throw new Error('not found'); });
});

describe('extensionless npm shim → cmd.exe spawn chain (Windows)', () => {
  it('resolveBinary returns the extensionless first line `where` prints', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('where "pi-bolt"')) return WHERE_OUTPUT;
      throw new Error('not found');
    });

    const cache = { path: null as string | null };
    expect(resolveBinary('pi-bolt', cache)).toBe(SHIM);
    expect(cache.path).toBe(SHIM);
    // PATH wins (P2-26): the first line is returned as-is, no .cmd
    // substitution and no common-dir scan behind `where`.
    expect(mockExecSync.mock.calls.length).toBe(1);
  });

  it('the resolved shim spawns through resolveWindowsShell as cmd.exe /c <shim>', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('where "pi-bolt"')) return WHERE_OUTPUT;
      throw new Error('not found');
    });

    const shim = resolveBinary('pi-bolt', { path: null as string | null });
    const spec = resolveWindowsShell(shim, ['--session-dir', 'C:\\mock\\app\\pi-bolt-sessions\\s1']);
    expect(spec.shell).toBe('cmd.exe');
    expect(spec.args[0]).toBe('/c');
    expect(spec.args[1]).toBe(SHIM);
    expect(spec.args.slice(2)).toEqual(['--session-dir', 'C:\\mock\\app\\pi-bolt-sessions\\s1']);
  });
});
