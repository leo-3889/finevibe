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

describe('pythonBin (audit P2-23 POSIX probe)', () => {
  it('probes python3 first and pins it when it answers', async () => {
    setPlatform('linux');
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('python3 ')) return 'Python 3.12.4\n';
      throw new Error('ENOENT');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('python3');
    expect(mockExecSync).toHaveBeenCalledWith(
      'python3 --version',
      { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' },
    );
  });

  it('falls through to /usr/bin/python3 when the bare python3 spelling is missing', async () => {
    setPlatform('linux');
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.startsWith('/usr/bin/python3 ')) return 'Python 3.11.2\n';
      throw new Error('ENOENT');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('/usr/bin/python3');
  });

  it('tries bare python last when the python3 spellings are missing', async () => {
    setPlatform('darwin');
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'python --version') return 'Python 3.13.0\n';
      throw new Error('ENOENT');
    });

    const { pythonBin } = await loadPlatform();

    expect(pythonBin).toBe('python');
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

  it('setPythonBin re-points the live binding the hook templates read', async () => {
    setPlatform('linux');
    const mod = await loadPlatform();

    mod.setPythonBin('/opt/pyenv/shims/python');

    expect(mod.pythonBin).toBe('/opt/pyenv/shims/python');
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
