import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const mockPlatform = { isMac: true, isWin: false, isLinux: false };
vi.mock('./platform', () => ({
  get isMac() { return mockPlatform.isMac; },
  get isWin() { return mockPlatform.isWin; },
  get isLinux() { return mockPlatform.isLinux; },
}));

vi.mock('child_process', () => {
  const execFile = vi.fn();
  // The row-17 async twin promisifies execFile; the custom symbol is what
  // makes `await execFileP(...)` resolve the { stdout } shape.
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (command: string, args: readonly string[], options: unknown) =>
      new Promise<{ stdout: string }>((resolve, reject) => {
        execFile(command, args, options, (err: unknown, stdout?: string) => {
          if (err) reject(err); else resolve({ stdout: stdout ?? '' });
        });
      }),
  });
  return { execFileSync: vi.fn(), execFile };
});
vi.mock('./store', () => ({ loadState: vi.fn() }));
vi.mock('./providers/claude-version', () => ({
  getClaudeVersion: vi.fn(),
  getClaudeVersionAsync: vi.fn(async () => null as string | null),
}));
vi.mock('./providers/resolve-binary', () => ({
  resolveBinary: vi.fn(() => '/usr/bin/claude'),
  resolveBinaryAsync: vi.fn(async () => '/usr/bin/claude'),
}));

import { execFileSync, execFile } from 'child_process';
import { loadState } from './store';
import type { LoadedState } from './store';
import { getClaudeVersion, getClaudeVersionAsync } from './providers/claude-version';
import {
  keychainServiceForConfigDir,
  getKeychainIsolationStatus,
  getKeychainIsolationStatusAsync,
  LAST_UNNAMESPACED_VERSION,
  _resetForTesting,
} from './claude-keychain';
import { resolveBinary, resolveBinaryAsync } from './providers/resolve-binary';

const execFileSyncMock = vi.mocked(execFileSync);
const execFileMock = vi.mocked(execFile);
const loadStateMock = vi.mocked(loadState);
const getClaudeVersionMock = vi.mocked(getClaudeVersion);
const getClaudeVersionAsyncMock = vi.mocked(getClaudeVersionAsync);

/** Make a config dir => its expected namespaced keychain service name. */
function svc(configDir: string): string {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Drive execFileSync: entries in `present` "exist" (return), all others throw. */
function keychainWith(present: Set<string>) {
  execFileSyncMock.mockImplementation((_bin: any, args: any) => {
    const service = (args as string[])[(args as string[]).indexOf('-s') + 1];
    if (present.has(service)) return Buffer.from('');
    throw new Error('SecKeychainSearchCopyNext: item not found');
  });
}

/** Async twin of keychainWith (row 17): the same answer through execFile. */
function keychainWithAsync(present: Set<string>) {
  execFileMock.mockImplementation(((
    _bin: any, args: any, _opts: any,
    cb: (err: unknown, stdout?: string) => void,
  ) => {
    const service = (args as string[])[(args as string[]).indexOf('-s') + 1];
    if (present.has(service)) cb(null, '');
    else cb(new Error('SecKeychainSearchCopyNext: item not found'));
  }) as never);
}

/** Drive execFileSync: every probe fails with `code` (missing binary, EACCES, timeout). */
function keychainThrowsLike(code: string) {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error(`${code}: keychain probe failed`), { code });
  });
}


/** Seed the profile list the keychain probe iterates; the probe reads only
 * providerId/configDir, so a structural cast is enough for the store shape. */
function profilesWith(profiles: { providerId: string; configDir: string }[]) {
  loadStateMock.mockReturnValue({ profiles } as unknown as LoadedState);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  mockPlatform.isMac = true;
  mockPlatform.isWin = false;
  mockPlatform.isLinux = false;
  loadStateMock.mockReturnValue({ profiles: [] } as any);
  getClaudeVersionMock.mockReturnValue(null);
  // Pin the default binary path: `clearAllMocks` keeps mockImplementations, so the
  // throwing resolveBinary from the unresolvable-binary test would leak forward.
  vi.mocked(resolveBinary).mockImplementation(() => '/usr/bin/claude');
});

describe('keychainServiceForConfigDir', () => {
  it('derives the service name from the first 8 hex chars of sha256(configDir)', () => {
    // Derivation contract: first 8 hex chars of sha256(configDir), hashed over
    // the dir verbatim. The expected digest is that of the fixture dir below —
    // recompute it with
    // `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,8))" "<dir>"`.
    const dir = '/Users/dev/.finevibe/profiles/11111111-1111-4111-8111-111111111111';
    expect(keychainServiceForConfigDir(dir)).toBe('Claude Code-credentials-1ca7010e');
  });

  it('hashes the path verbatim (a trailing slash changes the result)', () => {
    expect(keychainServiceForConfigDir('/a/b')).not.toBe(keychainServiceForConfigDir('/a/b/'));
  });
});

describe('getKeychainIsolationStatus', () => {
  it('is always supported off macOS', () => {
    mockPlatform.isMac = false;
    expect(getKeychainIsolationStatus()).toEqual({ status: 'supported', version: null });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('is supported when a known profile already has a namespaced keychain entry', () => {
    loadStateMock.mockReturnValue({ profiles: [{ providerId: 'claude', configDir: '/work' }] } as any);
    keychainWith(new Set([svc('/work')]));
    getClaudeVersionMock.mockReturnValue('2.1.10'); // old, but empirical evidence wins
    expect(getKeychainIsolationStatus().status).toBe('supported');
  });

  it('is unsupported on an old version with no namespaced entry', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue(LAST_UNNAMESPACED_VERSION);
    const res = getKeychainIsolationStatus();
    expect(res.status).toBe('unsupported');
    expect(res.version).toBe(LAST_UNNAMESPACED_VERSION);
  });

  it('is unknown on a newer-but-unconfirmed version (never falsely blocked)', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue('2.1.159');
    expect(getKeychainIsolationStatus().status).toBe('unknown');
  });

  it('is unknown when the version cannot be detected and no entry exists', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue(null);
    expect(getKeychainIsolationStatus().status).toBe('unknown');
  });

  it('caches a definitive verdict (unsupported) without re-probing', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue('2.1.0');
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
    const callsAfterFirst = getClaudeVersionMock.mock.calls.length;
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
    expect(getClaudeVersionMock.mock.calls.length).toBe(callsAfterFirst); // no recompute
  });

  it('recomputes an unknown verdict so it can upgrade after a profile login', () => {
    loadStateMock.mockReturnValue({ profiles: [{ providerId: 'claude', configDir: '/work' }] } as any);
    keychainWith(new Set()); // not logged in yet
    getClaudeVersionMock.mockReturnValue('2.1.159');
    expect(getKeychainIsolationStatus().status).toBe('unknown');
    keychainWith(new Set([svc('/work')])); // user logs in → namespaced entry appears
    expect(getKeychainIsolationStatus().status).toBe('supported');
  });

  it('ignores non-claude profiles when probing for namespaced entries', () => {
    loadStateMock.mockReturnValue({ profiles: [{ providerId: 'codex', configDir: '/work' }] } as any);
    keychainWith(new Set([svc('/work')])); // entry exists, but profile is codex
    getClaudeVersionMock.mockReturnValue('2.1.0');
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
  });

  it('classifies a denied keychain probe by version: old is blocked, new is allowed', () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainThrowsLike('EACCES');
    getClaudeVersionMock.mockReturnValue(LAST_UNNAMESPACED_VERSION);
    expect(getKeychainIsolationStatus()).toEqual({ status: 'unsupported', version: LAST_UNNAMESPACED_VERSION });

    _resetForTesting();
    getClaudeVersionMock.mockReturnValue('2.1.159');
    expect(getKeychainIsolationStatus().status).toBe('unknown');
  });

  it('classifies a missing security binary (ENOENT) by version: old is blocked, new is allowed', () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainThrowsLike('ENOENT');
    getClaudeVersionMock.mockReturnValue(LAST_UNNAMESPACED_VERSION);
    expect(getKeychainIsolationStatus()).toEqual({ status: 'unsupported', version: LAST_UNNAMESPACED_VERSION });

    _resetForTesting();
    getClaudeVersionMock.mockReturnValue('2.1.159');
    expect(getKeychainIsolationStatus().status).toBe('unknown');
  });

  it('falls back to version detection when the profile store is unreadable', () => {
    loadStateMock.mockImplementation(() => {
      throw new Error('store.json is corrupt');
    });
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue(LAST_UNNAMESPACED_VERSION);
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
  });

  it('is unknown when the version probe throws', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockImplementation(() => {
      throw new Error('claude --version timed out');
    });
    expect(getKeychainIsolationStatus()).toEqual({ status: 'unknown', version: null });
  });

  it('is unknown when the claude binary cannot be resolved', () => {
    keychainWith(new Set());
    vi.mocked(resolveBinary).mockImplementation(() => {
      throw new Error('claude not found on PATH');
    });
    expect(getKeychainIsolationStatus()).toEqual({ status: 'unknown', version: null });
  });

  it('skips claude profiles with no config dir when probing for namespaced entries', () => {
    loadStateMock.mockReturnValue({ profiles: [{ providerId: 'claude', configDir: '' }] } as any);
    keychainWith(new Set([svc('')])); // the empty-dir entry exists; the probe must skip it
    getClaudeVersionMock.mockReturnValue(LAST_UNNAMESPACED_VERSION);
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
  });

  it('caches a supported verdict without re-probing', () => {
    loadStateMock.mockReturnValue({ profiles: [{ providerId: 'claude', configDir: '/work' }] } as any);
    keychainWith(new Set([svc('/work')]));
    expect(getKeychainIsolationStatus().status).toBe('supported');
    const probes = execFileSyncMock.mock.calls.length;
    keychainWith(new Set()); // the entry disappears — the memoized verdict must not flinch
    expect(getKeychainIsolationStatus().status).toBe('supported');
    expect(execFileSyncMock.mock.calls.length).toBe(probes);
  });

  it('compares versions numerically at the threshold, not lexicographically', () => {
    keychainWith(new Set());
    getClaudeVersionMock.mockReturnValue('2.1.20'); // one patch above LAST → allowed
    expect(getKeychainIsolationStatus().status).toBe('unknown');

    _resetForTesting();
    // 2.1.2 is older than 2.1.19 numerically; a string compare ('2' > '1') would miss it.
    getClaudeVersionMock.mockReturnValue('2.1.2');
    expect(getKeychainIsolationStatus().status).toBe('unsupported');
  });

  it('is supported on Windows through the platform seam, with no subprocess probes', () => {
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
    expect(getKeychainIsolationStatus()).toEqual({ status: 'supported', version: null });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(getClaudeVersionMock).not.toHaveBeenCalled();
  });
});

// Row 17: spawnPty gates every Claude profile launch on this verdict, and an
// `unknown` verdict is deliberately not memoized — the sync lane therefore re-
// ran `which` + `claude --version` + one `security` spawn per profile, on the
// main thread, on EVERY profile launch. These pin the async twin's parity with
// the sync verdict rules and that it runs no sync subprocess at all.
describe('getKeychainIsolationStatusAsync', () => {
  beforeEach(() => {
    getClaudeVersionAsyncMock.mockResolvedValue(null);
    vi.mocked(resolveBinaryAsync).mockImplementation(async () => '/usr/bin/claude');
  });

  it('is always supported off macOS, with no subprocess at all', async () => {
    mockPlatform.isMac = false;
    await expect(getKeychainIsolationStatusAsync()).resolves.toEqual({ status: 'supported', version: null });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(getClaudeVersionAsyncMock).not.toHaveBeenCalled();
  });

  it('is supported when a known profile already has a namespaced keychain entry', async () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainWithAsync(new Set([svc('/work')]));
    getClaudeVersionAsyncMock.mockResolvedValue('2.1.10');
    const res = await getKeychainIsolationStatusAsync();
    expect(res.status).toBe('supported');
    expect(res.version).toBe('2.1.10');
  });

  it('is unsupported on an old version with no namespaced entry, and memoized like the sync lane', async () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainWithAsync(new Set()); // the profile has NO namespaced entry
    getClaudeVersionAsyncMock.mockResolvedValue(LAST_UNNAMESPACED_VERSION);
    await expect(getKeychainIsolationStatusAsync()).resolves.toMatchObject({ status: 'unsupported' });
    const securityCalls = () => execFileMock.mock.calls.filter((c) => c[0] === '/usr/bin/security').length;
    expect(securityCalls()).toBe(1);
    // Definitive verdict: the second call costs no probe (spawn hot path).
    expect(await getKeychainIsolationStatusAsync()).toMatchObject({ status: 'unsupported' });
    expect(securityCalls()).toBe(1);
    expect(getClaudeVersionAsyncMock).toHaveBeenCalledTimes(1);
  });
  it('is unknown on a newer build and stays uncached (never falsely blocked)', async () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainWithAsync(new Set());
    getClaudeVersionAsyncMock.mockResolvedValue('2.1.159');
    expect((await getKeychainIsolationStatusAsync()).status).toBe('unknown');
    expect((await getKeychainIsolationStatusAsync()).status).toBe('unknown');
    // 'unknown' can upgrade, so it re-probes — the same rule the sync lane has.
    expect(getClaudeVersionAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('runs the whole chain off the sync subprocess API', async () => {
    profilesWith([{ providerId: 'claude', configDir: '/work' }]);
    keychainWithAsync(new Set());
    await getKeychainIsolationStatusAsync();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', svc('/work')],
      expect.anything(),
      expect.any(Function),
    );
    expect(resolveBinaryAsync).toHaveBeenCalled();
    expect(vi.mocked(resolveBinary)).not.toHaveBeenCalled();
  });

  it('reports a version probe failure as undetectable, not as a blocked launch', async () => {
    keychainWithAsync(new Set());
    getClaudeVersionAsyncMock.mockRejectedValue(new Error('probe exploded'));
    await expect(getKeychainIsolationStatusAsync()).resolves.toEqual({ status: 'unknown', version: null });
  });
});
