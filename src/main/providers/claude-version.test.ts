import { describe, it, expect, vi, beforeEach } from 'vitest';

// The sync probe is an execSync, the row-17 spawn-lane probe a promisified
// execFile; both mocks are hoisted so the module factory can close over them
// (same pattern as prerequisites.test.ts).
const { execSync, execFile, getFullPath, getFullPathAsync } = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
  getFullPath: vi.fn(() => '/usr/local/bin:/usr/bin'),
  getFullPathAsync: vi.fn(async () => '/usr/local/bin:/usr/bin'),
}));

// promisify(execFile) needs the custom symbol to resolve { stdout }.
vi.hoisted(() => {
  const call = execFile as unknown as (
    cmd: string, args: readonly string[], options: unknown,
    cb: (err: unknown, stdout?: string, stderr?: string) => void,
  ) => void;
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    command: string, args: readonly string[], options: unknown,
  ): Promise<{ stdout: string }> => new Promise((resolve, reject) => {
    call(command, args, options, (err, stdout) => {
      if (err) reject(err); else resolve({ stdout: stdout ?? '' });
    });
  });
  return {};
});

vi.mock('child_process', () => ({ execSync, execFile }));
vi.mock('../pty-manager', () => ({ getFullPath, getFullPathAsync }));

import { getClaudeVersion, getClaudeVersionAsync, resetClaudeVersionCache } from './claude-version';

const mockExecSync = vi.mocked(execSync);
const mockExecFile = vi.mocked(execFile);

/** Answer the async probe: `stdout` on success, a thrown error otherwise. */
function answerExecFile(stdout: string | null): void {
  mockExecFile.mockImplementation(((
    _cmd: string, _args: readonly string[], _opts: unknown,
    cb: (err: unknown, stdout?: string) => void,
  ) => {
    if (stdout === null) cb(new Error('spawn ETIMEDOUT'));
    else cb(null, stdout);
  }) as never);
}

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

// Row 17: the spawn lane (keychain guardrail on a Claude profile launch) may
// not run execSync — this pins the async twin's parity: same banner parse, same
// cache rules, no sync probe.
describe('getClaudeVersionAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeVersionCache();
  });

  it('parses and caches the version, spawns with execFile, never execSync', async () => {
    answerExecFile('2.1.89 (Claude Code)\n');

    expect(await getClaudeVersionAsync(BINARY)).toBe('2.1.89');
    expect(await getClaudeVersionAsync(BINARY)).toBe('2.1.89');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      BINARY,
      ['--version'],
      expect.objectContaining({ timeout: 3000, encoding: 'utf-8' }),
      expect.any(Function),
    );
  });

  it('does not cache a failed probe; the next caller retries and keeps the success', async () => {
    answerExecFile(null);
    expect(await getClaudeVersionAsync(BINARY)).toBeNull();

    answerExecFile('2.1.90 (Claude Code)\n');
    expect(await getClaudeVersionAsync(BINARY)).toBe('2.1.90');
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    expect(await getClaudeVersionAsync(BINARY)).toBe('2.1.90');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('does not cache a probe that prints no version', async () => {
    answerExecFile('Claude Code (unknown build)\n');
    expect(await getClaudeVersionAsync(BINARY)).toBeNull();

    answerExecFile('2.0.42\n');
    expect(await getClaudeVersionAsync(BINARY)).toBe('2.0.42');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    answerExecFile('2.1.95\n');
    const [a, b] = await Promise.all([getClaudeVersionAsync(BINARY), getClaudeVersionAsync(BINARY)]);
    expect([a, b]).toEqual(['2.1.95', '2.1.95']);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('feeds the async PATH snapshot to the probe and never the sync one', async () => {
    answerExecFile('2.1.89\n');
    await getClaudeVersionAsync(BINARY);
    await getClaudeVersionAsync(BINARY);
    // One PATH read (the cached version short-circuits the probe), and it is
    // always the async read: the spawn lane must not reach the sync PATH probe.
    expect(getFullPathAsync).toHaveBeenCalledTimes(1);
    expect(getFullPath).not.toHaveBeenCalled();
  });
});
