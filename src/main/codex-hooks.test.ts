import { vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  tmpdir: () => '/tmp',
}));

vi.mock('./hook-commands', () => ({
  installHookScripts: vi.fn(),
  installEventScript: vi.fn(),
  statusCmd: vi.fn((e: string, s: string, _v: string, marker: string) => `echo ${e}:${s} > $FINEVIBE_SESSION_ID.status ${marker}`),
  captureSessionIdCmd: vi.fn((_v: string, marker: string) => `capture .sessionid $FINEVIBE_SESSION_ID ${marker}`),
  captureToolFailureCmd: vi.fn((_v: string, marker: string) => `capture-toolfailure ${marker}`),
  wrapPythonHookCmd: vi.fn((_name: string, _code: string, marker: string) => `capture-event $FINEVIBE_SESSION_ID .events ${marker}`),
}));

import * as fs from 'fs';
import * as path from 'path';
import { installCodexHooks, validateCodexHooks, cleanupCodexHooks, CODEX_HOOK_MARKER } from './codex-hooks';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

const n = (p: string) => p.replace(/\\/g, '/');

const HOOKS_JSON = path.join('/mock/home', '.codex', 'hooks.json');
const CONFIG_TOML = path.join('/mock/home', '.codex', 'config.toml');

function mockFiles(rawFiles: Record<string, string>): void {
  // Normalize all keys to forward slashes for cross-platform matching
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawFiles)) files[n(k)] = v;
  mockReadFileSync.mockImplementation((p: any) => {
    const content = files[n(String(p))];
    if (content !== undefined) return content;
    // Real fs carries `.code`; the strict installer read (P2-60) tells a
    // missing file (ENOENT) from a corrupt one, so mocks must match.
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// P2-60: a truncated/corrupt hooks.json used to be collapsed to `{}` by
// `readJsonSafe(...) ?? {}` and the install persisted that: every user-authored
// Codex hook and every other top-level key gone. The guard (mirror of
// gemini-hooks) aborts the install and leaves the file untouched.
describe('install over a corrupt hooks.json (P2-60)', () => {
  const TOML = '[features]\ncodex_hooks = true\n';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => warn.mockClear());

  it('syntax-broken hooks.json: no write to hooks.json, warning logged', () => {
    mockFiles({ [CONFIG_TOML]: TOML, [HOOKS_JSON]: '{"hooks": {"Stop": [' });
    installCodexHooks();
    expect(mockWriteFileSync.mock.calls.some((c) => n(String(c[0])) === n(HOOKS_JSON))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('non-object hooks.json is corrupt too (the collapse ran through the spread)', () => {
    mockFiles({ [CONFIG_TOML]: TOML, [HOOKS_JSON]: '[1,2]' });
    installCodexHooks();
    expect(mockWriteFileSync.mock.calls.some((c) => n(String(c[0])) === n(HOOKS_JSON))).toBe(false);
  });

  it('a missing hooks.json still installs fresh (ENOENT is not corruption)', () => {
    mockFiles({ [CONFIG_TOML]: TOML });
    installCodexHooks();
    expect(mockWriteFileSync.mock.calls.some((c) => n(String(c[0])) === n(HOOKS_JSON))).toBe(true);
  });

  it('user keys outside hooks survive an install over a valid file', () => {
    mockFiles({
      [CONFIG_TOML]: TOML,
      // No marker on the user command: cleanHooks must keep it (only our own
      // marked commands are ever stripped).
      [HOOKS_JSON]: JSON.stringify({ model: 'gpt-x', hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python user_hook.py' }] }] } }),
    });
    installCodexHooks();
    const call = mockWriteFileSync.mock.calls.find((c) => n(String(c[0])) === n(HOOKS_JSON))!;
    const written = JSON.parse(String(call[1]));
    expect(written.model).toBe('gpt-x');
    const stopCommands = written.hooks.Stop.flatMap((m: { hooks: { command: string }[] }) => m.hooks.map((h: { command: string }) => h.command));
    expect(stopCommands).toContain('python user_hook.py');
  });
});

describe('ensureCodexHooksFeatureFlag (via installCodexHooks)', () => {
  it('creates config.toml with feature flag when file does not exist', () => {
    mockFiles({}); // both files missing
    installCodexHooks();

    // First writeFileSync call is config.toml, second is hooks.json
    const tomlCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === CONFIG_TOML);
    expect(tomlCall).toBeDefined();
    expect(String(tomlCall![1])).toContain('[features]');
    expect(String(tomlCall![1])).toContain('codex_hooks = true');
  });

  it('appends [features] section when config.toml exists without it', () => {
    mockFiles({
      [CONFIG_TOML]: 'model = "o3"\n',
    });
    installCodexHooks();

    const tomlCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === CONFIG_TOML);
    const content = String(tomlCall![1]);
    expect(content).toContain('model = "o3"');
    expect(content).toContain('[features]');
    expect(content).toContain('codex_hooks = true');
  });

  it('flips codex_hooks = false to true', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = false\n',
    });
    installCodexHooks();

    const tomlCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === CONFIG_TOML);
    const content = String(tomlCall![1]);
    expect(content).toContain('codex_hooks = true');
    expect(content).not.toContain('codex_hooks = false');
  });

  it('inserts key when [features] section exists without codex_hooks', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\nother_flag = true\n',
    });
    installCodexHooks();

    const tomlCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === CONFIG_TOML);
    const content = String(tomlCall![1]);
    expect(content).toContain('codex_hooks = true');
    expect(content).toContain('other_flag = true');
  });

  it('does not rewrite when already enabled', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
    });
    installCodexHooks();

    // config.toml should NOT be written (only hooks.json)
    const tomlCalls = mockWriteFileSync.mock.calls.filter(c => String(c[0]) === CONFIG_TOML);
    expect(tomlCalls).toHaveLength(0);
  });
});

describe('installCodexHooks', () => {
  beforeEach(() => {
    // Provide config.toml with flag already set so we only test hooks.json
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
    });
  });

  it('creates hooks.json with all 5 events on fresh install', () => {
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    expect(hooksCall).toBeDefined();
    const written = JSON.parse(String(hooksCall![1]));
    const hooks = written.hooks;

    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(hooks.PreToolUse).toBeDefined();
  });

  it('writes correct status values for each event', () => {
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooks = JSON.parse(String(hooksCall![1])).hooks;

    // Check status commands contain correct event:status
    const getStatusCmd = (event: string) =>
      hooks[event].find((m: any) => m.hooks.some((h: any) => h.command.includes('.status')))
        ?.hooks.find((h: any) => h.command.includes('.status'))?.command;

    expect(getStatusCmd('SessionStart')).toContain('SessionStart:waiting');
    expect(getStatusCmd('UserPromptSubmit')).toContain('UserPromptSubmit:working');
    expect(getStatusCmd('PostToolUse')).toContain('PostToolUse:working');
    expect(getStatusCmd('Stop')).toContain('Stop:completed');
  });

  it('includes session ID capture on SessionStart and UserPromptSubmit only', () => {
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooks = JSON.parse(String(hooksCall![1])).hooks;

    const hasSessionIdCapture = (event: string) =>
      hooks[event]?.some((m: any) =>
        m.hooks.some((h: any) => h.command.includes('.sessionid'))
      );

    expect(hasSessionIdCapture('SessionStart')).toBe(true);
    expect(hasSessionIdCapture('UserPromptSubmit')).toBe(true);
    expect(hasSessionIdCapture('PostToolUse')).toBe(false);
    expect(hasSessionIdCapture('Stop')).toBe(false);
  });

  it('all hook commands contain the finevibe marker', () => {
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooks = JSON.parse(String(hooksCall![1])).hooks;

    for (const [, matchers] of Object.entries(hooks) as [string, any[]][]) {
      for (const matcher of matchers) {
        for (const h of matcher.hooks) {
          expect(h.command).toContain(CODEX_HOOK_MARKER);
        }
      }
    }
  });

  it('all hook commands reference $FINEVIBE_SESSION_ID', () => {
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooks = JSON.parse(String(hooksCall![1])).hooks;

    for (const [, matchers] of Object.entries(hooks) as [string, any[]][]) {
      for (const matcher of matchers) {
        for (const h of matcher.hooks) {
          expect(h.command).toContain('FINEVIBE_SESSION_ID');
        }
      }
    }
  });

  it('preserves existing user hooks', () => {
    const existingHooks = {
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'echo user-hook' }],
        }],
      },
    };

    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
      [HOOKS_JSON]: JSON.stringify(existingHooks),
    });

    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooks = JSON.parse(String(hooksCall![1])).hooks;

    // User hook preserved
    const userMatcher = hooks.SessionStart.find(
      (m: any) => m.hooks.some((h: any) => h.command === 'echo user-hook')
    );
    expect(userMatcher).toBeDefined();

    // FineVibe hooks also present
    const fineVibeMatcher = hooks.SessionStart.find(
      (m: any) => m.hooks.some((h: any) => h.command.includes(CODEX_HOOK_MARKER))
    );
    expect(fineVibeMatcher).toBeDefined();
  });

  it('is idempotent — no duplicate hooks on second run', () => {
    // First run
    installCodexHooks();
    const firstCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const firstOutput = String(firstCall![1]);

    // Setup the written output as the file content for second run
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
      [HOOKS_JSON]: firstOutput,
    });
    mockWriteFileSync.mockClear();

    // Second run
    installCodexHooks();
    const secondCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const secondOutput = JSON.parse(String(secondCall![1]));
    const firstParsed = JSON.parse(firstOutput);

    // Same number of matcher groups per event
    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PreToolUse']) {
      expect(secondOutput.hooks[event]?.length).toBe(firstParsed.hooks[event]?.length);
    }
  });

  it('preserves non-hooks keys in hooks.json', () => {
    const existing = {
      version: '1.0',
      hooks: {},
    };

    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
      [HOOKS_JSON]: JSON.stringify(existing),
    });

    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const written = JSON.parse(String(hooksCall![1]));
    expect(written.version).toBe('1.0');
  });
});

describe('validateCodexHooks', () => {
  it('returns complete when feature flag and all hooks are installed', () => {
    // Install first, then validate with written output
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
    });
    installCodexHooks();

    const hooksCall = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const hooksContent = String(hooksCall![1]);

    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
      [HOOKS_JSON]: hooksContent,
    });

    const result = validateCodexHooks();
    expect(result.statusLine).toBe('finevibe');
    expect(result.hooks).toBe('complete');
    expect(result.hookDetails.SessionStart).toBe(true);
    expect(result.hookDetails.UserPromptSubmit).toBe(true);
    expect(result.hookDetails.PostToolUse).toBe(true);
    expect(result.hookDetails.Stop).toBe(true);
  });

  it('returns missing when feature flag is not set', () => {
    mockFiles({
      [CONFIG_TOML]: 'model = "o3"\n',
    });

    const result = validateCodexHooks();
    expect(result.hooks).toBe('missing');
  });

  it('returns missing when config.toml does not exist', () => {
    mockFiles({});

    const result = validateCodexHooks();
    expect(result.hooks).toBe('missing');
  });

  it('returns missing when hooks.json does not exist but flag is set', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
    });

    const result = validateCodexHooks();
    expect(result.hooks).toBe('missing');
  });

  it('returns partial when some hooks are missing', () => {
    const partial = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `echo test ${CODEX_HOOK_MARKER}` }] }],
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `echo test ${CODEX_HOOK_MARKER}` }] }],
      },
    };

    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n',
      [HOOKS_JSON]: JSON.stringify(partial),
    });

    const result = validateCodexHooks();
    expect(result.hooks).toBe('partial');
    expect(result.hookDetails.SessionStart).toBe(true);
    expect(result.hookDetails.UserPromptSubmit).toBe(true);
    expect(result.hookDetails.PostToolUse).toBe(false);
    expect(result.hookDetails.Stop).toBe(false);
  });
});

describe('cleanupCodexHooks', () => {
  it('removes finevibe hooks and preserves user hooks', () => {
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          { matcher: '', hooks: [{ type: 'command', command: `echo status ${CODEX_HOOK_MARKER}` }] },
        ],
      },
    };

    mockFiles({ [HOOKS_JSON]: JSON.stringify(existing) });
    cleanupCodexHooks();

    const call = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const written = JSON.parse(String(call![1]));

    expect(written.hooks.SessionStart).toHaveLength(1);
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe('echo user-hook');
  });

  it('removes hooks key when all hooks are finevibe hooks', () => {
    const existing = {
      version: '1.0',
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: `echo ${CODEX_HOOK_MARKER}` }] },
        ],
      },
    };

    mockFiles({ [HOOKS_JSON]: JSON.stringify(existing) });
    cleanupCodexHooks();

    const call = mockWriteFileSync.mock.calls.find(c => String(c[0]) === HOOKS_JSON);
    const written = JSON.parse(String(call![1]));
    expect(written.hooks).toBeUndefined();
    expect(written.version).toBe('1.0');
  });

  it('handles missing hooks.json gracefully', () => {
    mockFiles({});
    expect(() => cleanupCodexHooks()).not.toThrow();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  // P2-61: cleanup is the inverse of install — installCodexHooks writes
  // `codex_hooks = true` into config.toml, and cleanup must strip it,
  // otherwise the user's remaining hooks.json entries keep firing on every
  // Codex run outside Vibeyard with no in-app way to turn the feature off.
  const finevibeHooks = JSON.stringify({
    hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `echo ${CODEX_HOOK_MARKER}` }] }] },
  });

  function tomlWrite(): string | undefined {
    const call = mockWriteFileSync.mock.calls.find(c => String(c[0]) === CONFIG_TOML);
    return call ? String(call[1]) : undefined;
  }

  it('strips codex_hooks from config.toml, keeping other keys, comments and sections', () => {
    mockFiles({
      [CONFIG_TOML]: 'model = "o3"\n[features]\ncodex_hooks = true\n# keep me\nshell = "pwsh"\n[profiles]\nx = 1\n',
      [HOOKS_JSON]: finevibeHooks,
    });
    cleanupCodexHooks();
    const content = tomlWrite();
    expect(content).toBeDefined();
    expect(content).not.toContain('codex_hooks');
    expect(content).toContain('[features]');
    expect(content).toContain('# keep me');
    expect(content).toContain('shell = "pwsh"');
    expect(content).toContain('model = "o3"');
    expect(content).toContain('[profiles]');
  });

  it('drops the [features] header when codex_hooks was its only entry', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\ncodex_hooks = true\n[other]\nx = 1\n',
      [HOOKS_JSON]: finevibeHooks,
    });
    cleanupCodexHooks();
    expect(tomlWrite()).toBe('[other]\nx = 1\n');
  });

  it('strips the flag from a CRLF config keeping the line endings', () => {
    mockFiles({
      [CONFIG_TOML]: '[features]\r\ncodex_hooks = true\r\nshell = "pwsh"\r\n',
      [HOOKS_JSON]: finevibeHooks,
    });
    cleanupCodexHooks();
    expect(tomlWrite()).toBe('[features]\r\nshell = "pwsh"\r\n');
  });

  it('strips the flag even when hooks.json is already gone', () => {
    mockFiles({ [CONFIG_TOML]: '[features]\ncodex_hooks = true\n' });
    cleanupCodexHooks();
    expect(tomlWrite()).toBe('');
    expect(mockWriteFileSync.mock.calls.filter(c => String(c[0]) === HOOKS_JSON)).toHaveLength(0);
  });

  it('leaves config.toml untouched when the flag was never set', () => {
    mockFiles({
      [CONFIG_TOML]: 'model = "o3"\n',
      [HOOKS_JSON]: finevibeHooks,
    });
    cleanupCodexHooks();
    expect(tomlWrite()).toBeUndefined();
  });
});
