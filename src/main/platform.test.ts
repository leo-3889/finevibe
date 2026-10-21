import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
