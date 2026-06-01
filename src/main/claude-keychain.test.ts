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

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  mockPlatform.isMac = true;
  loadStateMock.mockReturnValue({ profiles: [] } as any);
  getClaudeVersionMock.mockReturnValue(null);
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
});
