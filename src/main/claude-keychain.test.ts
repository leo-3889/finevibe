import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const mockPlatform = { isMac: true, isWin: false, isLinux: false };
vi.mock('./platform', () => ({
  get isMac() { return mockPlatform.isMac; },
  get isWin() { return mockPlatform.isWin; },
  get isLinux() { return mockPlatform.isLinux; },
}));

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./store', () => ({ loadState: vi.fn() }));
vi.mock('./providers/claude-version', () => ({ getClaudeVersion: vi.fn() }));
vi.mock('./providers/resolve-binary', () => ({ resolveBinary: vi.fn(() => '/usr/bin/claude') }));

import { execFileSync } from 'child_process';
import { loadState } from './store';
import { getClaudeVersion } from './providers/claude-version';
import {
  keychainServiceForConfigDir,
  profileKeychainIsolated,
  getKeychainIsolationStatus,
  LAST_UNNAMESPACED_VERSION,
  _resetForTesting,
} from './claude-keychain';
import { resolveBinary } from './providers/resolve-binary';

const execFileSyncMock = vi.mocked(execFileSync);
const loadStateMock = vi.mocked(loadState);
const getClaudeVersionMock = vi.mocked(getClaudeVersion);

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

/** Drive execFileSync: every probe fails with `code` (missing binary, EACCES, timeout). */
function keychainThrowsLike(code: string) {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error(`${code}: keychain probe failed`), { code });
  });
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
    // Real value observed from a live Claude Code 2.1.159 keychain entry.
    const dir = '/Users/eliran.tutia/.vibeyard/profiles/23ad900c-a3f7-4daf-926b-0dc50337360a';
    expect(keychainServiceForConfigDir(dir)).toBe('Claude Code-credentials-5f8e9245');
  });

  it('hashes the path verbatim (a trailing slash changes the result)', () => {
    expect(keychainServiceForConfigDir('/a/b')).not.toBe(keychainServiceForConfigDir('/a/b/'));
  });
});

describe('profileKeychainIsolated', () => {
  it('returns true off macOS without touching the keychain', () => {
    mockPlatform.isMac = false;
    expect(profileKeychainIsolated('/some/dir')).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns true on macOS when the namespaced entry exists', () => {
    keychainWith(new Set([svc('/work')]));
    expect(profileKeychainIsolated('/work')).toBe(true);
  });

  it('returns false on macOS when the namespaced entry is absent', () => {
    keychainWith(new Set());
    expect(profileKeychainIsolated('/work')).toBe(false);
  });

  it('returns false when /usr/bin/security is missing (ENOENT)', () => {
    keychainThrowsLike('ENOENT');
    expect(profileKeychainIsolated('/work')).toBe(false);
  });

  it('returns false when the keychain probe is denied (EACCES)', () => {
    keychainThrowsLike('EACCES');
    expect(profileKeychainIsolated('/work')).toBe(false);
  });

  it('returns true on Windows through the platform seam, without a probe', () => {
    mockPlatform.isMac = false;
    mockPlatform.isWin = true;
    expect(profileKeychainIsolated('/work')).toBe(true);
    expect(execFileSyncMock).not.toHaveBeenCalled();
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
    keychainThrowsLike('EACCES');
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
