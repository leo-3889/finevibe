import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const realPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function loadPlatform() {
  vi.resetModules();
  return import('./platform');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('pythonBin (audit P2-23 POSIX probe, row 78 zero-exec)', () => {
  it('resolves python3 through the shell and pins the absolute path it prints', async () => {
    setPlatform('linux');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v python3') return '/opt/homebrew/bin/python3\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/opt/homebrew/bin/python3');
    expect(mockExecSync).toHaveBeenCalledWith(
      'command -v python3',
      { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' },
    );
  });

  // Row 78 is the mechanism, not the outcome: /usr/bin/python3 on a mac
  // without the Command Line Tools is Apple's installer shim, and EXECUTING it
  // pops the "Install Command Line Developer Tools" dialog — which this
  // module-load probe was doing on every boot. Resolution must therefore go
  // through the `command -v` builtin, never through the interpreter.
  it('never executes an interpreter while probing (no CLT install dialog at boot)', async () => {
    setPlatform('darwin');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v /usr/bin/python3') return '/usr/bin/python3\n';
      if (cmd.startsWith('xcode-select')) return '/Library/Developer/CommandLineTools\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/bin/python3');
    const commands = mockExecSync.mock.calls.map(([cmd]) => String(cmd));
    expect(commands).toEqual([
      'command -v python3',
      'command -v /usr/bin/python3',
      'xcode-select -p >/dev/null 2>&1',
    ]);
    expect(commands.some((cmd) => !cmd.startsWith('command -v ') && !cmd.startsWith('xcode-select'))).toBe(false);
    expect(commands.some((cmd) => cmd.includes('--version'))).toBe(false);
  });

  // Row 78 follow-up: `command -v` resolves Apple's CLT SHIM like a real
  // interpreter, so on a CLT-less mac the probe used to pin a path that pops the
  // "Install Command Line Developer Tools" dialog on first use — silently, since
  // the boot warning now sees a "found" python3. The CLT gate keeps probing.
  it('refuses the CLT shim when no Command Line Tools are selected (mac)', async () => {
    setPlatform('darwin');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v python3' || cmd === 'command -v /usr/bin/python3') return '/usr/bin/python3\n';
      if (cmd.startsWith('xcode-select')) throw new Error('no developer tools were found');
      if (cmd === 'command -v python') return '/opt/homebrew/bin/python\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/opt/homebrew/bin/python');
    const commands = mockExecSync.mock.calls.map(([cmd]) => String(cmd));
    // Gate fires once per shim hit: the PATH-resolved `python3` and the literal
    // candidate are the same file, and neither may become pythonBin.
    expect(commands.filter((cmd) => cmd.startsWith('xcode-select'))).toHaveLength(2);
    expect(commands.some((cmd) => cmd.includes('/usr/bin/python3') && cmd.startsWith('command -v'))).toBe(true);
  });

  // The gate is darwin-only: a Linux box with /usr/bin/python3 (distro python)
  // must never pay an xcode-select spawn, and must keep the resolved path.
  it('never runs the CLT gate off macOS', async () => {
    setPlatform('linux');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v python3') return '/usr/bin/python3\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/bin/python3');
    expect(mockExecSync.mock.calls.map(([cmd]) => String(cmd))).toEqual(['command -v python3']);
  });

  it('falls through to bare python when the python3 spellings are absent', async () => {
    setPlatform('darwin');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v python') return '/usr/local/bin/python\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/local/bin/python');
  });

  it('treats a locator that resolves to nothing as a miss and keeps probing', async () => {
    setPlatform('linux');
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'command -v python3') return '   \n';
      if (cmd === 'command -v /usr/bin/python3') return '/usr/bin/python3\n';
      throw new Error('not found');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/bin/python3');
  });

  it('keeps the /usr/bin/python3 default when every candidate fails', async () => {
    setPlatform('linux');

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/bin/python3');
  });

  it('does not probe on Windows — checkPythonAvailable() owns that re-point', async () => {
    setPlatform('win32');

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('python');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // prerequisites.ts's boot warning walks the SAME list in the SAME order; a
  // second literal there is how the two probes would drift apart.
  it('exports the candidate list prerequisites.ts resolves in order', async () => {
    setPlatform('linux');
    const { POSIX_PYTHON_CANDIDATES } = await loadPlatform();

    expect(POSIX_PYTHON_CANDIDATES).toEqual(['python3', '/usr/bin/python3', 'python']);
  });

  it('setPythonBin re-points the live binding the hook templates read', async () => {
    setPlatform('linux');
    const mod = await loadPlatform();

    mod.setPythonBin('/opt/pyenv/shims/python');

    expect(mod.pythonBin).toBe('/opt/pyenv/shims/python');
  });
});

// Row 76: electron-builder copies build.mac.minimumSystemVersion into the
// bundle's Info.plist (LSMinimumSystemVersion). Without it, a macOS older than
// the Electron floor launches the app and dies inside dyld on missing symbols
// instead of getting the "can't be opened" refusal — a static config value no
// runtime test can observe, so it is pinned here (package.json stays strict
// JSON, which is why the reasoning is in this test rather than the config).
describe('build.mac.minimumSystemVersion (row 76 mac floor)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    build: { mac: { minimumSystemVersion?: string } };
    devDependencies: Record<string, string>;
  };

  it('ships the Electron runtime minimum so old macOS refuses instead of crashing', () => {
    // Electron 41's floor is macOS 12 Monterey: the installed package's README
    // states "macOS (Monterey and up)" — Electron 38 dropped Big Sur, Electron
    // 44 drops Monterey. Pinned against the declared Electron major so the next
    // Electron bump has to revisit the floor instead of shipping a bundle that
    // dies in dyld on the oldest supported OS.
    expect(pkg.build.mac.minimumSystemVersion).toBe('12.0');
    const electronMajor = Number(pkg.devDependencies.electron.replace(/[^\d.]/g, '').split('.')[0]);
    expect(electronMajor).toBe(41);
  });
});

// AUDIT row 85: the FINEVIBE_DISABLE_GPU escape hatch wired in main.ts and
// documented under docs/packaging.md. The fault path it exists for (Electron GPU
// process → ANGLE/Vulkan → Mesa RADV, gfx1201 ring-gfx soft recoveries) is
// Mesa-only, so a global dotfile export must not de-accelerate Windows/macOS.
describe('shouldDisableHardwareAcceleration (row 85 GPU escape hatch)', () => {
  it('opts a linux run out of GL when FINEVIBE_DISABLE_GPU=1', async () => {
    const { shouldDisableHardwareAcceleration: should } = await loadPlatform();

    expect(should({ FINEVIBE_DISABLE_GPU: '1' }, 'linux')).toBe(true);
  });

  it('keeps acceleration for any other value on linux', async () => {
    const { shouldDisableHardwareAcceleration: should } = await loadPlatform();

    expect(should({ FINEVIBE_DISABLE_GPU: '0' }, 'linux')).toBe(false);
    expect(should({}, 'linux')).toBe(false);
    expect(should({ FINEVIBE_DISABLE_GPU: 'true' }, 'linux')).toBe(false);
  });

  it('is ignored on win32 and darwin', async () => {
    const { shouldDisableHardwareAcceleration: should } = await loadPlatform();

    expect(should({ FINEVIBE_DISABLE_GPU: '1' }, 'win32')).toBe(false);
    expect(should({ FINEVIBE_DISABLE_GPU: '1' }, 'darwin')).toBe(false);
  });

  // Call-site form: main.ts passes only env, so the platform must default to the
  // running process — a wrong default would silently dead-letter the hatch.
  it('defaults the platform argument to process.platform', async () => {
    setPlatform('linux');
    const { shouldDisableHardwareAcceleration: should } = await loadPlatform();

    expect(should({ FINEVIBE_DISABLE_GPU: '1' })).toBe(true);
  });

  // Boot-order belt: every boot test mocks this helper to false, so deleting the
  // main.ts block or moving it below `app.whenReady` stays green — and "strictly
  // before ready" IS the mechanism, because disableHardwareAcceleration() after
  // ready is a no-op for the already-spawned GPU process. Only a static read of
  // main.ts fails on that move (style precedent: npm-launcher.test.ts gates).
  it('is called from main.ts module scope, before app.whenReady', () => {
    const mainSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'main.ts'), 'utf8');

    const call = mainSource.indexOf('shouldDisableHardwareAcceleration(');
    const ready = mainSource.indexOf('app.whenReady');

    expect(call, 'main.ts no longer calls shouldDisableHardwareAcceleration(').toBeGreaterThan(-1);
    expect(ready, 'main.ts has no app.whenReady').toBeGreaterThan(-1);
    expect(call).toBeLessThan(ready);
  });
});
