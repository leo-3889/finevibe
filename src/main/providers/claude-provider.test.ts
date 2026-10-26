import { vi } from 'vitest';
import * as path from 'path';
import { isWin } from '../platform';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
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

vi.mock('../hook-status', () => ({
  getStatusLineScriptPath: vi.fn(() => '/tmp/finevibe/statusline.sh'),
  installStatusLineScript: vi.fn(),
  cleanupAll: vi.fn(),
}));

vi.mock('../claude-cli', () => ({
  installHooks: vi.fn(),
  getClaudeConfig: vi.fn(),
  // The transcript read-path gate (P2-113) consults the managed-config-dir
  // allowlist; tests that exercise the rejection override it per-test.
  isManagedMcpConfigDir: vi.fn(() => true),
}));

// The banner-driven repair path threads the profile config dir through the
// provider into settings-guard (P2-127): stub the guard so the threading is
// the only thing under test.
vi.mock('../settings-guard', () => ({
  guardedInstall: vi.fn(),
  validateSettings: vi.fn(() => ({})),
  reinstallSettings: vi.fn(),
}));

// P2-116: install/remove target the agents tree the spawned CLI reads;
vi.mock('./agent-files', async () => {
  const path = await import('path');
  return {
    writeAgentFile: vi.fn(async (dir: string, slug: string, _content: string) => ({
      filePath: path.join(dir, `${slug}.md`),
    })),
    deleteAgentFile: vi.fn(async () => undefined),
  };
});

import * as fs from 'fs';
import { execSync } from 'child_process';
import { ClaudeProvider, _resetCachedPath } from './claude-provider';
import { isManagedMcpConfigDir } from '../claude-cli';
import { validateSettings as guardValidateSettings, reinstallSettings as guardReinstallSettings } from '../settings-guard';
import { writeAgentFile, deleteAgentFile } from './agent-files';
import { installStatusLineScript } from '../hook-status';
import { invalidateBinaryCache } from './resolve-binary';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockExecSync = vi.mocked(execSync);
const fileStat = { isFile: () => true } as fs.Stats;

let provider: ClaudeProvider;

beforeEach(() => {
  vi.clearAllMocks();
  // Order-independence: clearAllMocks clears CALLS but keeps mock
  // IMPLEMENTATIONS — a shuffled predecessor's statSync/execSync impl
  // (probe answers) leaked into this case and answered its resolution
  // probes. Reset to factory defaults, then establish the shared baseline.
  mockStatSync.mockReset();
  mockExecSync.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
  _resetCachedPath();
  invalidateBinaryCache();
  provider = new ClaudeProvider();
});

describe('meta', () => {
  it('has correct id, displayName, and binaryName', () => {
    expect(provider.meta.id).toBe('claude');
    expect(provider.meta.displayName).toBe('Claude Code');
    expect(provider.meta.binaryName).toBe('claude');
  });

  it('has all capabilities set to true', () => {
    const caps = provider.meta.capabilities;
    expect(caps.sessionResume).toBe(true);
    expect(caps.costTracking).toBe(true);
    expect(caps.contextWindow).toBe(true);
    expect(caps.hookStatus).toBe(true);
    expect(caps.configReading).toBe(true);
    expect(caps.shiftEnterNewline).toBe(true);
    expect(caps.pendingPromptTrigger).toBe('startup-arg');
    expect(caps.planModeArg).toBe('--permission-mode plan');
    expect(caps.systemPromptInjection).toBe(true);
  });

  it('has defaultContextWindowSize of 200,000', () => {
    expect(provider.meta.defaultContextWindowSize).toBe(200_000);
  });
});

describe('resolveBinaryPath', () => {
  const firstCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'claude.cmd')
    : '/usr/local/bin/claude';

  it('returns candidate path when statSync finds a file', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === firstCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.resolveBinaryPath()).toBe(firstCandidate);
  });

  it(`falls back to ${isWin ? 'where' : 'which'} claude when no candidate exists`, () => {
    mockExecSync.mockReturnValue('/some/other/path/claude\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/claude');
  });

  it('falls back to bare "claude" when both candidate and which fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.resolveBinaryPath()).toBe('claude');
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
    mockExecSync.mockReturnValue('/some/other/path/claude\n' as any);
    expect(provider.resolveBinaryPath()).toBe('/some/other/path/claude');
  });
});

describe('validatePrerequisites', () => {
  const validateCandidate = isWin
    ? path.join('/mock/home', 'AppData', 'Roaming', 'npm', 'claude.cmd')
    : '/opt/homebrew/bin/claude';

  it('returns ok when binary found via statSync', () => {
    mockStatSync.mockImplementation((p) => {
      if (p === validateCandidate) return fileStat;
      throw new Error('ENOENT');
    });
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns ok when binary found via which', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue('/resolved/claude\n' as any);
    expect(provider.validatePrerequisites()).toBe(true);
  });

  it('returns not ok when binary not found anywhere', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(provider.validatePrerequisites()).toBe(false);
  });
});

describe('buildEnv', () => {
  it('sets CLAUDE_IDE_SESSION_ID to the session ID', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.CLAUDE_IDE_SESSION_ID).toBe('sess-123');
  });

  it('sets PATH to the augmented PATH', () => {
    const env = provider.buildEnv('sess-123', {});
    expect(env.PATH).toBe(isWin ? '/usr/local/bin;/usr/bin' : '/usr/local/bin:/usr/bin');
  });

  it('deletes CLAUDE_CODE from env if present', () => {
    const env = provider.buildEnv('sess-123', { CLAUDE_CODE: '1', OTHER: 'val' });
    expect(env.CLAUDE_CODE).toBeUndefined();
    expect(env.OTHER).toBe('val');
  });

  it('sets CLAUDE_CONFIG_DIR when a profile configDir is given', () => {
    const env = provider.buildEnv('sess-123', {}, { configDir: '/mock/home/.finevibe/profiles/work' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/mock/home/.finevibe/profiles/work');
  });

  it('does not set CLAUDE_CONFIG_DIR when no configDir is given', () => {
    expect(provider.buildEnv('sess-123', {}).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(provider.buildEnv('sess-123', {}, {}).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(provider.buildEnv('sess-123', { CLAUDE_CONFIG_DIR: '/other/account' }).CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(provider.buildEnv('sess-123', { claude_config_dir: '/other/account' })).not.toHaveProperty('claude_config_dir');
  });
});

describe('buildArgs', () => {
  it('returns ["-r", id] when isResume=true with cliSessionId', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '' });
    expect(args).toEqual(['-r', 'sid-1']);
  });

  it('returns ["--session-id", id] when isResume=false with cliSessionId', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: false, extraArgs: '' });
    expect(args).toEqual(['--session-id', 'sid-1']);
  });

  it('returns [] when cliSessionId is null', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '' });
    expect(args).toEqual([]);
  });

  it('splits extraArgs on whitespace and appends', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--verbose  --debug' });
    expect(args).toEqual(['--verbose', '--debug']);
  });

  it('combines session args and extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: true, extraArgs: '--verbose' });
    expect(args).toEqual(['-r', 'sid-1', '--verbose']);
  });

  it('tokenizes quoted extra args (spaces stay inside one argument)', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--model "my model"' });
    expect(args).toEqual(['--model', 'my model']);
  });

  it('preserves empty quoted extra args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '--flag ""' });
    expect(args).toEqual(['--flag', '']);
  });

  it('passes initialPrompt as positional arg', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', initialPrompt: 'fix the linter' });
    expect(args).toEqual(['fix the linter']);
  });

  it('passes initialPrompt after session-id args', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: 'sid-1', isResume: false, extraArgs: '', initialPrompt: 'fix the linter' });
    expect(args).toEqual(['--session-id', 'sid-1', 'fix the linter']);
  });

  it('passes systemPrompt as --append-system-prompt argv pair', () => {
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: 'You are the CMO.' });
    expect(args).toEqual(['--append-system-prompt', 'You are the CMO.']);
  });

  it('preserves multi-line systemPrompt as a single argv element', () => {
    const prompt = 'You are the CMO.\n\nFocus on:\n- growth\n- retention';
    const args = provider.buildArgs({ sessionId: 'sess-1', cliSessionId: null, isResume: false, extraArgs: '', systemPrompt: prompt });
    expect(args).toEqual(['--append-system-prompt', prompt]);
  });

  it('puts systemPrompt before initialPrompt and extra args', () => {
    const args = provider.buildArgs({
      sessionId: 'sess-1',
      cliSessionId: 'sid-1',
      isResume: false,
      extraArgs: '--verbose',
      initialPrompt: 'hello',
      systemPrompt: 'be concise',
    });
    expect(args).toEqual(['--session-id', 'sid-1', '--append-system-prompt', 'be concise', 'hello', '--verbose']);
  });
});

describe('getShiftEnterSequence', () => {
  it('returns the kitty keyboard protocol sequence', () => {
    expect(provider.getShiftEnterSequence()).toBe('\x1b[13;2u');
  });
});

describe('getTranscriptPath', () => {
  it('returns slugged path when file exists', () => {
    mockExistsSync.mockReturnValue(true);
    const out = provider.getTranscriptPath('abc-123', '/Users/me/dev/my repo');
    // Non-alphanumeric chars all collapse to '-'
    expect(out).toBe(path.join('/mock/home', '.claude', 'projects', '-Users-me-dev-my-repo', 'abc-123.jsonl'));
  });

  it('returns null when the file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(provider.getTranscriptPath('sid', '/tmp/proj')).toBeNull();
  });

  it('slugs Windows-style project paths', () => {
    mockExistsSync.mockReturnValue(true);
    const out = provider.getTranscriptPath('sid', 'C:\\Users\\me\\proj');
    // ':' and '\' each collapse to '-', producing 'C--Users-me-proj'
    expect(out).toBe(path.join('/mock/home', '.claude', 'projects', 'C--Users-me-proj', 'sid.jsonl'));
  });

  it('resolves under a profile config dir when given', () => {
    mockExistsSync.mockReturnValue(true);
    const out = provider.getTranscriptPath('abc-123', '/tmp/proj', '/mock/home/.finevibe/profiles/work');
    expect(out).toBe(path.join('/mock/home/.finevibe/profiles/work', 'projects', '-tmp-proj', 'abc-123.jsonl'));
  });

  it('refuses a configDir outside the managed roots (P2-113 read gate)', () => {
    // The channel echoes an existsSync answer back to the renderer, so a
    // foreign configDir must never be probed at all - the same allowlist
    // mcp:addServer enforces on its WRITE target, now on the read side.
    mockExistsSync.mockReturnValue(true);
    vi.mocked(isManagedMcpConfigDir).mockReturnValueOnce(false);
    expect(provider.getTranscriptPath('abc-123', '/tmp/proj', '/home/attacker/.claude')).toBeNull();
    expect(isManagedMcpConfigDir).toHaveBeenCalledWith('/home/attacker/.claude');
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('accepts a managed profile configDir (gate passes)', () => {
    mockExistsSync.mockReturnValue(true);
    expect(provider.getTranscriptPath('abc-123', '/tmp/proj', '/mock/home/.finevibe/profiles/work')).toBe(
      path.join('/mock/home/.finevibe/profiles/work', 'projects', '-tmp-proj', 'abc-123.jsonl'),
    );
  });

  it('refuses a session id that is a path, not a file name', () => {
    // The renderer only learns "this path exists", so a `../` id is a
    // filesystem-wide existsSync probe (and the resume/export paths echo the
    // result back). The id gate runs before the join.
    mockExistsSync.mockReturnValue(true);

    expect(provider.getTranscriptPath('../../.ssh/id_rsa', '/tmp/proj')).toBeNull();
    expect(provider.getTranscriptPath('.hidden', '/tmp/proj')).toBeNull();
    expect(provider.getTranscriptPath('a'.repeat(129), '/tmp/proj')).toBeNull();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('accepts the UUID Claude names transcripts with', () => {
    mockExistsSync.mockReturnValue(true);
    const uuid = '0f8e2f6a-1e2c-4a44-9b3f-2a1d0c9b8a77';

    expect(provider.getTranscriptPath(uuid, '/tmp/proj')).toBe(
      path.join('/mock/home', '.claude', 'projects', '-tmp-proj', `${uuid}.jsonl`),
    );
  });
});

describe('parseCostFromOutput', () => {
  it('extracts last $X.XX match from text', () => {
    const result = provider.parseCostFromOutput('Total cost: $1.23');
    expect(result).toEqual({ totalCostUsd: 1.23 });
  });

  it('returns null when no cost pattern found', () => {
    expect(provider.parseCostFromOutput('no costs here')).toBeNull();
  });

  it('handles multiple cost values and picks last one', () => {
    const result = provider.parseCostFromOutput('Cost: $0.50 then $1.75 then $3.20');
    expect(result).toEqual({ totalCostUsd: 3.20 });
  });
});

// P1-14 / P2-127: the banner is computed from (and must repair) the profile
// session's config dir — the tree the profiled CLI actually reads.
describe('validateSettings / reinstallSettings configDir threading', () => {
  it('validateSettings validates the profile config dir, not ~/.claude', () => {
    provider.validateSettings('/proj', '/profiles/work');
    expect(guardValidateSettings).toHaveBeenCalledWith('/profiles/work');
  });

  it('validateSettings without a dir validates the default dir', () => {
    provider.validateSettings('/proj');
    expect(guardValidateSettings).toHaveBeenCalledWith(undefined);
  });

  it('reinstallSettings repairs the profile config dir and refreshes the script', () => {
    provider.reinstallSettings('/profiles/work');
    expect(guardReinstallSettings).toHaveBeenCalledWith('/profiles/work');
    expect(installStatusLineScript).toHaveBeenCalledTimes(1);
  });

  it('reinstallSettings without a dir keeps repairing the default dir', () => {
    provider.reinstallSettings();
    expect(guardReinstallSettings).toHaveBeenCalledWith(undefined);
    expect(installStatusLineScript).toHaveBeenCalledTimes(1);
  });
});

// P2-116: a profile-pinned CLI runs with CLAUDE_CONFIG_DIR=<profileDir> and
// reads agents from <profileDir>/agents — install/remove must target that
// tree, mirroring the MCP configDir threading in claude-cli.ts.
describe('agent install/remove configDir threading (P2-116)', () => {
  it('agentsDir defaults to ~/.claude/agents', () => {
    expect(provider.agentsDir()).toBe(path.join('/mock/home', '.claude', 'agents'));
  });

  it('agentsDir with a configDir targets the profile tree the CLI reads', () => {
    expect(provider.agentsDir('/profiles/work')).toBe(path.join('/profiles/work', 'agents'));
  });

  it('installAgent with a configDir writes into profileDir/agents', async () => {
    const result = await provider.installAgent('auditor', 'body', '/profiles/work');
    expect(writeAgentFile).toHaveBeenCalledWith(path.join('/profiles/work', 'agents'), 'auditor', 'body');
    expect(result.filePath).toBe(path.join('/profiles/work', 'agents', 'auditor.md'));
  });

  it('installAgent without a configDir keeps the default tree', async () => {
    await provider.installAgent('auditor', 'body');
    expect(writeAgentFile).toHaveBeenCalledWith(path.join('/mock/home', '.claude', 'agents'), 'auditor', 'body');
  });

  it('removeAgent with a configDir deletes from profileDir/agents', async () => {
    await provider.removeAgent('auditor', '/profiles/work');
    expect(deleteAgentFile).toHaveBeenCalledWith(path.join('/profiles/work', 'agents'), 'auditor');
  });

  it('removeAgent without a configDir keeps the default tree', async () => {
    await provider.removeAgent('auditor');
    expect(deleteAgentFile).toHaveBeenCalledWith(path.join('/mock/home', '.claude', 'agents'), 'auditor');
  });
});
