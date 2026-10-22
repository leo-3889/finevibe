import { describe, it, expect, vi, beforeEach } from 'vitest';

// The probe is a synchronous execSync; the mock is hoisted so the module
// factory can close over it (same pattern as prerequisites.test.ts).
const { execSync, getFullPath } = vi.hoisted(() => ({
  execSync: vi.fn(),
  getFullPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
}));

vi.mock('child_process', () => ({ execSync }));
vi.mock('../pty-manager', () => ({ getFullPath }));

import { getClaudeVersion, resetClaudeVersionCache } from './claude-version';

const mockExecSync = vi.mocked(execSync);

const BINARY = '/mock/bin/claude';

describe('getClaudeVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The probe cache is module state; every case starts cold.
    resetClaudeVersionCache();
  });

  it('parses the semver out of the version banner and caches it', () => {
    mockExecSync.mockReturnValue('2.1.89 (Claude Code)\n');

    expect(getClaudeVersion(BINARY)).toBe('2.1.89');
    expect(getClaudeVersion(BINARY)).toBe('2.1.89');
    // One probe for two callers — the success is cached per binary path.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    // The probe runs the quoted binary with the app's augmented PATH and the
    // hard 3 s ceiling the P2-53 comment budgets.
    expect(mockExecSync).toHaveBeenCalledWith(
      `"${BINARY}" --version`,
      expect.objectContaining({ timeout: 3000, encoding: 'utf-8' }),
    );
  });

  // P2-53 (root cause of P1-13): `claude --version` blows its 3 s budget while
  // a heavy CLI launch competes for the CPU, execSync throws, and the old cache
  // stored that null for the process lifetime — every later caller (hook
  // install, statusline install, settings validation, keychain isolation) saw
  // the empty hook-event set and the user's hooks were stripped for the rest of
  // the session.
  it('does not cache a failed probe; the next caller retries and keeps the success', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });

    expect(getClaudeVersion(BINARY)).toBeNull();

    // The failure is a miss, not an answer: the next caller probes again…
    mockExecSync.mockReturnValue('2.1.90 (Claude Code)\n');
    expect(getClaudeVersion(BINARY)).toBe('2.1.90');
    expect(mockExecSync).toHaveBeenCalledTimes(2);

    // …and that success IS cached, so the third call costs no probe.
    expect(getClaudeVersion(BINARY)).toBe('2.1.90');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('does not cache a probe that prints no version', () => {
    // A binary that answers with an unparseable banner is exactly as
    // undetectable as one that times out.
    mockExecSync.mockReturnValueOnce('Claude Code (unknown build)\n');

    expect(getClaudeVersion(BINARY)).toBeNull();

    mockExecSync.mockReturnValue('2.0.42\n');
    expect(getClaudeVersion(BINARY)).toBe('2.0.42');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('re-probes when the resolved binary changes (one slot, keyed by path)', () => {
    mockExecSync.mockImplementation((cmd) =>
      String(cmd).includes('claude-work') ? '2.1.100\n' : '1.0.0\n',
    );

    expect(getClaudeVersion(BINARY)).toBe('1.0.0');
    expect(getClaudeVersion('/mock/bin/claude-work')).toBe('2.1.100');
    // The single cache slot holds the newest probe, so switching back is a
    // miss — a profile switch must never read the other binary's version.
    expect(getClaudeVersion(BINARY)).toBe('1.0.0');
    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });
});
