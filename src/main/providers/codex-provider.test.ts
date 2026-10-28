import { vi } from 'vitest';
import * as path from 'path';
import { isWin } from '../platform';
import { PassThrough } from 'stream';
import { once } from 'events';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  createReadStream: vi.fn(),
  promises: { stat: vi.fn() },
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../pty-manager', () => ({
  getFullPath: vi.fn(() => isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin'),
  getFullPathAsync: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../codex-config', () => ({
  getCodexConfig: vi.fn(async () => ({ mcpServers: [], agents: [], skills: [], commands: [] })),
}));

vi.mock('../config-watcher', () => ({
  startConfigWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
}));

vi.mock('../codex-session-watcher', () => ({
  startCodexSessionWatcher: vi.fn(),
  stopCodexSessionWatcher: vi.fn(),
  registerPendingCodexSession: vi.fn(),
  unregisterCodexSession: vi.fn(),
}));

vi.mock('../codex-hooks', () => ({
  installCodexHooks: vi.fn(),
  validateCodexHooks: vi.fn(() => ({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} })),
  cleanupCodexHooks: vi.fn(),
  SESSION_ID_VAR: 'FINEVIBE_SESSION_ID',
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { CodexProvider, _resetCachedPath, _resetHookValidationCache } from './codex-provider';
import { getCodexConfig } from '../codex-config';
import { startConfigWatcher, stopConfigWatcher } from '../config-watcher';
import { installCodexHooks, validateCodexHooks, cleanupCodexHooks } from '../codex-hooks';
import { stopCodexSessionWatcher } from '../codex-session-watcher';
import { invalidateBinaryCache } from './resolve-binary';
import { startCodexSessionWatcher, registerPendingCodexSession } from '../codex-session-watcher';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockStat = vi.mocked(fs.promises.stat);
const mockCreateReadStream = vi.mocked(fs.createReadStream);
const mockExecSync = vi.mocked(execSync);
const fileStat = { isFile: () => true } as fs.Stats;
const mockGetCodexConfig = vi.mocked(getCodexConfig);
const mockStartConfigWatcher = vi.mocked(startConfigWatcher);
const mockStopConfigWatcher = vi.mocked(stopConfigWatcher);
const mockInstallCodexHooks = vi.mocked(installCodexHooks);
const mockValidateCodexHooks = vi.mocked(validateCodexHooks);
const mockCleanupCodexHooks = vi.mocked(cleanupCodexHooks);
const mockStopCodexSessionWatcher = vi.mocked(stopCodexSessionWatcher);
const mockStartCodexSessionWatcher = vi.mocked(startCodexSessionWatcher);
const mockRegisterPendingCodexSession = vi.mocked(registerPendingCodexSession);

let provider: CodexProvider;

beforeEach(() => {
  vi.clearAllMocks();
  // Order-independence: clearAllMocks keeps IMPLEMENTATIONS - a shuffled
  // predecessor's statSync/execSync probe answers leaked into this case.
  mockStatSync.mockReset();
  mockExecSync.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  _resetCachedPath();
  _resetHookValidationCache();
  invalidateBinaryCache();
  mockValidateCodexHooks.mockReturnValue({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });
  provider = new CodexProvider();
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('codex');
    expect(provider.meta.displayName).toBe('Codex CLI');
    expect(provider.meta.binaryName).toBe('codex');
  });

  it('has sessionResume and hookStatus capabilities enabled', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(false);
    expect(caps.contextWindow).toBe(false);
    expect(caps.hookStatus).toBe(true);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(false);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.systemPromptInjection).toBe(true);
    // planModeArg stays UNSET — VERIFICATION-PENDING: no verified TUI startup
    // flag exists (see provider capabilities comment); the live probe requires an
    // installed codex CLI, absent on the 2026-10-21 probe machine.
    expect(caps.planModeArg).toBeUndefined();
  });

  it('has defaultContextWindowSize of 200,000', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(200_000);
  });
});

describe('resolveBinaryPath', () => {
  const firstCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'codex.cmd')
    : '/usr/local/bin/codex';

  it('returns candidate path when statSync finds a file', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
  });

  it(`falls back to ${isWin ? 'where' : 'which'} codex when no candidate exists`, () => {
    mockExecSync.mockReturnValue('/some/other/path/codex\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/codex');
  });

  it('falls back to bare "codex" when both candidate and which fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.resolveBinaryPath()).toBe('codex');
  });

  it('caches result on subsequent calls while the binary exists', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    provider.resolveBinaryPath();
    const probesAfterFirst = mockExecSync.mock.calls.length;
    // P2-26: cache hit = one stat, zero subprocess re-probes.
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
    expect(mockExecSync).toHaveBeenCalledTimes(probesAfterFirst);
  });

  it('re-resolves when the cached binary disappears', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    provider.resolveBinaryPath();
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mockExecSync.mockReturnValue('/some/other/path/codex\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/codex');
  });
});

describe('validatePrerequisites', () => {
  const validateCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'codex.cmd')
    : '/opt/homebrew/bin/codex';

  it('returns ok when binary found via statSync', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === validateCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns ok when binary found via which', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('/resolved/codex\n' as any);
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns not ok when binary not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.validatePrerequisites()).toBe(false);
  });
});

describe('buildEnv', () => {
  it('sets PATH to the augmented PATH', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.PATH).toBe(isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin');
  });

  it('sets FINEVIBE_SESSION_ID to the session ID', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.FINEVIBE_SESSION_ID).toBe('sess-123');
  });

  it('strips an inherited CODEX_HOME and preserves other env vars', () => {
    // Hooks are installed at, and the rollout watcher scans, the hardcoded
    // ~/.codex: a relocated home silently loses .sessionid, statusLine,
    // titles, archive and resume.
    const env = provider.buildEnv('sess-123', { CODEX_HOME: '/work/codex', codex_home: '/other', OTHER: 'val' });
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.codex_home).toBeUndefined();
    expect(env.OTHER).toBe('val');
  });
});

describe('buildArgs', () => {
  it('returns ["resume", id] when isResume=true with cliSessionId', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '' });
    expect(args).toEqual(['resume', 'sid-1']);
  });

  it('returns [] when isResume=false with cliSessionId (no continue-in-place)', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('returns [] when cliSessionId is null', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('passes initialPrompt as positional arg when not resuming', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'fix the bug' });
    expect(args).toEqual(['fix the bug']);
  });

  it('passes the prompt as trailing positional when resuming', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '', initialPrompt: 'fix the bug' });
    expect(args).toEqual(['resume', 'sid-1', 'fix the bug']);
  });

  it('splits extraArgs on whitespace and appends', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--model gpt-4o  --full-auto' });
    expect(args).toEqual(['--model', 'gpt-4o', '--full-auto']);
  });

  it('combines resume args and extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '--model gpt-4o' });
    expect(args).toEqual(['resume', 'sid-1', '--model', 'gpt-4o']);
  });

  it('tokenizes quoted extra args (spaces stay inside one argument)', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--model "my model"' });
    expect(args).toEqual(['--model', 'my model']);
  });

  it('preserves empty quoted extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--flag ""' });
    expect(args).toEqual(['--flag', '']);
  });

  it('passes systemPrompt via -c developer_instructions config override', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' });
    expect(args).toEqual(['-c', 'developer_instructions=You are the CMO.']);
  });
});

describe('indexTranscript', () => {
  // CodexProvider is a singleton and session-deep-search indexes up to
  // TRANSCRIPT_IO_CONCURRENCY transcripts through it at once, so an index cwd
  // kept on the instance is shared state: in the interleaving below the second
  // run's consumer reset wiped the first run's cwd, and run A returned file
  // B's cwd — which the search index persists, so the session palette then
  // opens/resumes the transcript in the wrong repo.
  it('returns each transcript\'s own cwd when two indexings interleave on one provider', async () => {
    const fileA = '/mock/home/sessions/2026-03-28/rollout-a.jsonl';
    const fileB = '/mock/home/sessions/2026-03-28/rollout-b.jsonl';
    const meta = (cwd: string) => JSON.stringify({ type: 'session_meta', payload: { cwd } });
    const userMsg = (text: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text }] } });
    const streamA = new PassThrough();
    const streamB = new PassThrough();
    mockStat.mockResolvedValue({ size: 256 } as fs.Stats);
    mockCreateReadStream.mockReturnValueOnce(streamA as unknown as fs.ReadStream);
    mockCreateReadStream.mockReturnValueOnce(streamB as unknown as fs.ReadStream);

    // Gate on the stream's own signals, never the clock: 'resume' fires once
    // the provider's readline has attached its (earlier-registered) data
    // listener, so a write issued after it reaches the provider's consumer
    // before this continuation resumes — every `await` below lands exactly
    // after that file's session_meta has been consumed.
    const runA = provider.indexTranscript(fileA);
    await once(streamA, 'resume');
    const deliveredA = once(streamA, 'data');
    streamA.write(`${meta('/repo/a')}\n${userMsg('alpha prompt')}\n`);
    await deliveredA;

    const runB = provider.indexTranscript(fileB);
    await once(streamB, 'resume');
    const deliveredB = once(streamB, 'data');
    streamB.write(`${meta('/repo/b')}\n${userMsg('beta prompt')}\n`);
    await deliveredB;

    streamA.end();
    const resA = await runA;
    streamB.end();
    const resB = await runB;

    expect(resA).toEqual({ text: 'alpha prompt', cwd: '/repo/a' });
    expect(resB).toEqual({ text: 'beta prompt', cwd: '/repo/b' });
  });
});

describe('getShiftEnterSequence', () => {
  it('returns null (Codex uses Ctrl+J instead)', () => {
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});

describe('hooks integration', () => {
  it('installHooks delegates to installCodexHooks', async () => {
    await provider.installHooks();
    expect(mockInstallCodexHooks).toHaveBeenCalled();
  });

  it('validateSettings delegates to validateCodexHooks', () => {
    const result = provider.validateSettings();
    expect(mockValidateCodexHooks).toHaveBeenCalled();
    expect(result).toEqual({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });
  });

  it('cleanup stops the config watcher, the hooks and the rollout session watcher', () => {
    provider.cleanup();
    expect(mockStopConfigWatcher).toHaveBeenCalled();
    expect(mockCleanupCodexHooks).toHaveBeenCalled();
    // The rollout watcher is a recursive fs.watch plus a 2s interval with no
    // other production caller: without this it survives quit, and a scan
    // armed inside its 500ms arming window fires after cleanupAll() deleted
    // STATUS_DIR and recreates os.tmpdir()/finevibe with a .sessionid file.
    expect(mockStopCodexSessionWatcher).toHaveBeenCalled();
  });

  it('reinstallSettings delegates to installCodexHooks', () => {
    provider.reinstallSettings();
    expect(mockInstallCodexHooks).toHaveBeenCalled();
  });
});

describe('onSessionStarted hooks validation cache', () => {
  const win = { id: 1 } as any;

  it('does not re-validate hooks synchronously on the second launch within the TTL', () => {
    provider.onSessionStarted('s1', '/p1', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(1);

    provider.onSessionStarted('s2', '/p2', win);
    // The launch path must not run the file validation a second time (audit P3-5).
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(1);
    expect(mockStartCodexSessionWatcher).not.toHaveBeenCalled();
  });

  it('reuses the cached missing-hooks verdict for the watcher fallback', () => {
    mockValidateCodexHooks.mockReturnValue({ statusLine: 'finevibe', hooks: 'missing', hookDetails: {} });
    provider.onSessionStarted('s1', '/p1', win);
    provider.onSessionStarted('s2', '/p2', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(1);
    // Every hookless session still registers with the rollout watcher.
    expect(mockStartCodexSessionWatcher).toHaveBeenCalledTimes(2);
    expect(mockRegisterPendingCodexSession).toHaveBeenCalledWith('s1', '/p1');
    expect(mockRegisterPendingCodexSession).toHaveBeenCalledWith('s2', '/p2');
  });

  it('reinstallSettings clears the cache so the next launch re-validates', () => {
    provider.onSessionStarted('s1', '/p1', win);
    provider.reinstallSettings();
    provider.onSessionStarted('s2', '/p2', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(2);
  });

  it('installHooks clears the cache', async () => {
    provider.onSessionStarted('s1', '/p1', win);
    await provider.installHooks();
    provider.onSessionStarted('s2', '/p2', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(2);
  });

  it('validateSettings refreshes the cache with a fresh result', () => {
    provider.validateSettings();
    provider.onSessionStarted('s1', '/p1', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(1);
  });

  it('cleanup clears the cache', () => {
    provider.onSessionStarted('s1', '/p1', win);
    provider.cleanup();
    provider.onSessionStarted('s2', '/p2', win);
    expect(mockValidateCodexHooks).toHaveBeenCalledTimes(2);
  });
});

describe('other methods', () => {
  it('getConfig delegates to codex config reader', async () => {
    const config = { mcpServers: [{ name: 'a', url: 'b', status: 'configured', scope: 'user' as const, filePath: '/x' }], agents: [], skills: [], commands: [] };
    mockGetCodexConfig.mockResolvedValueOnce(config);
    await expect(provider.getConfig('/some/path')).resolves.toEqual(config);
    expect(mockGetCodexConfig).toHaveBeenCalledWith('/some/path');
  });

  it('installStatusScripts does not throw', () => {
    expect(() => provider.installStatusScripts()).not.toThrow();
  });

  it('starts a codex config watcher', () => {
    const win = { id: 1 } as any;
    provider.startConfigWatcher(win, '/project');
    expect(mockStartConfigWatcher).toHaveBeenCalledWith(win, '/project', 'codex');
  });
});
