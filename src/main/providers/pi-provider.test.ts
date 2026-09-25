import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  promises: { readFile: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home' }));
vi.mock('../pty-manager', () => ({ getFullPath: () => '/usr/local/bin:/usr/bin' }));
vi.mock('./resolve-binary', () => ({ resolveBinary: vi.fn(), validateBinaryExists: vi.fn() }));
vi.mock('../pi-session-watcher', () => ({
  startPiSessionWatcher: vi.fn(),
  registerPendingPiSession: vi.fn(),
  unregisterPiSession: vi.fn(),
  stopPiSessionWatcher: vi.fn(),
}));

import * as fs from 'fs';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { startPiSessionWatcher, registerPendingPiSession, unregisterPiSession } from '../pi-session-watcher';
import { PiProvider, _resetCachedPath } from './pi-provider';

const mockReadFile = vi.mocked(fs.promises.readFile);
const mockResolveBinary = vi.mocked(resolveBinary);
const mockValidateBinaryExists = vi.mocked(validateBinaryExists);
const mockStartPiSessionWatcher = vi.mocked(startPiSessionWatcher);
const mockRegisterPendingPiSession = vi.mocked(registerPendingPiSession);
const mockUnregisterPiSession = vi.mocked(unregisterPiSession);

let provider: PiProvider;

beforeEach(() => {
  vi.clearAllMocks();
  _resetCachedPath();
  provider = new PiProvider();
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('pi');
    expect(provider.meta.displayName).toBe('Pi');
    expect(provider.meta.binaryName).toBe('pi');
  });

  it('declares resume + system-prompt injection, no hooks/cost/context', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(false);
    expect(caps.contextWindow).toBe(false);
    expect(caps.hookStatus).toBe(false);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(false);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.systemPromptInjection).toBe(true);
    expect(caps.planModeArg).toBeUndefined();
  });

  it('has defaultContextWindowSize of 200,000', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(200_000);
  });
});

describe('resolveBinaryPath / validatePrerequisites', () => {
  it('delegates to the binary helpers with "pi"', () => {
    mockResolveBinary.mockReturnValue('/bin/pi');
    expect(provider.resolveBinaryPath()).toBe('/bin/pi');
    expect(mockResolveBinary).toHaveBeenCalledWith('pi', expect.anything());
    mockValidateBinaryExists.mockReturnValue(true);
    expect(provider.validatePrerequisites()).toBe(true);
    expect(mockValidateBinaryExists).toHaveBeenCalledWith('pi');
  });
});

describe('buildEnv', () => {
  it('sets PATH to the augmented PATH and preserves existing vars', () => {
    const env = provider.buildEnv('sess-1', { FOO: 'bar' });
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.FOO).toBe('bar');
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it('sets PI_CODING_AGENT_DIR when a configDir is given', () => {
    const env = provider.buildEnv('sess-1', {}, { configDir: '/profiles/work' });
    expect(env.PI_CODING_AGENT_DIR).toBe('/profiles/work');
  });
});

describe('buildArgs', () => {
  it('returns [] for a fresh session with no extras', () => {
    expect(provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '' })).toEqual([]);
  });

  it('returns ["--session", id] when resuming', () => {
    expect(provider.buildArgs({ cliSessionId: 'sid-1', isResume: true, extraArgs: '' }))
      .toEqual(['--session', 'sid-1']);
  });

  it('omits --session when isResume=false', () => {
    expect(provider.buildArgs({ cliSessionId: 'sid-1', isResume: false, extraArgs: '' })).toEqual([]);
  });

  it('splits extraArgs on whitespace and appends', () => {
    expect(provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '--provider olla  --model thinking' }))
      .toEqual(['--provider', 'olla', '--model', 'thinking']);
  });

  it('appends --append-system-prompt when systemPrompt is provided', () => {
    expect(provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' }))
      .toEqual(['--append-system-prompt', 'You are the CMO.']);
  });

  it('appends initialPrompt as a positional message arg', () => {
    expect(provider.buildArgs({ cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'Fix the bug' }))
      .toEqual(['Fix the bug']);
  });

  it('combines resume, extraArgs, systemPrompt, and initialPrompt', () => {
    expect(provider.buildArgs({ cliSessionId: 'sid-1', isResume: true, extraArgs: '--model x', systemPrompt: 'sp', initialPrompt: 'go' }))
      .toEqual(['--session', 'sid-1', '--model', 'x', '--append-system-prompt', 'sp', 'go']);
  });
});

describe('no-op lifecycle methods', () => {
  it('installHooks resolves without side effects', async () => {
    await expect(provider.installHooks()).resolves.toBeUndefined();
  });

  it('installStatusScripts / cleanup / reinstallSettings do not throw', () => {
    expect(() => provider.installStatusScripts()).not.toThrow();
    expect(() => provider.cleanup()).not.toThrow();
    expect(() => provider.reinstallSettings()).not.toThrow();
  });

  it('validateSettings reports complete (Pi has no hooks or status line)', () => {
    expect(provider.validateSettings()).toEqual({ statusLine: 'vibeyard', hooks: 'complete', hookDetails: {} });
  });

  it('getShiftEnterSequence returns null', () => {
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});

describe('session id discovery hooks', () => {
  it('onSessionStarted starts the watcher and registers the pending session', () => {
    provider.onSessionStarted!('ui-1', '/proj', {} as any, '/profiles/work');
    expect(mockStartPiSessionWatcher).toHaveBeenCalled();
    expect(mockRegisterPendingPiSession).toHaveBeenCalledWith('ui-1', '/proj', '/profiles/work');
  });

  it('onSessionExited unregisters the pending session', () => {
    provider.onSessionExited!('ui-1');
    expect(mockUnregisterPiSession).toHaveBeenCalledWith('ui-1');
  });
});

describe('getConfig', () => {
  it('surfaces MCP servers from mcp.json', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      mcpServers: { agentmemory: { command: 'npx', args: ['-y', 'pkg'] } },
    }) as any);
    const config = await provider.getConfig('/some/path');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].name).toBe('agentmemory');
    expect(config.mcpServers[0].url).toBe('npx -y pkg');
    expect(config.mcpServers[0].scope).toBe('user');
    expect(config.agents).toEqual([]);
  });

  it('skips a null server entry without wiping the valid ones', async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      mcpServers: { good: { command: 'npx', args: ['-y', 'pkg'] }, broken: null },
    }) as any);
    const config = await provider.getConfig('/some/path');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].name).toBe('good');
  });

  it('returns an empty config when mcp.json is missing', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(provider.getConfig('/some/path')).resolves.toEqual({
      mcpServers: [], agents: [], skills: [], commands: [],
    });
  });
});
