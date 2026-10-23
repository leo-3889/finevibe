import { vi } from 'vitest';
import * as path from 'path';
import type * as PlatformModule from './platform';
import { isMac, isWin } from './platform';

const { mockSpawn, mockWrite, mockResize, mockKill, mockExecFile, mockNvmDefaultNodeBinDir, mockKeychainIsolation } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockWrite: vi.fn(),
  mockResize: vi.fn(),
  mockKill: vi.fn(),
  mockExecFile: vi.fn(),
  mockKeychainIsolation: vi.fn(() => ({ status: 'supported' as 'supported' | 'unsupported' | 'unknown', version: null as string | null })),
  mockNvmDefaultNodeBinDir: vi.fn(() => null as string | null),
}));

vi.mock('node-pty', () => ({
  default: { spawn: mockSpawn },
  spawn: mockSpawn,
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: mockExecFile,
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  tmpdir: () => '/tmp',
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readdirSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readlinkSync: vi.fn(() => { throw new Error('ENOENT'); }),
}));

vi.mock('./providers/nvm', () => ({
  nvmDefaultNodeBinDir: mockNvmDefaultNodeBinDir,
  findBinaryInNvm: vi.fn(() => null),
}));

vi.mock('./claude-keychain', () => ({
  getKeychainIsolationStatus: mockKeychainIsolation,
}));

// P1-14: the per-spawn profile install goes through settings-guard's consent
// gate (foreign statusLine + prior Keep => no overwrite). The spawn-path
// contract asserted here is the delegation itself; the gate's consent
// semantics are pinned in settings-guard.test.ts.
const mockGuardedProfileInstall = vi.hoisted(() => vi.fn());
vi.mock('./settings-guard', () => ({
  guardedProfileInstall: mockGuardedProfileInstall,
  guardedInstall: vi.fn(),
  validateSettings: vi.fn(() => ({})),
  reinstallSettings: vi.fn(),
  shouldWarnStatusLine: vi.fn(() => false),
}));

import * as fs from 'fs';
import * as child_process from 'child_process';
import { spawnPty, writePty, resizePty, killPty, getPtyCwd, getRegistryPath, getFullPath, resetPathCache, resolveWindowsShell, withUtf8Locale, resolveLaunchSpec, LaunchSpecError } from './pty-manager';
import { SPAWN_REJECTED_EXIT_REASON } from '../shared/constants';
import { getProvider, initProviders } from './providers/registry';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const fileStat = { isFile: () => true } as fs.Stats;

function createMockPtyProcess() {
  const dataCallbacks: ((data: string) => void)[] = [];
  const exitCallbacks: ((info: { exitCode: number; signal?: number }) => void)[] = [];
  const proc = {
    onData: vi.fn((cb: (data: string) => void) => { dataCallbacks.push(cb); }),
    onExit: vi.fn((cb: (info: { exitCode: number; signal?: number }) => void) => { exitCallbacks.push(cb); }),
    write: mockWrite,
    resize: mockResize,
    kill: mockKill,
    _emitData: (data: string) => dataCallbacks.forEach(cb => cb(data)),
    _emitExit: (exitCode: number, signal?: number) => exitCallbacks.forEach(cb => cb({ exitCode, signal })),
  };
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockKeychainIsolation.mockReturnValue({ status: 'supported', version: null });
  initProviders();
});

describe('spawnPty', () => {
  it('spawns a PTY process with correct args', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'claude'],
        expect.objectContaining({
          cwd: '/project',
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
        }),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        [],
        expect.objectContaining({
          cwd: '/project',
          name: 'xterm-256color',
          cols: 120,
          rows: 30,
        }),
      );
    }
  });

  it('adds -r flag when resuming with cliSessionId', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', 'claude-123', true, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'claude', '-r', 'claude-123'],
        expect.any(Object),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['-r', 'claude-123'],
        expect.any(Object),
      );
    }
  });

  it('adds --session-id flag when not resuming', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', 'claude-123', false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'claude', '--session-id', 'claude-123'],
        expect.any(Object),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['--session-id', 'claude-123'],
        expect.any(Object),
      );
    }
  });

  it('splits extraArgs into individual args', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '--verbose --debug', 'claude', undefined, undefined, '', vi.fn(), vi.fn());


    if (isWin) {
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'claude', '--verbose', '--debug'],
        expect.any(Object),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['--verbose', '--debug'],
        expect.any(Object),
      );
    }
  });

  it('forwards PTY data to callback', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const onData = vi.fn();

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', onData, vi.fn());
    proc._emitData('hello');

    expect(onData).toHaveBeenCalledWith('hello');
  });

  it('forwards exit event to callback', () => {
    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 2028;
    mockSpawn.mockReturnValue(proc);
    const onExit = vi.fn();

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), onExit);
    proc._emitExit(0, 0);

    expect(onExit).toHaveBeenCalledWith(0, 0, 2028);
  });

  it('uses resolved claude path when found', async () => {
    // Must reset modules to clear cachedClaudePath from prior tests
    vi.resetModules();
    const expectedPath = isWin
      ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'claude.cmd')
      : '/usr/local/bin/claude';
    mockStatSync.mockImplementation((p) => {
      if (String(p) === expectedPath) return fileStat;
      throw new Error('ENOENT');
    });
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    const { initProviders: freshInit } = await import('./providers/registry');
    const { spawnPty: freshSpawnPty } = await import('./pty-manager');
    freshInit();
    freshSpawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      // On Windows, .cmd files are wrapped with cmd.exe /c
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', expectedPath],
        expect.any(Object),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        expectedPath,
        [],
        expect.any(Object),
      );
    }
  });

  it('sets required env vars', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.CLAUDE_IDE_SESSION_ID).toBe('s1');
    expect(env.CLAUDE_CODE).toBeUndefined();
  });

  it('merges user-provided env vars into the spawn environment', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, 'FOO=bar\nBAZ=qux', vi.fn(), vi.fn());

    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
    // provider-set vars remain when not overridden
    expect(env.CLAUDE_IDE_SESSION_ID).toBe('s1');
  });

  it('lets user env vars override provider-set vars (user wins)', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, 'PATH=/custom/bin', vi.fn(), vi.fn());

    const env = mockSpawn.mock.calls[0][2].env;
    expect(env.PATH).toBe('/custom/bin');
  });

  it('augments PATH with extra directories', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    const envPath = mockSpawn.mock.calls[0][2].env.PATH;
    if (isWin) {
      expect(envPath).toContain(path.join('/mock/home', 'AppData', 'Roaming', 'npm'));
    } else {
      expect(envPath).toContain('/usr/local/bin');
      expect(envPath).toContain('/opt/homebrew/bin');
      expect(envPath).toContain('/mock/home/.local/bin');
    }
  });

  it('rejects unsupported extra args before spawning (actionable message, spawn-rejected, no PTY)', () => {
    const onData = vi.fn();
    const onExit = vi.fn();
    spawnPty('s1', '/project', null, false, '--no-session', 'omp', undefined, undefined, '', onData, onExit);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData.mock.calls[0][0]).toContain('--no-session');
    // The sentinel — not a bare exit code — is what tells the renderer the
    // pane must survive so the "remove these options" message stays readable.
    expect(onExit).toHaveBeenCalledWith(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
  });

  it('reports a genuine exit code 1 as a plain process exit (no spawn-rejected sentinel)', () => {
    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 2028;
    mockSpawn.mockReturnValue(proc);
    const onExit = vi.fn();

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), onExit);
    proc._emitExit(1, 0);

    // Exactly three positional args: a 4th would tell the renderer to keep the
    // pane, which is exactly wrong for a process that really died.
    expect(onExit).toHaveBeenCalledWith(1, 0, 2028);
  });

  it('reports a Claude profile blocked by keychain isolation as spawn-rejected (no PTY)', () => {
    mockKeychainIsolation.mockReturnValue({ status: 'unsupported', version: '2.1.19' });
    const onData = vi.fn();
    const onExit = vi.fn();

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', onData, onExit, '/profiles/work');

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData.mock.calls[0][0]).toContain('keychain login, mixing the accounts');
    expect(onExit).toHaveBeenCalledWith(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
  });

  // P1-14: the profile install must not run raw at spawn — it goes through
  // settings-guard's consent gate so a foreign statusLine in the profile
  // dir (e.g. with a prior Keep) is never silently overwritten.
  it('routes a profile-pinned Claude spawn through the consent-gated profile install', async () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    await spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn(), '/profiles/work');

    expect(mockGuardedProfileInstall).toHaveBeenCalledWith('/profiles/work');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('never runs the profile install for a default-dir Claude spawn', async () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    await spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    expect(mockGuardedProfileInstall).not.toHaveBeenCalled();
  });

  it('never runs the profile install for a non-Claude profile session', async () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    await spawnPty('s1', '/project', null, false, '', 'pi', undefined, undefined, '', vi.fn(), vi.fn(), '/profiles/work');

    expect(mockGuardedProfileInstall).not.toHaveBeenCalled();
  });

  it('runs no profile install when the keychain guardrail blocks the spawn', () => {
    mockKeychainIsolation.mockReturnValue({ status: 'unsupported', version: '2.1.19' });

    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn(), '/profiles/work');

    expect(mockGuardedProfileInstall).not.toHaveBeenCalled();
  });

  it('spawns with tokenized (quoted) extra args', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    spawnPty('s1', '/project', null, false, '--append-system-prompt "Use concise replies"', 'omp', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      expect(mockSpawn).toHaveBeenCalledWith(
        'cmd.exe',
        ['/c', 'omp', '--session-dir', expect.stringContaining('omp-sessions'), '--append-system-prompt', 'Use concise replies'],
        expect.any(Object),
      );
    } else {
      expect(mockSpawn).toHaveBeenCalledWith(
        'omp',
        ['--session-dir', expect.stringContaining('omp-sessions'), '--append-system-prompt', 'Use concise replies'],
        expect.any(Object),
      );
    }
  });
});

describe('resolveLaunchSpec (T2)', () => {
  const base = { sessionId: 's1', cliSessionId: null, isResume: false, extraArgs: '', providerId: 'omp' as const, envVars: '' };

  it('resolves executable, argv, env, profile identity and default storage mode', () => {
    const spec = resolveLaunchSpec({ ...base, extraArgs: '--model opus', configDir: '/profiles/work' });
    expect(spec.executable).toBe('omp');
    expect(spec.argv).toEqual(['--session-dir', expect.stringContaining('omp-sessions'), '--model', 'opus']);
    expect(spec.env.PI_CODING_AGENT_DIR).toBe('/profiles/work');
    expect(spec.providerId).toBe('omp');
    expect(spec.configDir).toBe('/profiles/work');
    expect(spec.storageMode).toBe('default');
  });

  it('resolves the default agent dir (no configDir) with storage mode default', () => {
    const spec = resolveLaunchSpec(base);
    expect(spec.configDir).toBeUndefined();
    expect(spec.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(spec.storageMode).toBe('default');
  });

  it('rejects profile, storage and session-identity flags in extra args', () => {
    for (const extra of ['--profile work', '--profile=work', '--session-dir /x', '--session-dir=/x', '--no-session', '--session abc', '--resume abc', '-r', '-c', '--continue']) {
      expect(() => resolveLaunchSpec({ ...base, extraArgs: extra })).toThrow(LaunchSpecError);
    }
  });

  it('rejects a custom session storage env var with an actionable message', () => {
    expect(() => resolveLaunchSpec({ ...base, envVars: 'PI_CODING_AGENT_SESSION_DIR=/other' }))
      .toThrow(/PI_CODING_AGENT_SESSION_DIR/);
  });

  it('keeps the pinned profile when user env tries to override it', () => {
    const spec = resolveLaunchSpec({ ...base, envVars: 'PI_CODING_AGENT_DIR=/other\nOMP_PROFILE=intruder', configDir: '/profiles/work' });
    expect(spec.env.PI_CODING_AGENT_DIR).toBe('/profiles/work');
    expect(spec.env.OMP_PROFILE).toBeUndefined();
  });

  it('strips an inherited native profile selector from the child environment', () => {
    process.env.OMP_PROFILE = 'inherited';
    try {
      const spec = resolveLaunchSpec(base);
      expect(spec.env.OMP_PROFILE).toBeUndefined();
    } finally {
      delete process.env.OMP_PROFILE;
    }
  });
});

describe('writePty', () => {
  it('writes to existing PTY', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    writePty('s1', 'input');
    expect(mockWrite).toHaveBeenCalledWith('input');
  });

  it('does nothing for unknown session', () => {
    writePty('unknown', 'input');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('resizePty', () => {
  it('resizes existing PTY', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    resizePty('s1', 200, 50);
    expect(mockResize).toHaveBeenCalledWith(200, 50);
  });

  // Regression test for #70: node-pty on Windows throws synchronously from
  // WindowsPtyAgent.resize when the underlying child has exited. Before the
  // fix, this crashed the main process and killed every open session.
  it('swallows errors from node-pty on already-exited PTY (issue #70)', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockResize.mockImplementationOnce(() => {
      throw new Error('Cannot resize a pty that has already exited');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => resizePty('s1', 120, 30)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('resizePty'));
    warnSpy.mockRestore();

    // After an "already exited" error the handle must be dropped —
    // a subsequent resize on the same session is a no-op.
    mockResize.mockClear();
    resizePty('s1', 80, 24);
    expect(mockResize).not.toHaveBeenCalled();
  });

  // The map is pruned ONLY when the error signals process exit. A transient
  // or unknown error must leave the handle intact so retries can succeed,
  // otherwise the session would silently become unresponsive.
  it('keeps the handle on transient (non-exit) errors (issue #70 review)', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockResize.mockImplementationOnce(() => {
      throw new Error('EBUSY: some transient failure');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => resizePty('s1', 120, 30)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('s1'));
    warnSpy.mockRestore();

    // Handle is still registered — a subsequent successful resize must go through.
    mockResize.mockClear();
    resizePty('s1', 80, 24);
    expect(mockResize).toHaveBeenCalledWith(80, 24);
  });
});

describe('writePty error handling (issue #70)', () => {
  it('swallows errors when writing to an already-exited PTY', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockWrite.mockImplementationOnce(() => {
      throw new Error('Cannot write to a pty that has already exited');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => writePty('s1', 'hello')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('writePty'));
    warnSpy.mockRestore();

    // Handle dropped — subsequent write is a no-op.
    mockWrite.mockClear();
    writePty('s1', 'again');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('keeps the handle on transient (non-exit) errors (issue #70 review)', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockWrite.mockImplementationOnce(() => {
      throw new Error('EAGAIN: resource temporarily unavailable');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => writePty('s1', 'hello')).not.toThrow();
    warnSpy.mockRestore();

    // Handle still registered — subsequent successful write must go through.
    mockWrite.mockClear();
    writePty('s1', 'again');
    expect(mockWrite).toHaveBeenCalledWith('again');
  });

  // Security-review follow-up: sessionId arrives from the renderer over IPC
  // and must be sanitised in log output so that crafted values (newlines,
  // ANSI escape sequences) cannot confuse log consumers.
  it('sanitises sessionId with control characters in log output', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    const hostileId = "evil\n[pty-manager] fake log line\x1b[31m";
    spawnPty(hostileId, '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockWrite.mockImplementationOnce(() => {
      throw new Error('Cannot write to a pty that has already exited');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writePty(hostileId, 'hello');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0] as string;
    // Raw newline/ESC must not appear in the logged string — JSON.stringify
    // must have escaped them.
    expect(logged).not.toMatch(/\n(?!$)/);
    expect(logged).not.toContain('\x1b');
    expect(logged).toContain('\\n');
    warnSpy.mockRestore();
  });
});

describe('killPty error handling (issue #70)', () => {
  it('swallows errors when killing an already-exited PTY and still drops the handle', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    mockKill.mockImplementationOnce(() => {
      throw new Error('Cannot kill a pty that has already exited');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => killPty('s1')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('s1'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('killPty'));
    // After kill (even if it throws), a subsequent resize must be a no-op —
    // the handle is gone, so mockResize must not be called.
    mockResize.mockClear();
    resizePty('s1', 120, 30);
    expect(mockResize).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('killPty', () => {
  it('kills and removes PTY', () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    killPty('s1');
    expect(mockKill).toHaveBeenCalled();

    // Writing after kill should be a no-op
    mockWrite.mockClear();
    writePty('s1', 'input');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('stale kills (no spawn in flight)', () => {
  it('does not kill a resumed PTY when the kill arrives after the old PTY exited', async () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(proc);
    await spawnPty('resumed', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());
    proc._emitExit(1); // crash: the PTY is gone from the registry

    // A late kill for the crashed session: nothing is spawning for this id,
    // so the kill addresses a PTY that no longer exists. Remembering it
    // used to tear down the next PTY resumed under the same id.
    expect(killPty('resumed')).toBe(false);
    expect(mockKill).not.toHaveBeenCalled();

    const resumed = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(resumed);
    await spawnPty('resumed', '/project', 'cli-1', true, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());
    expect(mockKill).not.toHaveBeenCalled();
    mockWrite.mockClear();
    writePty('resumed', 'input');
    expect(mockWrite).toHaveBeenCalledWith('input');
  });

  it('ignores a kill for an id that was never spawned, so a later spawn survives', async () => {
    expect(killPty('never-spawned')).toBe(false);

    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(proc);
    await spawnPty('never-spawned', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());
    expect(mockKill).not.toHaveBeenCalled();
    mockWrite.mockClear();
    writePty('never-spawned', 'input');
    expect(mockWrite).toHaveBeenCalledWith('input');
  });
});

describe('killPty arriving while spawnPty is still awaiting', () => {
  it('kills the PTY the moment it registers instead of orphaning the CLI', async () => {
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValue(proc);

    // The renderer drops the session while spawnPty is awaiting the Copilot
    // hook install — the kill lands inside the in-flight window, so it is
    // remembered and the new PTY is torn down as soon as it registers.
    const copilot = getProvider('copilot');
    vi.spyOn(copilot, 'installHooks').mockImplementation(async () => {
      expect(killPty('pending-kill')).toBe(false);
    });
    await spawnPty('pending-kill', '/project', null, false, '', 'copilot', undefined, undefined, '', vi.fn(), vi.fn());

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledTimes(1);

    // And deregistered: no live handle an orphaned CLI could keep writing to.
    mockWrite.mockClear();
    writePty('pending-kill', 'input');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('drops the pending kill when the attempt never spawns, so a retry survives', async () => {
    // The kill lands inside the in-flight window, then pty.spawn fails:
    // there is nothing to kill, and the flag must not leak to the retry.
    const copilot = getProvider('copilot');
    let killedOnce = false;
    vi.spyOn(copilot, 'installHooks').mockImplementation(async () => {
      if (!killedOnce) {
        killedOnce = true;
        expect(killPty('retry-after-failure')).toBe(false);
      }
    });
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    await expect(
      spawnPty('retry-after-failure', '/project', null, false, '', 'copilot', undefined, undefined, '', vi.fn(), vi.fn()),
    ).rejects.toThrow('spawn failed');

    // The user fixes the problem and re-spawns the same session id: the kill
    // that belonged to the failed attempt must not tear down the new CLI.
    const proc = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(proc);
    await spawnPty('retry-after-failure', '/project', null, false, '', 'copilot', undefined, undefined, '', vi.fn(), vi.fn());
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockKill).not.toHaveBeenCalled();
    mockWrite.mockClear();
    writePty('retry-after-failure', 'input');
    expect(mockWrite).toHaveBeenCalledWith('input');
  });
});

describe('PTY replacement exit ordering', () => {
  it('suppresses only the replaced process when the new process exits first', async () => {
    const oldProc = createMockPtyProcess();
    const newProc = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(oldProc).mockReturnValueOnce(newProc);
    const oldExit = vi.fn();
    const newExit = vi.fn();
    await spawnPty('replacement-order', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), oldExit);
    await spawnPty('replacement-order', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), newExit);
    newProc._emitExit(1);
    oldProc._emitExit(0);
    expect(newExit).toHaveBeenCalledWith(1, undefined, undefined);
    expect(oldExit).not.toHaveBeenCalled();
  });

  it('suppresses a synchronous exit emitted by kill during replacement', async () => {
    const oldProc = createMockPtyProcess();
    const newProc = createMockPtyProcess();
    mockSpawn.mockReturnValueOnce(oldProc).mockReturnValueOnce(newProc);
    const oldExit = vi.fn();
    const newExit = vi.fn();
    await spawnPty('replacement-sync', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), oldExit);
    mockKill.mockImplementationOnce(() => oldProc._emitExit(0));
    await spawnPty('replacement-sync', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), newExit);
    expect(oldExit).not.toHaveBeenCalled();
    newProc._emitExit(1);
    expect(newExit).toHaveBeenCalledWith(1, undefined, undefined);
  });
});

describe('getPtyCwd', () => {
  it('returns null for unknown session', async () => {
    const result = await getPtyCwd('unknown');
    expect(result).toBeNull();
  });

  it('returns cwd of deepest child process', async () => {
    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 1000;
    mockSpawn.mockReturnValue(proc);
    spawnPty('s1', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    if (isWin) {
      // On Windows, getPtyCwd always returns null (not supported)
      const result = await getPtyCwd('s1');
      expect(result).toBeNull();
      return;
    }

    // pgrep for pid 1000 returns child 2000
    mockExecFile.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
      if (args[1] === '1000') callback(null, '2000\n');
      return undefined as never;
    });

    // pgrep for pid 2000 returns no children (error)
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
      callback(new Error('no children'), '');
      return undefined as never;
    });

    // lsof for pid 2000
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
      callback(null, 'p2000\nfcwd\nn/some/worktree/path\n');
      return undefined as never;
    });

    const result = await getPtyCwd('s1');
    expect(result).toBe('/some/worktree/path');
  });

  it('returns null when lsof fails', async () => {
    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 1000;
    mockSpawn.mockReturnValue(proc);
    spawnPty('s2', '/project', null, false, '', 'claude', undefined, undefined, '', vi.fn(), vi.fn());

    // pgrep returns no children
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
      callback(new Error('no children'), '');
      return undefined as never;
    });

    // lsof fails
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
      callback(new Error('lsof failed'), '');
      return undefined as never;
    });

    const result = await getPtyCwd('s2');
    expect(result).toBeNull();
  });
});


const mockExecSync = vi.mocked(child_process.execSync);

describe('getRegistryPath', () => {
  beforeEach(() => {
    resetPathCache();
  });

  if (isWin) {
    it('parses REG_SZ registry output', () => {
      mockExecSync
        .mockReturnValueOnce(
          '\r\nHKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    Path    REG_SZ    C:\\Windows\\system32;C:\\Windows\r\n\r\n',
        )
        .mockReturnValueOnce(
          '\r\nHKCU\\Environment\r\n    Path    REG_SZ    C:\\Users\\test\\AppData\\Roaming\\npm\r\n\r\n',
        );

      const result = getRegistryPath();
      expect(result).toContain('C:\\Windows\\system32;C:\\Windows');
      expect(result).toContain('C:\\Users\\test\\AppData\\Roaming\\npm');
    });

    it('expands %VAR% references in REG_EXPAND_SZ values', () => {
      process.env.SystemRoot = 'C:\\Windows';
      process.env.USERPROFILE = 'C:\\Users\\test';

      mockExecSync
        .mockReturnValueOnce(
          '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%\r\n',
        )
        .mockReturnValueOnce(
          '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm\r\n',
        );

      const result = getRegistryPath();
      expect(result).toContain('C:\\Windows\\system32');
      expect(result).toContain('C:\\Users\\test\\AppData\\Roaming\\npm');
      expect(result).not.toContain('%SystemRoot%');
      expect(result).not.toContain('%USERPROFILE%');
    });

    it('returns empty string when registry queries fail', () => {
      mockExecSync.mockImplementation(() => { throw new Error('access denied'); });

      const result = getRegistryPath();
      expect(result).toBe('');
    });

    it('handles partial failure (system path fails, user path succeeds)', () => {
      mockExecSync
        .mockImplementationOnce(() => { throw new Error('access denied'); })
        .mockReturnValueOnce(
          '    Path    REG_SZ    C:\\Users\\test\\AppData\\Roaming\\npm\r\n',
        );

      const result = getRegistryPath();
      expect(result).toContain('C:\\Users\\test\\AppData\\Roaming\\npm');
    });
  } else {
    it('returns empty string on non-Windows', () => {
      expect(getRegistryPath()).toBe('');
    });
  }
});

describe('getFullPath (macOS)', () => {
  if (isWin) {
    // Exercise getFullPath's darwin branch on Windows: fresh-import pty-manager
    // with the platform seam pinned to macOS (isWin/pathSep are read at module
    // load), the login-shell probe mocked through child_process, $SHELL/$PATH
    // stubbed, and os.homedir mocked to '/mock/home'. Mirrors the Windows
    // registry suite above: feed execSync output, assert the resulting PATH.
    // Static import cannot work here: the platform constants are baked at
    // module load, so the darwin build of pty-manager needs a fresh module
    // registry (test-case exception to the static-import rule).
    async function importDarwinPtyManager() {
      vi.resetModules();
      vi.doMock('./platform', async (importOriginal) => ({
        ...(await importOriginal<typeof PlatformModule>()),
        isWin: false,
        isMac: true,
        isLinux: false,
        pathSep: ':',
        whichCmd: 'which',
        utf8LocaleEnv: { LC_CTYPE: 'UTF-8' },
      }));
      const cp = await import('child_process');
      const pm = await import('./pty-manager');
      return { pm, execSync: vi.mocked(cp.execSync) };
    }

    afterEach(() => {
      vi.doUnmock('./platform');
      vi.resetModules();
      vi.unstubAllEnvs();
      // The child_process mock instance survives resetModules (the factory
      // result is cached), so restore its factory default for the suites
      // that run on the statically-imported pty-manager.
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
    });

    beforeEach(() => {
      mockNvmDefaultNodeBinDir.mockReturnValue(null);
      vi.stubEnv('SHELL', '/bin/zsh');
      vi.stubEnv('PATH', '/usr/bin:/bin');
    });

    it('parses PATH from output with plugin garbage around the marker block', async () => {
      const { pm, execSync } = await importDarwinPtyManager();
      execSync.mockImplementation(() =>
        'p10k instant prompt noise\n' +
        '\x1b[?2004h__VY_PATH_BEGIN__/opt/homebrew/bin:/usr/local/bin__VY_PATH_END__\n' +
        'trailing zshrc chatter\n',
      );
      expect(pm.getFullPath()).toBe('/opt/homebrew/bin:/usr/local/bin');
    });

    it('invokes $SHELL with -ilc and the marker echo (regression guard: do not drop -i)', async () => {
      const { pm, execSync } = await importDarwinPtyManager();
      execSync.mockReturnValue('__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__\n');
      expect(pm.getFullPath()).toBe('/usr/bin');
      expect(execSync).toHaveBeenCalledTimes(1);
      const [cmd, opts] = execSync.mock.calls[0] as unknown as [string, { env: Record<string, string | undefined>; timeout: number }];
      expect(cmd).toBe('/bin/zsh -ilc \'echo "__VY_PATH_BEGIN__${PATH}__VY_PATH_END__"\'');
      // A Finder/Dock-launched app must probe with HOME pinned to the real home
      // dir (os seam: '/mock/home') so .zshrc/.zprofile resolve.
      expect(opts.env.HOME).toBe('/mock/home');
      expect(opts.timeout).toBe(8000);
    });

    it('falls back to inherited PATH + well-known dirs + nvm bin when the login shell probe fails', async () => {
      const { pm, execSync } = await importDarwinPtyManager();
      execSync.mockImplementation(() => {
        throw new Error('login shell unavailable');
      });
      mockNvmDefaultNodeBinDir.mockReturnValue('/mock/home/.nvm/versions/node/v24.11.1/bin');
      const result = pm.getFullPath();
      expect(result.startsWith('/usr/bin:/bin:')).toBe(true);
      for (const dir of [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/local/sbin',
        '/opt/homebrew/sbin',
        path.join('/mock/home', '.local', 'bin'),
        path.join('/mock/home', '.npm-global', 'bin'),
        '/mock/home/.nvm/versions/node/v24.11.1/bin',
      ]) {
        expect(result).toContain(dir);
      }
    });

    it('omits the nvm bin dir from the fallback PATH when nvm is not installed', async () => {
      const { pm, execSync } = await importDarwinPtyManager();
      execSync.mockImplementation(() => {
        throw new Error('login shell unavailable');
      });
      const result = pm.getFullPath();
      expect(result).not.toContain('.nvm');
      expect(result).toContain('/opt/homebrew/bin');
    });

    it('caches both successful and fallback results; resetPathCache allows retry', async () => {
      const { pm, execSync } = await importDarwinPtyManager();
      execSync.mockImplementation(() => {
        throw new Error('timeout');
      });
      pm.getFullPath(); // probe fails → fallback, cached
      pm.getFullPath();
      expect(execSync).toHaveBeenCalledTimes(1);

      pm.resetPathCache();
      execSync.mockImplementation(() => '__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__');
      expect(pm.getFullPath()).toBe('/usr/bin');
      expect(execSync).toHaveBeenCalledTimes(2);
    });

    return;
  }

  beforeEach(() => {
    resetPathCache();
    mockNvmDefaultNodeBinDir.mockReturnValue(null);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('parses PATH from output with plugin garbage around the marker block', () => {
    mockExecSync.mockImplementation(() =>
      'p10k instant prompt noise\n' +
      '\x1b[?2004h__VY_PATH_BEGIN__/opt/homebrew/bin:/usr/local/bin__VY_PATH_END__\n' +
      'trailing zshrc chatter\n',
    );
    const result = getFullPath();
    expect(result).toBe('/opt/homebrew/bin:/usr/local/bin');
  });

  it('invokes the shell with -ilc (regression guard: do not drop -i)', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      expect(cmd).toContain('-ilc');
      return '__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__\n';
    });
    getFullPath();
    expect(mockExecSync).toHaveBeenCalled();
  });

  it('caches both successful and fallback results; resetPathCache allows retry', () => {
    mockExecSync.mockImplementation(() => { throw new Error('timeout'); });
    getFullPath();
    getFullPath();
    expect(mockExecSync).toHaveBeenCalledTimes(1);

    resetPathCache();
    mockExecSync.mockImplementation(() => '__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__');
    const second = getFullPath();
    expect(second).toBe('/usr/bin');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('appends nvm default node bin to the fallback PATH when discoverable', () => {
    mockNvmDefaultNodeBinDir.mockReturnValue('/mock/home/.nvm/versions/node/v24.11.1/bin');
    mockExecSync.mockImplementation(() => { throw new Error('no shell'); });
    const result = getFullPath();
    expect(result).toContain('/mock/home/.nvm/versions/node/v24.11.1/bin');
    expect(result).toContain('/opt/homebrew/bin');
  });
});

describe('POSIX shell defaults and Linux cwd probing (mocked platform)', () => {
  // Platform constants are baked at module load, so the linux/darwin builds
  // need a fresh module registry with './platform' pinned — same seam as the
  // darwin getFullPath suite above (test-case exception to static imports).
  async function importPosixPtyManager(platform: 'linux' | 'darwin') {
    vi.resetModules();
    vi.doMock('./platform', async (importOriginal) => ({
      ...(await importOriginal<typeof PlatformModule>()),
      isWin: false,
      isMac: platform === 'darwin',
      isLinux: platform === 'linux',
      pathSep: ':',
      whichCmd: 'which',
      utf8LocaleEnv: platform === 'darwin' ? { LC_CTYPE: 'UTF-8' } : { LANG: 'C.UTF-8' },
    }));
    // canonicalPath is host-path-sensitive (Windows path.resolve turns '/x'
    // into 'C:\x'); stub the seam so cwd assertions stay native.
    vi.doMock('./fs-utils', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./fs-utils')>()),
      canonicalPath: (p: string) => p,
    }));
    const cp = await import('child_process');
    const fsp = await import('fs');
    const pm = await import('./pty-manager');
    return {
      pm,
      execSync: vi.mocked(cp.execSync),
      execFile: vi.mocked(cp.execFile),
      readlinkSync: vi.mocked(fsp.readlinkSync),
      existsSync: vi.mocked(fsp.existsSync),
    };
  }

  afterEach(() => {
    vi.doUnmock('./platform');
    vi.doUnmock('./fs-utils');
    vi.resetModules();
    vi.unstubAllEnvs();
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
  });

  beforeEach(() => {
    vi.stubEnv('SHELL', '');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    mockNvmDefaultNodeBinDir.mockReturnValue(null);
  });

  it('probes /bin/sh on Linux when $SHELL is unset', async () => {
    const { pm, execSync } = await importPosixPtyManager('linux');
    execSync.mockReturnValue('__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__\n');
    expect(pm.getFullPath()).toBe('/usr/bin');
    expect(execSync.mock.calls[0][0]).toMatch(/^\/bin\/sh -ilc /);
  });

  it('keeps the /bin/zsh probe on macOS when $SHELL is unset', async () => {
    const { pm, execSync } = await importPosixPtyManager('darwin');
    execSync.mockReturnValue('__VY_PATH_BEGIN__/usr/bin__VY_PATH_END__\n');
    expect(pm.getFullPath()).toBe('/usr/bin');
    expect(execSync.mock.calls[0][0]).toMatch(/^\/bin\/zsh -ilc /);
  });

  it('spawns /bin/bash for the shell tab on Linux when $SHELL is unset and bash exists', async () => {
    const { pm, existsSync } = await importPosixPtyManager('linux');
    existsSync.mockImplementation((p) => String(p) === '/bin/bash');
    mockSpawn.mockReturnValue(createMockPtyProcess());
    pm.spawnShellPty('sh-bash', '/project', vi.fn(), vi.fn());
    expect(mockSpawn.mock.calls[0][0]).toBe('/bin/bash');
  });

  it('falls back to /bin/sh for the shell tab on Linux without bash', async () => {
    const { pm, existsSync } = await importPosixPtyManager('linux');
    existsSync.mockReturnValue(false);
    mockSpawn.mockReturnValue(createMockPtyProcess());
    pm.spawnShellPty('sh-plain', '/project', vi.fn(), vi.fn());
    expect(mockSpawn.mock.calls[0][0]).toBe('/bin/sh');
  });

  it('keeps /bin/zsh for the shell tab on macOS when $SHELL is unset', async () => {
    const { pm } = await importPosixPtyManager('darwin');
    mockSpawn.mockReturnValue(createMockPtyProcess());
    pm.spawnShellPty('sh-mac', '/project', vi.fn(), vi.fn());
    expect(mockSpawn.mock.calls[0][0]).toBe('/bin/zsh');
  });

  it('reads /proc/<pid>/cwd for getPtyCwd on Linux and never spawns lsof', async () => {
    const { pm, execFile, readlinkSync } = await importPosixPtyManager('linux');
    // mockClear (clearAllMocks) does not drop queued mockImplementationOnce
    // entries; suites that early-return on this host can leave stale ones.
    execFile.mockReset();
    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 1000;
    mockSpawn.mockReturnValue(proc);
    pm.spawnShellPty('cwd-linux', '/project', vi.fn(), vi.fn());

    // pgrep: pid 1000 has child 2000, which has no children of its own.
    execFile
      .mockImplementationOnce(((_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
        cb(null, args[1] === '1000' ? '2000\n' : '');
        return undefined as never;
      }) as never)
      .mockImplementationOnce(((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
        cb(new Error('no children'), '');
        return undefined as never;
      }) as never);
    readlinkSync.mockReturnValue('/some/worktree/path');

    expect(await pm.getPtyCwd('cwd-linux')).toBe('/some/worktree/path');
    expect(readlinkSync).toHaveBeenCalledWith('/proc/2000/cwd');
    expect(execFile.mock.calls.every(([cmd]) => cmd !== 'lsof')).toBe(true);
  });

  it('returns null for getPtyCwd on Linux when the /proc readlink fails', async () => {
    const { pm, execFile, readlinkSync } = await importPosixPtyManager('linux');
    execFile.mockReset();

    const proc = createMockPtyProcess();
    (proc as unknown as { pid: number }).pid = 1000;
    mockSpawn.mockReturnValue(proc);
    pm.spawnShellPty('cwd-fail', '/project', vi.fn(), vi.fn());

    execFile.mockImplementationOnce(((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => {
      cb(new Error('no children'), '');
      return undefined as never;
    }) as never);
    readlinkSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(await pm.getPtyCwd('cwd-fail')).toBeNull();
    expect(execFile.mock.calls.every(([cmd]) => cmd !== 'lsof')).toBe(true);
  });
});

describe('resolveWindowsShell', () => {
  if (isWin) {
    it('wraps .cmd files with cmd.exe /c', () => {
      const result = resolveWindowsShell('C:\\Users\\test\\npm\\claude.cmd', ['--help']);
      expect(result).toEqual({
        shell: 'cmd.exe',
        args: ['/c', 'C:\\Users\\test\\npm\\claude.cmd', '--help'],
      });
    });

    it('wraps .bat files with cmd.exe /c', () => {
      const result = resolveWindowsShell('C:\\tools\\run.bat', ['-v']);
      expect(result).toEqual({
        shell: 'cmd.exe',
        args: ['/c', 'C:\\tools\\run.bat', '-v'],
      });
    });

    it('wraps .ps1 files with powershell.exe', () => {
      const result = resolveWindowsShell('C:\\scripts\\tool.ps1', ['arg1']);
      expect(result).toEqual({
        shell: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\scripts\\tool.ps1', 'arg1'],
      });
    });

    it('passes .exe files through unchanged', () => {
      const result = resolveWindowsShell('C:\\tools\\claude.exe', ['--help']);
      expect(result).toEqual({
        shell: 'C:\\tools\\claude.exe',
        args: ['--help'],
      });
    });

    it('wraps bare binary names with cmd.exe /c', () => {
      const result = resolveWindowsShell('claude', ['--help']);
      expect(result).toEqual({
        shell: 'cmd.exe',
        args: ['/c', 'claude', '--help'],
      });
    });

    it('wraps absolute extensionless paths with cmd.exe /c', () => {
      const result = resolveWindowsShell('C:\\tools\\claude', ['--help']);
      expect(result).toEqual({
        shell: 'cmd.exe',
        args: ['/c', 'C:\\tools\\claude', '--help'],
      });
    });

  // Regression guard for the cmd.exe argv-injection finding.
  //
  // node-pty (windowsPtyAgent.argsToCommandLine) wraps an argument in double
  // quotes only when it contains a space or a tab. Before the fix, a
  // whitespace-free token carrying `&` / `|` / `<` / `>` / `^` — or a `"` that
  // closes cmd's quoted section early — reached cmd.exe raw and was interpreted,
  // so an attacker-controlled argument could run a second command.

  /** Faithful model of node-pty's per-argument quoting. */
  const nodePtyCommandLine = (shell: string, args: string[]): string =>
    [shell, ...args]
      .map((a) => {
        const needsQuotes = /[\s\t]/.test(a);
        const enclosed = a.startsWith('"') && a.endsWith('"');
        return needsQuotes && !enclosed ? `"${a.replace(/"/g, '\\"')}"` : a;
      })
      .join(' ');

  /**
   * Everything cmd.exe would see outside a quoted region. cmd toggles its quoted
   * state on every `"` and honours no escape for it, so a backslash before a
   * quote does NOT keep the region closed — modelling that correctly is the whole
   * point of these tests.
   */
  const unquotedContent = (line: string): string => {
    let out = '';
    let inQuotes = false;
    for (const c of line) {
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes) out += c;
    }
    return out;
  };

  it('pre-quotes a whitespace-free arg carrying cmd metacharacters', () => {
    const r = resolveWindowsShell('C:\\tools\\claude.cmd', ['--append-system-prompt=a&calc.exe']);
    expect(r.args[2]).toBe('"--append-system-prompt=a&calc.exe"');
  });

  it('leaves no cmd metacharacter outside quotes in the final command line', () => {
    for (const payload of ['a&calc.exe', 'a&&b', 'a|calc.exe', 'a||b', 'a>b.txt', 'a^&b']) {
      const r = resolveWindowsShell('C:\\tools\\claude.cmd', [payload]);
      const bare = unquotedContent(nodePtyCommandLine(r.shell, r.args));
      expect(bare).not.toMatch(/[&|<>^]/);
    }
  });

  // cmd.exe has no representation for a literal double quote, so the argument is
  // refused rather than escaped into an injectable command line.
  it('rejects an argument containing a double quote', () => {
    expect(() => resolveWindowsShell('C:\\tools\\claude.cmd', ['x"y&calc.exe'])).toThrow(/double quote/);
  });

  it('quotes the binary path itself when it carries a metacharacter', () => {
    const r = resolveWindowsShell('C:\\tools\\a&b.cmd', ['--help']);
    const line = nodePtyCommandLine(r.shell, r.args);
    expect(unquotedContent(line)).not.toContain('&');
  });

  it('does not over-quote metachar-free args', () => {
    const r = resolveWindowsShell('C:\\tools\\claude.cmd', ['--help', 'plain.txt']);
    expect(r.args).toEqual(['/c', 'C:\\tools\\claude.cmd', '--help', 'plain.txt']);
  });
  } else {
    it('passes through unchanged on non-Windows', () => {
      const result = resolveWindowsShell('/usr/local/bin/claude', ['--help']);
      expect(result).toEqual({
        shell: '/usr/local/bin/claude',
        args: ['--help'],
      });
    });
  }
});

describe('withUtf8Locale (issues #157, #160)', () => {
  // Only one branch runs per platform; spelling the delta once keeps each test
  // to a single expectation.
  const added = isWin ? {} : isMac ? { LC_CTYPE: 'UTF-8' } : { LANG: 'C.UTF-8' };

  it('fills in a UTF-8 locale when the environment carries none', () => {
    expect(withUtf8Locale({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin', ...added });
  });

  it.each(['LC_ALL', 'LC_CTYPE', 'LANG'])('leaves a user-set %s untouched', (key) => {
    const env = { PATH: '/usr/bin', [key]: 'ru_RU.ISO8859-5' };

    expect(withUtf8Locale(env)).toEqual(env);
  });

  it.each(['C', 'POSIX', 'c', 'posix'])('overrides a bare %s locale', (locale) => {
    expect(withUtf8Locale({ LANG: locale })).toEqual({ LANG: locale, ...added });
  });

  // POSIX precedence: LC_ALL wins, so the session really is in the C locale.
  it('overrides a charset-naming LANG when LC_ALL is bare C', () => {
    const env = { LC_ALL: 'C', LANG: 'ru_RU.UTF-8' };

    expect(withUtf8Locale(env)).toEqual({ ...env, ...added });
  });

  it('does not mutate the env it is given', () => {
    const env = { PATH: '/usr/bin' };

    withUtf8Locale(env);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
