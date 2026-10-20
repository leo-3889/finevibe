import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// execSync lives in a hoisted const so the module factory can close over it.
const { execSync } = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock('child_process', () => ({ execSync }));
vi.mock('node:child_process', () => ({ execSync }));

// The App Execution Alias stub: exits 9009 with the Store nag, which makes
// execSync throw. This is the exact failure mode of the incident e866e4a
// fixed — the probe must fall through to the `py -3` launcher.
const ALIAS_STUB_FAILURE = Object.assign(
  new Error('Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.'),
  { status: 9009 },
);

function mockPlatform(isWin: boolean) {
  const setPythonBin = vi.fn();
  vi.doMock('./platform', () => ({ isWin, setPythonBin }));
  return setPythonBin;
}

// Dynamic imports are load-bearing here: each case installs a different
// ./platform mock via vi.doMock + vi.resetModules, so the module under test
// MUST be re-imported after the mock is in place (same pattern as
// hook-commands.test.ts). Static imports bind at collection time, before any
// per-test mock exists.
async function loadCheck() {
  const { checkPythonAvailable } = await import('./prerequisites');
  return checkPythonAvailable;
}

beforeEach(() => {
  vi.resetModules();
  execSync.mockReset();
});

afterEach(() => {
  vi.doUnmock('./platform');
  vi.restoreAllMocks();
});

describe('checkPythonAvailable()', () => {
  it('returns null without probing on non-Windows', async () => {
    const setPythonBin = mockPlatform(false);
    execSync.mockImplementation(() => {
      throw new Error('must not probe on POSIX — pythonBin is already pinned');
    });
    expect(await (await loadCheck())()).toBeNull();
    expect(execSync).not.toHaveBeenCalled();
    expect(setPythonBin).not.toHaveBeenCalled();
  });

  it('probes the `python` alias first and pins it when it answers', async () => {
    const setPythonBin = mockPlatform(true);
    execSync.mockReturnValue('Python 3.12.4\n');
    expect(await (await loadCheck())()).toBeNull();
    // Short-circuit: a working alias means the launcher is never probed.
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith('python --version', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    expect(setPythonBin).toHaveBeenCalledTimes(1);
    expect(setPythonBin).toHaveBeenCalledWith('python');
  });

  it('falls back to the `py -3` launcher when the alias stub fails, and pins the launcher', async () => {
    const setPythonBin = mockPlatform(true);
    execSync.mockImplementation((cmd: string) => {
      if (cmd === 'python --version') throw ALIAS_STUB_FAILURE;
      return 'Python 3.12.4\n';
    });
    expect(await (await loadCheck())()).toBeNull();
    // Alias-precedence decision pinned: alias first, launcher second. A
    // flipped order would pin `py -3` on boxes where the alias is healthy.
    expect(execSync.mock.calls.map(([cmd]) => cmd)).toEqual(['python --version', 'py -3 --version']);
    expect(execSync).toHaveBeenNthCalledWith(2, 'py -3 --version', { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
    expect(setPythonBin).toHaveBeenCalledTimes(1);
    expect(setPythonBin).toHaveBeenCalledWith('py -3');
  });

  it('returns install guidance and pins nothing when every candidate fails', async () => {
    const setPythonBin = mockPlatform(true);
    execSync.mockImplementation(() => {
      throw ALIAS_STUB_FAILURE;
    });
    const warning = await (await loadCheck())();
    expect(warning).toContain('Python not found.');
    expect(warning).toContain('winget install Python.Python.3');
    // A failed probe must leave the live pythonBin binding untouched.
    expect(setPythonBin).not.toHaveBeenCalled();
  });

  it('repoints the live pythonBin binding so hook scripts follow a PATH-less python.org install', async () => {
    // Real platform module underneath: the contract is that setPythonBin
    // mutates the live `export let pythonBin` binding every hook-command
    // generator reads. The Proxy forces isWin (the probe is Windows-only;
    // process.platform is a data property on Linux CI, so spyOn(process,
    // 'platform', 'get') is not an option) while passing pythonBin and
    // setPythonBin through to the real bindings.
    vi.doMock('./platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./platform')>();
      return new Proxy(actual, {
        get: (target, prop, receiver) =>
          prop === 'isWin' ? true : Reflect.get(target, prop, receiver),
      });
    });
    execSync.mockImplementation((cmd: string) => {
      if (cmd === 'python --version') throw ALIAS_STUB_FAILURE;
      return 'Python 3.12.4\n';
    });
    const platform = await import('./platform');
    const { checkPythonAvailable } = await import('./prerequisites');
    const seed = platform.pythonBin; // host seed: 'python' on Windows, /usr/bin/python3 elsewhere
    expect(checkPythonAvailable()).toBeNull();
    expect(platform.pythonBin).toBe('py -3'); // read live, not a spread copy
    expect(platform.pythonBin).not.toBe(seed);
  });
});
