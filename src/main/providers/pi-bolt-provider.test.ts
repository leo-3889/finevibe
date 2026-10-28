import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    // discoverTranscripts(): listLaunchSessionDirs() lists the launch base and
    // lstats each entry (a fresh mtime = inside the retention window).
    readdir: vi.fn(async () => [] as string[]),
    lstat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() })),
  },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home', tmpdir: () => '/mock/tmp' }));
vi.mock('../pty-manager', () => ({ getFullPath: () => '/usr/local/bin:/usr/bin' }));
vi.mock('./resolve-binary', () => ({ resolveBinary: vi.fn(), validateBinaryExists: vi.fn(), validateBinaryExistsAsync: vi.fn(async () => true) }));
vi.mock('../pi-bolt-session-watcher', () => ({
  startPiBoltSessionWatcher: vi.fn(),
  registerPendingPiBoltSession: vi.fn(),
  unregisterPiBoltSession: vi.fn(),
  stopPiBoltSessionWatcher: vi.fn(),
}));
vi.mock('./pi-compatible-transcripts', () => ({
  createCompatibleTranscriptModule: (dir: string) => ({
    agentDir: (configDir?: string) => configDir ?? dir,
    sessionsRoot: (configDir?: string) => require('path').join(configDir ?? dir, 'sessions'),
  }),
  findTranscriptPathSync: vi.fn(),
  findTranscriptPathInFlatDir: vi.fn(() => null),
  scanTranscriptSessionsRoot: vi.fn(),
  scanFlatSessionDir: vi.fn(async () => []),
  indexCompatibleTranscript: vi.fn(),
  readTranscriptStatusSync: vi.fn(),
  readSessionExitReasonSync: vi.fn(),
  readTranscriptTitleWithSessionInfoSync: vi.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { startPiBoltSessionWatcher, registerPendingPiBoltSession, unregisterPiBoltSession } from '../pi-bolt-session-watcher';
import { PiBoltProvider, _resetCachedPath } from './pi-bolt-provider';
import { findTranscriptPathSync, findTranscriptPathInFlatDir, scanTranscriptSessionsRoot, scanFlatSessionDir, readTranscriptStatusSync, readSessionExitReasonSync, readTranscriptTitleWithSessionInfoSync } from './pi-compatible-transcripts';
const mockReadFile = vi.mocked(fs.promises.readFile);
// The mock fs implements the read subset discovery uses; the real signatures
// are wider (PathLike). Type the handle against that subset.
const mockReaddir = vi.mocked(fs.promises.readdir as unknown as (p: string) => Promise<string[]>);
const mockWriteFileSync = vi.mocked(fs.writeFileSync as unknown as (p: string, data: string) => void);
const mockResolveBinary = vi.mocked(resolveBinary);
const mockValidateBinaryExists = vi.mocked(validateBinaryExists);
const mockStartPiBoltSessionWatcher = vi.mocked(startPiBoltSessionWatcher);
const mockRegisterPendingPiBoltSession = vi.mocked(registerPendingPiBoltSession);
const mockUnregisterPiBoltSession = vi.mocked(unregisterPiBoltSession);
const mockScanTranscriptSessionsRoot = vi.mocked(scanTranscriptSessionsRoot);
const mockScanFlatSessionDir = vi.mocked(scanFlatSessionDir);

/** userData served by test/electron-stub.ts — 'electron' is aliased to it in vitest.config.ts. */
const MOCK_USER_DATA = '/mock/app-path';
/** The exclusive per-launch session dir a UI session id maps to (launch-session-dir.ts). */
const sessionDirFor = (uiSessionId: string) => path.join(MOCK_USER_DATA, 'pi-bolt-sessions', uiSessionId);

let provider: PiBoltProvider;

beforeEach(() => {
  vi.clearAllMocks();
  _resetCachedPath();
  provider = new PiBoltProvider();
  // Defaults survive clearAllMocks, but re-arm them explicitly: the launch
  // base lists empty and the flat scan yields nothing unless a test prepends.
  mockReaddir.mockResolvedValue([]);
  mockScanFlatSessionDir.mockResolvedValue([]);
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('pi-bolt');
    expect(provider.meta.displayName).toBe('Pi-Bolt');
    expect(provider.meta.binaryName).toBe('pi-bolt');
  });

  it('declares resume + system-prompt injection, no hooks/cost/context', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(false);
    expect(caps.polledStatus).toBe(true);
    expect(caps.hookStatus).toBe(false);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(false);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.systemPromptInjection).toBe(true);
    // Pi-Bolt is a Pi fork: the author's explicit rejection of a built-in plan
    // mode (pi-mono blog + README) is inherited — the UI shows a disabled
    // checkbox with a tooltip.
    expect(caps.planModeArg).toBeUndefined();
  });

  it('has defaultContextWindowSize of 200,000', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(200_000);
  });
});

describe('resolveBinaryPath / validatePrerequisites', () => {
  it('delegates to the binary helpers with "pi-bolt"', () => {
    mockResolveBinary.mockReturnValue('/bin/pi-bolt');
    expect(provider.resolveBinaryPath()).toBe('/bin/pi-bolt');
    expect(mockResolveBinary).toHaveBeenCalledWith('pi-bolt', expect.anything());
    mockValidateBinaryExists.mockReturnValue(true);
    expect(provider.validatePrerequisites()).toBe(true);
    expect(mockValidateBinaryExists).toHaveBeenCalledWith('pi-bolt');
  });
});

describe('buildEnv', () => {
  it('sets PATH to the augmented PATH and preserves existing vars', () => {
    const env = provider.buildEnv('sess-1', { FOO: 'bar' });
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.FOO).toBe('bar');
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    // T2: the on-host hook block reads the session id from this var (inert
    // locally; forwarded into the remote command by remoteEnvPrefix).
    expect(env.FINEVIBE_SESSION_ID).toBe('sess-1');
  });

  it('sets PI_CODING_AGENT_DIR when a configDir is given', () => {
    const env = provider.buildEnv('sess-1', {}, { configDir: '/profiles/work' });
    expect(env.PI_CODING_AGENT_DIR).toBe('/profiles/work');
  });

  it('strips inherited profile and storage selectors case-insensitively', () => {
    const env = provider.buildEnv('sess-1', {
      Pi_Config_Dir: '/inherited',
      pi_profile: 'work',
      PI_CODING_AGENT_SESSION_DIR: '/sessions',
      SAFE: 'yes',
    });
    expect(env.PI_CONFIG_DIR).toBeUndefined();
    expect(env.Pi_Config_Dir).toBeUndefined();
    expect(env.PI_PROFILE).toBeUndefined();
    expect(env.pi_profile).toBeUndefined();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(env.SAFE).toBe('yes');
  });

  it('keeps the pinned profile when a configDir is given (default vs custom)', () => {
    const env = provider.buildEnv('sess-1', { PI_CODING_AGENT_DIR: '/inherited' }, { configDir: '/profiles/work' });
    expect(env.PI_CODING_AGENT_DIR).toBe('/profiles/work');
  });
});

describe('buildArgs', () => {
  const dir = sessionDirFor('sess-1');
  it('always starts with the exclusive per-launch --session-dir under the pi-bolt base', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '' }))
      .toEqual(['--session-dir', dir]);
    expect(dir).toContain(path.join('pi-bolt-sessions', 'sess-1'));
  });

  it('returns ["--session", id] after the session dir when resuming', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '' }))
      .toEqual(['--session-dir', dir, '--session', 'sid-1']);
  });

  it('omits --session when isResume=false', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: false, extraArgs: '' }))
      .toEqual(['--session-dir', dir]);
  });

  it('splits extraArgs on whitespace and appends', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--provider olla  --model thinking' }))
      .toEqual(['--session-dir', dir, '--provider', 'olla', '--model', 'thinking']);
  });

  it('appends --append-system-prompt when systemPrompt is provided', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' }))
      .toEqual(['--session-dir', dir, '--append-system-prompt', 'You are the CMO.']);
  });

  it('appends initialPrompt as a positional message arg', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'Fix the bug' }))
      .toEqual(['--session-dir', dir, 'Fix the bug']);
  });

  it('combines resume, extraArgs, systemPrompt, and initialPrompt', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '--model x', systemPrompt: 'sp', initialPrompt: 'go' }))
      .toEqual(['--session-dir', dir, '--session', 'sid-1', '--model', 'x', '--append-system-prompt', 'sp', 'go']);
  });

  it('tokenizes quoted extra args (spaces stay inside one argument)', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--append-system-prompt "Use concise replies"' }))
      .toEqual(['--session-dir', dir, '--append-system-prompt', 'Use concise replies']);
  });

  it('preserves empty quoted extra args', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--flag ""' }))
      .toEqual(['--session-dir', dir, '--flag', '']);
  });

  it('keeps a system prompt starting with option characters as one argument', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: '--foo bar' }))
      .toEqual(['--session-dir', dir, '--append-system-prompt', '--foo bar']);
  });

  it('keeps an initial prompt starting with option characters as one argument', () => {
    expect(provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: '--foo' }))
      .toEqual(['--session-dir', dir, '--foo']);
  });

  it('pins the --session-id established by onSessionStarted', () => {
    provider.onSessionStarted!('ui-9', '/proj', {} as any);
    expect(provider.buildArgs({ sessionId: 'ui-9', cliSessionId: null, isResume: false, extraArgs: '' }))
      .toEqual(['--session-dir', sessionDirFor('ui-9'), '--session-id', expect.any(String)]);
  });

  it('resumes the target established by onSessionResumed', () => {
    provider.onSessionResumed!('ui-10', '/proj', {} as any, undefined, 'cli-10');
    expect(provider.buildArgs({ sessionId: 'ui-10', cliSessionId: 'cli-10', isResume: true, extraArgs: '' }))
      .toEqual(['--session-dir', sessionDirFor('ui-10'), '--session', 'cli-10']);
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

  it('validateSettings reports complete (Pi-Bolt has no hooks or status line)', () => {
    expect(provider.validateSettings()).toEqual({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} });
  });

  it('getShiftEnterSequence returns null', () => {
    expect(provider.getShiftEnterSequence()).toBeNull();
  });
});

describe('session id discovery hooks', () => {
  it('onSessionStarted pins a generated id, writes pi-bolt launch meta, starts the watcher and registers the pending session', () => {
    provider.onSessionStarted!('ui-1', '/proj', {} as any, '/profiles/work');
    expect(mockStartPiBoltSessionWatcher).toHaveBeenCalled();
    expect(mockRegisterPendingPiBoltSession).toHaveBeenCalledWith('ui-1', '/proj', '/profiles/work', {
      sessionDir: sessionDirFor('ui-1'),
      knownCliId: expect.any(String),
    });
    // The launch sidecar pins the launch to the pi-bolt provider.
    const metaWrite = mockWriteFileSync.mock.calls.find((c) => String(c[0]).endsWith('.finevibe.json'));
    expect(metaWrite).toBeTruthy();
    expect(JSON.parse(String(metaWrite![1])).providerId).toBe('pi-bolt');
  });

  it('onSessionExited unregisters the pending session', () => {
    provider.onSessionExited!('ui-1');
    expect(mockUnregisterPiBoltSession).toHaveBeenCalledWith('ui-1');
  });

  it('onSessionResumed registers the known cli id as an adopted entry', () => {
    vi.mocked(findTranscriptPathInFlatDir).mockReturnValueOnce('/mock/launch/ui-4/cli-9.jsonl');
    provider.onSessionResumed!('ui-4', '/proj', {} as any, '/profiles/work', 'cli-9');
    expect(mockRegisterPendingPiBoltSession).toHaveBeenCalledWith('ui-4', '/proj', '/profiles/work', {
      sessionDir: sessionDirFor('ui-4'),
      knownCliId: 'cli-9',
      adoptedFile: '/mock/launch/ui-4/cli-9.jsonl',
    });
    // The launch's own dir is searched first for the adopted transcript.
    expect(findTranscriptPathInFlatDir).toHaveBeenCalledWith(sessionDirFor('ui-4'), 'cli-9', '/proj');
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

describe('discoverTranscripts', () => {
  it('scans ONLY the pi-bolt-sessions launch base, never the shared ~/.pi/agent root', async () => {
    const base = path.join(MOCK_USER_DATA, 'pi-bolt-sessions');
    const dir = path.join(base, 'sess-1');
    mockReaddir.mockResolvedValueOnce(['sess-1']); // per-launch base listing
    mockReadFile.mockResolvedValue(JSON.stringify({
      providerId: 'pi-bolt', cwd: '/proj', createdAt: '2026-10-20T10:00:00.000Z',
    }) as any);
    mockScanFlatSessionDir.mockResolvedValueOnce([
      { cliSessionId: 'cli-1', transcriptPath: path.join(dir, 'cli-1.jsonl'), projectCwd: '/proj' } as any,
    ]);

    const { descriptors, complete, incompleteRoots } = await provider.discoverTranscripts();

    expect(complete).toBe(true);
    expect(incompleteRoots).toEqual([]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].cliSessionId).toBe('cli-1');
    // The pi-bolt launch base is the only enumerated root; its dirs are
    // scanned flat, with the sidecar's profile (none = default).
    expect(mockReaddir).toHaveBeenCalledWith(base);
    expect(mockScanFlatSessionDir).toHaveBeenCalledWith(dir, undefined, undefined);
    // Anti-double-listing: Pi-Bolt shares Pi's ~/.pi/agent tree, so the shared
    // corpus is enumerated by the Pi provider ONLY — never here.
    expect(mockScanTranscriptSessionsRoot).not.toHaveBeenCalled();
  });

  it('reports a clean empty pass when the launch base is missing', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(provider.discoverTranscripts()).resolves.toEqual({
      descriptors: [], complete: true, incompleteRoots: [],
    });
    expect(mockScanTranscriptSessionsRoot).not.toHaveBeenCalled();
  });
});

describe('readSessionTitle', () => {
  it('adopts the newest session_info name from the given transcript path', () => {
    vi.mocked(readTranscriptTitleWithSessionInfoSync).mockReturnValue('Refactor auth module');

    expect(provider.readSessionTitle!('/sessions/dir-a/2026.jsonl')).toBe('Refactor auth module');
    expect(readTranscriptTitleWithSessionInfoSync).toHaveBeenCalledWith('/sessions/dir-a/2026.jsonl');
  });

  it('returns null when the transcript carries no session name', () => {
    vi.mocked(readTranscriptTitleWithSessionInfoSync).mockReturnValue(null);

    expect(provider.readSessionTitle!('/sessions/dir-a/2026.jsonl')).toBeNull();
  });

  it('declares selfTitles so transcript-sync mirrors the title', () => {
    expect(provider.meta.capabilities.selfTitles).toBe(true);
  });
});

describe('readSessionStatus', () => {
  it('derives status from the given transcript tail', () => {
    vi.mocked(readTranscriptStatusSync).mockReturnValue('completed');

    expect(provider.readSessionStatus!('/sessions/dir-a/2026.jsonl')).toBe('completed');
    expect(readTranscriptStatusSync).toHaveBeenCalledWith('/sessions/dir-a/2026.jsonl');
  });

  it('returns null when the tail yields no status', () => {
    vi.mocked(readTranscriptStatusSync).mockReturnValue(null);

    expect(provider.readSessionStatus!('/sessions/dir-a/2026.jsonl')).toBeNull();
  });
});

describe('readSessionExitReason', () => {
  it('reads the exit reason from the given transcript path', () => {
    vi.mocked(readSessionExitReasonSync).mockReturnValue({ reason: 'unhandled_rejection', kind: 'fatal' });

    expect(provider.readSessionExitReason!('/sessions/dir-a/2026.jsonl')).toEqual({ reason: 'unhandled_rejection', kind: 'fatal' });
    expect(readSessionExitReasonSync).toHaveBeenCalledWith('/sessions/dir-a/2026.jsonl');
  });

  it('returns null when the transcript has no session_exit', () => {
    vi.mocked(readSessionExitReasonSync).mockReturnValue(null);

    expect(provider.readSessionExitReason!('/sessions/dir-a/2026.jsonl')).toBeNull();
  });
});

describe('getTranscriptPath', () => {
  it('resolves a hit in the launch dir first, without touching the shared root', () => {
    vi.mocked(findTranscriptPathInFlatDir).mockReturnValueOnce('/mock/launch/cli-9.jsonl');

    expect(provider.getTranscriptPath!('cli-9', '/proj', '/profiles/work', '/mock/launch')).toBe('/mock/launch/cli-9.jsonl');
    expect(findTranscriptPathInFlatDir).toHaveBeenCalledWith('/mock/launch', 'cli-9', '/proj');
    expect(findTranscriptPathSync).not.toHaveBeenCalled();
  });

  it('falls back to the shared Pi root (same ~/.pi/agent tree) when the launch dir misses', () => {
    vi.mocked(findTranscriptPathSync).mockReturnValue('/sessions/dir-a/2026.jsonl');

    expect(provider.getTranscriptPath!('cli-9', '/proj', '/profiles/work', '/mock/launch')).toBe('/sessions/dir-a/2026.jsonl');
    expect(findTranscriptPathSync).toHaveBeenCalledWith(expect.any(Function), 'cli-9', '/proj', '/profiles/work');
  });
});
