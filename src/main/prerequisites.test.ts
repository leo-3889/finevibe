import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// PA-16: the probe is async execFile now (the execSync form blocked the main
// thread for up to 2×3 s on every Windows launch). execFile lives in a
// hoisted const so the module factory can close over it; prerequisites'
// promisify(execFile) wraps this mock, so the tests program the raw
// Node-style (cmd, args, options, callback) signature.
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', () => ({ execFile }));
vi.mock('node:child_process', () => ({ execFile }));

// The App Execution Alias stub: exits 9009 with the Store nag, which makes
// execFile's callback fire with an error. This is the exact failure mode of
// the incident e866e4a fixed — the probe must fall through to the `py -3`
// launcher.
const ALIAS_STUB_FAILURE = Object.assign(
  new Error('Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app execution aliases.'),
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

function answers(cmd: string, args: readonly string[], _opts: unknown, cb: (err: unknown, stdout?: string, stderr?: string) => void) {
  cb(null, `${cmd} ${args.join(' ')}\n`, '');
}

function fails(cmd: string, args: readonly string[], _opts: unknown, cb: (err: unknown, stdout?: string, stderr?: string) => void) {
  // The alias stub fails with the 9009 Store nag; the launcher ANSWERS —
  // this is the fall-through case, so `py` must succeed (the all-fail case
  // programs its own impl).
  if (cmd === 'python') cb(ALIAS_STUB_FAILURE);
  else cb(null, `Python 3.12.4 (${cmd} ${args.join(' ')})\n`, '');
}

beforeEach(() => {
  vi.resetModules();
  execFile.mockReset();
});

afterEach(() => {
  vi.doUnmock('./platform');
  vi.restoreAllMocks();
});

describe('checkPythonAvailable()', () => {
  it('returns null without probing on non-Windows', async () => {
    const setPythonBin = mockPlatform(false);
    execFile.mockImplementation(() => {
      throw new Error('must not probe on POSIX — pythonBin is already pinned');
    });
    expect(await (await loadCheck())()).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    expect(setPythonBin).not.toHaveBeenCalled();
  });

  it('probes the `python` alias first and pins it when it answers', async () => {
    const setPythonBin = mockPlatform(true);
    execFile.mockImplementation(answers);
    expect(await (await loadCheck())()).toBeNull();
    // Short-circuit: a working alias means the launcher is never probed.
    expect(execFile).toHaveBeenCalledTimes(1);
    // execFile is shell-free: argv form + windowsHide (mirrors execSync's
    // default — no console flash per probe).
    expect(execFile).toHaveBeenCalledWith(
      'python', ['--version'],
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      expect.any(Function),
    );
    expect(setPythonBin).toHaveBeenCalledTimes(1);
    expect(setPythonBin).toHaveBeenCalledWith('python');
  });

  it('falls back to the `py -3` launcher when the alias stub fails, and pins the launcher', async () => {
    const setPythonBin = mockPlatform(true);
    execFile.mockImplementation(fails);
    expect(await (await loadCheck())()).toBeNull();
    // Alias-precedence decision pinned: alias first, launcher second. A
    // flipped order would pin `py -3` on boxes where the alias is healthy.
    // `py -3` is launcher + flag as argv — the string form only worked
    // because execSync ran a shell.
    expect(execFile.mock.calls.map(([cmd, args]) => [cmd, ...(args as string[])])).toEqual([
      ['python', '--version'],
      ['py', '-3', '--version'],
    ]);
    expect(setPythonBin).toHaveBeenCalledTimes(1);
    expect(setPythonBin).toHaveBeenCalledWith('py -3');
  });

  it('returns install guidance and pins nothing when every candidate fails', async () => {
    const setPythonBin = mockPlatform(true);
    execFile.mockImplementation((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: unknown) => void) => {
      cb(ALIAS_STUB_FAILURE);
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
    execFile.mockImplementation(fails);
    const platform = await import('./platform');
    const { checkPythonAvailable } = await import('./prerequisites');
    const seed = platform.pythonBin; // host seed: 'python' on Windows, /usr/bin/python3 elsewhere
    expect(await checkPythonAvailable()).toBeNull();
    expect(platform.pythonBin).toBe('py -3'); // read live, not a spread copy
    expect(platform.pythonBin).not.toBe(seed);
  });

  it('does not block the caller — the probe is async end to end (PA-16)', async () => {
    // The probe's whole point: a pending python check must not stall the
    // boot chain. Fake clock; a sentinel timer scheduled AFTER the probe
    // starts fires BEFORE the probe resolves — the loop keeps turning.
    mockPlatform(true);
    execFile.mockImplementation((_cmd: string, _args: readonly string[], _opts: unknown, cb: (err: unknown, stdout?: string) => void) => {
      setTimeout(() => cb(null, 'Python 3.12.4\n'), 10);
    });
    const check = await loadCheck();
    vi.useFakeTimers();
    try {
      const checkPromise = check();
      const sentinel = Promise.withResolvers<void>();
      let loopTurned = false;
      setTimeout(() => {
        loopTurned = true;
        sentinel.resolve();
      }, 5);
      await vi.advanceTimersByTimeAsync(15);
      await sentinel.promise;
      expect(loopTurned).toBe(true);
      expect(await checkPromise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
