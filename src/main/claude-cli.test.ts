import { vi, type Mock } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  // writeSettings writes atomically: open/write/fsync/close on a sibling
  // .tmp, then rename onto the target. writeSync returns the full
  // remaining length so the write loop finishes in one step.
  openSync: vi.fn(() => 7),
  writeSync: vi.fn((_fd: number, payload: Uint8Array, offset?: number) => payload.length - (offset ?? 0)),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
  // The MCP write allowlist compares canonical paths.
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  tmpdir: () => '/tmp',
}));

vi.mock('./providers/resolve-binary', () => ({
  resolveBinary: vi.fn(() => '/mock/bin/claude'),
  validateBinaryExists: vi.fn(() => true),
}));

vi.mock('./providers/claude-version', () => ({
  getClaudeVersion: vi.fn(() => '999.999.999'),
}));

vi.mock('./hook-commands', () => ({
  installHookScripts: vi.fn(),
  installEventScript: vi.fn(),
  statusCmd: vi.fn((e: string, s: string, _v: string, marker: string) => `echo ${e}:${s} > .status ${marker}`),
  // P2-73: the stub renders its arguments verbatim and contains none of the
  // real generator's output tokens (`stop_status_writer`, `.subagents`,
  // `.status`) — assertions below can only pass when claude-cli.ts feeds the
  // real session-var/marker arguments through to stopStatusCmd.
  stopStatusCmd: vi.fn((v: string, marker: string) => `stop-writer ${v} ${marker}`),
  captureSessionIdCmd: vi.fn((_v: string, marker: string) => `capture-sessionid .sessionid ${marker}`),
  // P2-72: the stub renders its arguments verbatim and contains none of the
  // real generator's output tokens — assertions below pass only when
  // claude-cli.ts feeds the real session-var/marker arguments through, so a
  // dropped argument breaks the suite (the old stub baked in '.toolfailure'
  // and the assertions checked for that baked-in literal).
  captureToolFailureCmd: vi.fn((v: string, marker: string) => `capture-toolfailure ${v} ${marker}`),
  wrapPythonHookCmd: vi.fn((_name: string, _code: string, marker: string) => `capture-event .events ${marker}`),
  // installStatusLine shells the script path with the real shQuote; the
  // quoting test below asserts its exact output, so stub the real logic.
  shQuote: (word: string) => `'${word.replace(/'/g, `'\\''`)}'`,
}));

import { isWin } from './platform';

// The MCP config-dir allowlist asks the store which config dirs the app
// handed out (profiles) and which projects it knows; both are state the
// tests hand it directly.
const storeProfiles = vi.hoisted(() => [] as { configDir: string }[]);
const storeProjects = vi.hoisted(() => [] as string[]);

vi.mock('./store', () => ({
  loadState: () => ({ profiles: storeProfiles }),
  getKnownProjectPaths: () => storeProjects,
}));

import * as fs from 'fs';
import * as path from 'path';
import { addMcpServer, getClaudeConfig, getSupportedHookEvents, installHooks, installHooksOnly, installStatusLine, removeMcpServer } from './claude-cli';
import { isFineVibeStatusLine } from './settings-guard';
import { installEventScript, stopStatusCmd } from './hook-commands';
import { getClaudeVersion } from './providers/claude-version';

const mockStopStatusCmd = vi.mocked(stopStatusCmd);

// fs.readFileSync/readdirSync are overloaded; vi.mocked binds one overload
// (the buffer-flavored one), so pin the call shape these tests mock.
const mockReadFileSync = vi.mocked(fs.readFileSync) as unknown as Mock<(p: fs.PathLike, options?: unknown) => string>;
const mockReaddirSync = vi.mocked(fs.readdirSync) as unknown as Mock<(dirPath: fs.PathLike) => fs.Dirent<string>[]>;
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockOpenSync = vi.mocked(fs.openSync);
const mockWriteSync = vi.mocked(fs.writeSync);
const mockFsyncSync = vi.mocked(fs.fsyncSync);
const mockCloseSync = vi.mocked(fs.closeSync);
const mockRenameSync = vi.mocked(fs.renameSync) as unknown as Mock<(from: string, to: string) => void>;

// writeSettings() lands payloads through openSync/writeSync/renameSync, not
// writeFileSync. Settings payloads in write order — each settings.json write
// fills its .tmp with exactly one writeSync (the mock writes everything).
function settingsWrites(): string[] {
  return mockWriteSync.mock.calls.map((c) => String(c[1]));
}

// writeJsonAtomically lands payloads through openSync/writeSync on a sibling
// .tmp, then renameSync onto the target (P2-18): final-target path -> payload.
// Temp writes with no rename (an aborted install) are intentionally invisible
// here — the target file is what the user's CLI reads.
function atomicWrites(): Map<string, string> {
  const openTmps = mockOpenSync.mock.calls.map((c) => String(c[0]));
  const payloads = mockWriteSync.mock.calls.map((c) => String(c[1]));
  const payloadByTmp = new Map<string, string>();
  for (const [i, tmp] of openTmps.entries()) {
    payloadByTmp.set(tmp.replaceAll('\\', '/'), (payloadByTmp.get(tmp.replaceAll('\\', '/')) ?? '') + (payloads[i] ?? ''));
  }
  const out = new Map<string, string>();
  for (const [, dest] of mockRenameSync.mock.calls) {
    const target = String(dest);
    out.set(n(target), payloadByTmp.get(n(target + '.tmp')) ?? '');
  }
  return out;
}

// Normalize paths for cross-platform comparison
const n = (p: string) => p.replace(/\\/g, '/');

// Real fs throws ENOENT as `Error` with `.code === 'ENOENT'`; the strict
// config reader (P1-18) tells a missing file (code check) from a corrupt one,
// so every mock "missing file" throw must carry the code like the platform.
const enoent = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

beforeEach(() => {
  vi.clearAllMocks();
  storeProfiles.length = 0;
  storeProjects.length = 0;
  // Default: all reads/dirs fail (empty state)
  mockReadFileSync.mockImplementation(() => { throw enoent(); });
  mockReaddirSync.mockImplementation(() => { throw enoent(); });
});

describe('getClaudeConfig', () => {
  it('returns empty config when no files exist', async () => {
    const config = await getClaudeConfig('/project');
    expect(config).toEqual({ mcpServers: [], agents: [], skills: [], commands: [] });
  });

  it('reads MCP servers from user settings.json', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/settings.json') {
        return JSON.stringify({
          mcpServers: { myServer: { url: 'http://localhost:3000' } },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toEqual([
      { name: 'myServer', url: 'http://localhost:3000', status: 'configured', scope: 'user', filePath: path.join('/mock/home', '.claude', 'settings.json') },
    ]);
  });

  it('reads MCP servers from project .mcp.json', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/project/.mcp.json') {
        return JSON.stringify({
          mcpServers: { projServer: { command: 'npx server' } },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toEqual([
      { name: 'projServer', url: 'npx server', status: 'configured', scope: 'project', filePath: path.join('/project', '.mcp.json') },
    ]);
  });

  it('project MCP servers override user servers by name', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p === '/mock/home/.claude/settings.json') {
        return JSON.stringify({ mcpServers: { shared: { url: 'user-url' } } });
      }
      if (p === '/project/.claude/settings.json') {
        return JSON.stringify({ mcpServers: { shared: { url: 'project-url' } } });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].url).toBe('project-url');
    expect(config.mcpServers[0].scope).toBe('project');
  });

  it('reads agents from user agents directory', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (n(String(dirPath)) === '/mock/home/.claude/agents') {
        return ['my-agent.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/agents/my-agent.md') {
        return '---\nname: MyAgent\nmodel: opus\n---\nContent';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.agents).toEqual([
      { name: 'MyAgent', model: 'opus', category: 'plugin', scope: 'user', filePath: path.join('/mock/home', '.claude', 'agents', 'my-agent.md') },
    ]);
  });

  it('deduplicates agents by name', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      const p = n(String(dirPath));
      if (p === '/mock/home/.claude/agents' || p === '/project/.claude/agents') {
        return ['agent.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p.endsWith('agent.md')) {
        return '---\nname: SameAgent\nmodel: sonnet\n---\n';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.agents).toHaveLength(1);
  });

  it('reads commands from user commands directory', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (n(String(dirPath)) === '/mock/home/.claude/commands') {
        return ['commit.md', 'review.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/commands/commit.md') {
        return '---\ndescription: Create a commit\n---\nContent';
      }
      if (n(String(filePath)) === '/mock/home/.claude/commands/review.md') {
        return 'No frontmatter here';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.commands).toEqual([
      { name: 'commit', description: 'Create a commit', scope: 'user', filePath: path.join('/mock/home', '.claude', 'commands', 'commit.md') },
      { name: 'review', description: '', scope: 'user', filePath: path.join('/mock/home', '.claude', 'commands', 'review.md') },
    ]);
  });

  it('reads commands from project commands directory', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (n(String(dirPath)) === '/project/.claude/commands') {
        return ['deploy.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/project/.claude/commands/deploy.md') {
        return '---\ndescription: Deploy the app\n---\n';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.commands).toEqual([
      { name: 'deploy', description: 'Deploy the app', scope: 'project', filePath: path.join('/project', '.claude', 'commands', 'deploy.md') },
    ]);
  });

  it('deduplicates commands by name (project overrides user)', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      const p = n(String(dirPath));
      if (p === '/mock/home/.claude/commands') {
        return ['shared.md'] as unknown as fs.Dirent[];
      }
      if (p === '/project/.claude/commands') {
        return ['shared.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p === '/mock/home/.claude/commands/shared.md') {
        return '---\ndescription: User version\n---\n';
      }
      if (p === '/project/.claude/commands/shared.md') {
        return '---\ndescription: Project version\n---\n';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.commands).toHaveLength(1);
    expect(config.commands[0].description).toBe('Project version');
    expect(config.commands[0].scope).toBe('project');
  });

  it('reads MCP servers from ~/.claude.json top-level (user scope)', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude.json') {
        return JSON.stringify({
          mcpServers: { globalServer: { url: 'http://global:3000' } },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'globalServer', url: 'http://global:3000', scope: 'user' })
    );
  });

  it('reads project-specific MCP servers from ~/.claude.json projects key', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude.json') {
        return JSON.stringify({
          projects: {
            '/project': {
              mcpServers: { localServer: { command: 'npx local' } },
            },
          },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'localServer', url: 'npx local', scope: 'project' })
    );
  });

  it('reads managed MCP servers from platform-specific path', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      // On macOS (test environment), the path is /Library/Application Support/ClaudeCode/managed-mcp.json
      if (String(filePath).includes('managed-mcp.json')) {
        return JSON.stringify({
          mcpServers: { managedServer: { url: 'http://managed:3000' } },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.mcpServers).toContainEqual(
      expect.objectContaining({ name: 'managedServer', url: 'http://managed:3000', scope: 'user' })
    );
  });

  it('reads plugin agents when enabled', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p === '/mock/home/.claude/settings.json') {
        return JSON.stringify({ enabledPlugins: { 'my-plugin': true } });
      }
      if (p === '/mock/home/.claude/plugins/installed_plugins.json') {
        return JSON.stringify({
          plugins: {
            'my-plugin': [{ installPath: '/mock/plugins/my-plugin', scope: 'user' }],
          },
        });
      }
      if (p === '/mock/plugins/my-plugin/agents/agent.md') {
        return '---\nname: PluginAgent\nmodel: sonnet\n---\n';
      }
      throw enoent();
    });
    mockReaddirSync.mockImplementation((dirPath) => {
      if (n(String(dirPath)) === '/mock/plugins/my-plugin/agents') {
        return ['agent.md'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.agents).toContainEqual(
      expect.objectContaining({ name: 'PluginAgent', category: 'plugin', scope: 'user' })
    );
  });

  it('skips disabled plugins', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p === '/mock/home/.claude/settings.json') {
        return JSON.stringify({ enabledPlugins: { 'my-plugin': false } });
      }
      if (p === '/mock/home/.claude/plugins/installed_plugins.json') {
        return JSON.stringify({
          plugins: {
            'my-plugin': [{ installPath: '/mock/plugins/my-plugin' }],
          },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.agents).toEqual([]);
  });

  it('returns empty plugins when enabledPlugins is missing', async () => {
    mockReadFileSync.mockImplementation((filePath) => {
      const p = n(String(filePath));
      if (p === '/mock/home/.claude/settings.json') {
        return JSON.stringify({});
      }
      if (p === '/mock/home/.claude/plugins/installed_plugins.json') {
        return JSON.stringify({
          plugins: {
            'my-plugin': [{ installPath: '/mock/plugins/my-plugin' }],
          },
        });
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.agents).toEqual([]);
  });

  it('reads skills from directories', async () => {
    mockReaddirSync.mockImplementation((dirPath) => {
      if (n(String(dirPath)) === '/mock/home/.claude/skills') {
        return ['my-skill'] as unknown as fs.Dirent[];
      }
      throw enoent();
    });
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/skills/my-skill/SKILL.md') {
        return '---\nname: MySkill\ndescription: Does stuff\n---\n';
      }
      throw enoent();
    });

    const config = await getClaudeConfig('/project');
    expect(config.skills).toEqual([
      { name: 'MySkill', description: 'Does stuff', scope: 'user', filePath: path.join('/mock/home', '.claude', 'skills', 'my-skill', 'SKILL.md') },
    ]);
  });
});

describe('install into a profile config dir', () => {
  const profileDir = path.join('/mock/home', '.finevibe', 'profiles', 'work');

  it('installHooksOnly writes to the given config dir, not ~/.claude', () => {
    installHooksOnly(profileDir);
    expect(mockMkdirSync).toHaveBeenCalledWith(profileDir, { recursive: true });
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
    expect(n(String(mockRenameSync.mock.calls[0][1]))).toBe(n(path.join(profileDir, 'settings.json')));
    // Default ~/.claude/settings.json must not be touched.
    const touchedDefault = mockRenameSync.mock.calls.some(
      (c) => n(String(c[1])) === '/mock/home/.claude/settings.json',
    );
    expect(touchedDefault).toBe(false);
  });

  it('installStatusLine writes to the given config dir', () => {
    installStatusLine(profileDir);
    expect(n(String(mockRenameSync.mock.calls[0][1]))).toBe(n(path.join(profileDir, 'settings.json')));
    const written = JSON.parse(settingsWrites()[0]);
    expect(written.statusLine.type).toBe('command');
  });

  it('installStatusLine quotes the script path for the shell', () => {
    // Claude Code runs the statusLine command through a shell: the raw path
    // broke on the first space (`/Users/John Smith/.finevibe/...`, spaced
    // Windows profiles), silently killing cost/context/title. POSIX:
    // shQuote single quotes; cmd.exe: double quotes.
    installStatusLine(profileDir);
    const written = JSON.parse(settingsWrites()[0]);
    const p = path.join('/mock/home', '.finevibe', 'run', isWin ? 'statusline.cmd' : 'statusline.sh');
    expect(written.statusLine.command).toBe(isWin ? `"${p}"` : `'${p}'`);
  });

  it('installStatusLine output reads back as FineVibe\'s own statusLine', () => {
    // Writer/reader round trip: `installStatusLine` shells the path, and
    // settings-guard's validator must classify that exact payload as
    // FineVibe's. A raw-string compare made every healthy install grade as
    // `foreign` (checklist: "Overwritten by another tool"; consent gate about
    // FineVibe's own command; a `Fix` that could never clear).
    installStatusLine(profileDir);
    const written = JSON.parse(settingsWrites()[0]!);
    expect(isFineVibeStatusLine(written.statusLine)).toBe(true);
  });

  it('defaults to ~/.claude when no config dir is given', () => {
    installHooksOnly();
    expect(n(String(mockRenameSync.mock.calls[0][1]))).toBe('/mock/home/.claude/settings.json');
  });
});

// P1-13: an undetectable CLI version — `claude --version` exceeds its 3 s
// budget during a heavy launch, or the build prints no semver — yields the
// empty supported-event set. Pre-fix, installHooksOnly wrote that empty set:
// prepareSettings had already stripped every '# finevibe-hook' command out of
// settings.json and the event loops added none back, so one slow probe
// silently deleted the user's installed hooks. Fail closed: with no event
// known to be supported, settings.json is not touched at all.
describe('install with an undetectable CLI version (P1-13)', () => {
  const EXISTING_HOOKS = {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo Stop:completed # finevibe-hook' }] }],
  };

  beforeEach(() => {
    vi.mocked(getClaudeVersion).mockReturnValue(null);
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/settings.json') {
        return JSON.stringify({ hooks: EXISTING_HOOKS });
      }
      throw enoent();
    });
  });

  afterEach(() => {
    // The suite-wide default answers every probe with a newest-version build.
    vi.mocked(getClaudeVersion).mockReturnValue('999.999.999');
  });

  it('supports no hook event when the version is null (gate contract)', () => {
    // The empty set is claude-hook-versions.ts's documented safe baseline for
    // an undetectable CLI. It is what makes the write path destructive, so the
    // installers must never write hooks from it.
    expect(getSupportedHookEvents().size).toBe(0);
  });

  it('installHooksOnly leaves settings.json completely untouched', () => {
    installHooksOnly();

    // Fail-before: the write landed with `hooks: {}` — the user's markers
    // stripped, nothing installed to replace them.
    expect(mockWriteSync).not.toHaveBeenCalled();
    expect(mockRenameSync).not.toHaveBeenCalled();
  });

  it('installHooks preserves the existing hooks verbatim; only statusLine lands', () => {
    installHooks();

    // installHooksOnly wrote nothing, so installStatusLine's write is the only
    // payload — and it re-read the file, keeping the hooks key byte-equal.
    expect(settingsWrites()).toHaveLength(1);
    const written = JSON.parse(settingsWrites()[0]!);
    expect(written.hooks).toEqual(EXISTING_HOOKS);
    expect(written.statusLine.type).toBe('command');
  });
});

describe('writeSettings atomic write', () => {
  it('writes settings.json to a .tmp, fsyncs, then renames over the target', () => {
    installHooksOnly();

    const tmpPath = path.join('/mock/home', '.claude', 'settings.json.tmp');
    const targetPath = path.join('/mock/home', '.claude', 'settings.json');
    expect(mockOpenSync).toHaveBeenCalledWith(tmpPath, 'w');
    expect(mockRenameSync).toHaveBeenCalledWith(tmpPath, targetPath);
    // No direct writeFileSync against settings.json — the payload must go
    // through the temp file, never the live path.
    const direct = mockWriteFileSync.mock.calls.some(
      (c) => n(String(c[0])) === '/mock/home/.claude/settings.json',
    );
    expect(direct).toBe(false);
    // Ordering: open < write < fsync < close < rename. fsync must land
    // before the rename (a crash between rename and flush used to leave a
    // truncated settings.json), and the fd must not leak past the rename.
    const openOrder = mockOpenSync.mock.invocationCallOrder[0];
    const writeOrder = mockWriteSync.mock.invocationCallOrder[0];
    const fsyncOrder = mockFsyncSync.mock.invocationCallOrder[0];
    const closeOrder = mockCloseSync.mock.invocationCallOrder[0];
    const renameOrder = mockRenameSync.mock.invocationCallOrder[0];
    expect(openOrder).toBeLessThan(writeOrder);
    expect(writeOrder).toBeLessThan(fsyncOrder);
    expect(fsyncOrder).toBeLessThan(closeOrder);
    expect(closeOrder).toBeLessThan(renameOrder);
    // The payload that lands on disk is the settings JSON.
    expect(JSON.parse(settingsWrites()[0]).hooks).toBeDefined();
  });
});

/** The generated Python body for one event's capture script. */
function eventScriptBody(event: string): string {
  const scripts = new Map<string, string>(
    vi.mocked(installEventScript).mock.calls.map(([name, code]) => [name as string, code as string])
  );
  return scripts.get(`claude_event_${event}.py`) ?? '';
}

/** Every hook handler installed for one event, across all matcher entries. */
function hookHandlersFor(written: any, event: string): Array<{ command: string; timeout?: number }> {
  return (written.hooks[event] ?? []).flatMap((m: { hooks: Array<{ command: string; timeout?: number }> }) => m.hooks);
}

/** Just the commands for one event. */
function hookCommandsFor(written: any, event: string): string[] {
  return hookHandlersFor(written, event).map((h) => h.command);
}

describe('installHooks', () => {
  it('writes hooks to settings.json', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    expect(mockMkdirSync).toHaveBeenCalledWith(path.join('/mock/home', '.claude'), { recursive: true });
    // installHooks calls installHooksOnly (write 1) + installStatusLine (write 2)
    expect(mockWriteSync).toHaveBeenCalledTimes(2);

    // First write contains hooks
    const written = JSON.parse(settingsWrites()[0]);
    expect(written.hooks).toBeDefined();
    expect(written.hooks.UserPromptSubmit).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
    expect(written.hooks.PermissionRequest).toBeDefined();
    expect(written.hooks.SessionStart).toBeDefined();

    // Second write adds statusLine
    const withStatusLine = JSON.parse(settingsWrites()[1]);
    expect(withStatusLine.statusLine).toBeDefined();
    expect(withStatusLine.statusLine.type).toBe('command');
  });

  it('preserves existing non-finevibe hooks', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/settings.json') {
        return JSON.stringify({
          hooks: {
            UserPromptSubmit: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            }],
          },
        });
      }
      throw enoent();
    });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const promptHooks = written.hooks.UserPromptSubmit;
    // Should have the existing user hook matcher + the new finevibe matcher
    expect(promptHooks.length).toBe(2);
    const userHook = promptHooks.find((m: { hooks: Array<{ command: string }> }) =>
      m.hooks.some((h: { command: string }) => h.command === 'echo user-hook')
    );
    expect(userHook).toBeDefined();
  });

  it('removes old finevibe hooks before installing new ones', () => {
    mockReadFileSync.mockImplementation((filePath) => {
      if (n(String(filePath)) === '/mock/home/.claude/settings.json') {
        return JSON.stringify({
          hooks: {
            Stop: [{
              matcher: '',
              hooks: [{ type: 'command', command: 'echo waiting # finevibe-hook' }],
            }],
          },
        });
      }
      throw enoent();
    });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    // The old finevibe hook should be replaced, not duplicated
    const stopHooks = written.hooks.Stop;
    const fineVibeHookCount = stopHooks.reduce((count: number, m: { hooks: Array<{ command: string }> }) =>
      count + m.hooks.filter((h: { command: string }) => h.command.includes('# finevibe-hook')).length, 0
    );
    // Should have exactly 2 finevibe hooks (status hook + inspector event capture hook)
    expect(fineVibeHookCount).toBe(2);
  });

  it('installs all 25 hook events (7 core + 18 inspector-only)', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const hookEvents = Object.keys(written.hooks);

    const coreEvents = [
      'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
      'Stop', 'StopFailure', 'PermissionRequest',
    ];
    for (const event of coreEvents) {
      expect(hookEvents).toContain(event);
    }

    const inspectorEvents = [
      'PreToolUse', 'PermissionDenied', 'SubagentStart', 'SubagentStop', 'Notification',
      'PreCompact', 'PostCompact', 'SessionEnd', 'TaskCreated', 'TaskCompleted',
      'WorktreeRemove', 'CwdChanged', 'FileChanged',
      'ConfigChange', 'Elicitation', 'ElicitationResult', 'InstructionsLoaded',
      'TeammateIdle',
    ];
    for (const event of inspectorEvents) {
      expect(hookEvents).toContain(event);
    }

    expect(hookEvents).toHaveLength(25);

    // Core hooks should have status writer + event logger (at least 2 hooks)
    for (const event of coreEvents) {
      const matchers = written.hooks[event];
      const allHooks = matchers.flatMap((m: { hooks: Array<{ command: string }> }) => m.hooks);
      // Stop's status writer is stop_status_writer.py — its command line
      // carries no `.status` literal (the writer resolves the file itself),
      // so key its hook on the writer stub token. P2-73: the old stub echoed
      // `.status` verbatim, making this check stub-supplied for Stop.
      expect(allHooks.some((h: { command: string }) =>
        event === 'Stop' ? h.command.includes('stop-writer') : h.command.includes('.status')
      )).toBe(true);
      expect(allHooks.some((h: { command: string }) => h.command.includes('.events'))).toBe(true);
    }

    // PostToolUse event cmd should include event capture
    const toolUseHooks = written.hooks.PostToolUse
      .flatMap((m: { hooks: Array<{ command: string }> }) => m.hooks);
    expect(toolUseHooks.some((h: { command: string }) =>
      h.command.includes('.events')
    )).toBe(true);

    // Inspector-only hooks should have only event logger (no status writer)
    for (const event of inspectorEvents) {
      const matchers = written.hooks[event];
      const allHooks = matchers.flatMap((m: { hooks: Array<{ command: string }> }) => m.hooks);
      expect(allHooks.some((h: { command: string }) => h.command.includes('.status'))).toBe(false);
      expect(allHooks.some((h: { command: string }) => h.command.includes('.events'))).toBe(true);
    }
  });

  // The main agent fires spurious top-level Stop hooks while waiting on parallel
  // subagents. When SubagentStart is supported we route Stop through the
  // subagent-aware writer instead of the naive echo-Stop:completed command.
  it('uses the subagent-aware Stop writer when SubagentStart is supported', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const stopCommands = written.hooks.Stop
      .flatMap((m: { hooks: Array<{ command: string }> }) => m.hooks)
      .map((h: { command: string }) => h.command);
    // Command must carry the arguments the generator supplied — a dropped
    // in-flight-subagent session var (the counter file the writer reads is
    // keyed by it) fails here, not silently.
    expect(stopCommands.some((c: string) =>
      c.includes('stop-writer CLAUDE_IDE_SESSION_ID # finevibe-hook')
    )).toBe(true);
    expect(mockStopStatusCmd).toHaveBeenCalledWith('CLAUDE_IDE_SESSION_ID', '# finevibe-hook');
    expect(stopCommands.some((c: string) => c.includes('echo Stop:completed'))).toBe(false);
    // Still exactly the status writer + the inspector event capture hook.
    const fineVibeHookCount = stopCommands.filter((c: string) => c.includes('# finevibe-hook')).length;
    expect(fineVibeHookCount).toBe(2);
  });

  it('falls back to the echo Stop writer when SubagentStart is unsupported', () => {
    // 2.0.42 supports Stop (min 1.0.38) but not SubagentStart (min 2.0.43).
    vi.mocked(getClaudeVersion).mockReturnValueOnce('2.0.42');
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const stopCommands = written.hooks.Stop
      .flatMap((m: { hooks: Array<{ command: string }> }) => m.hooks)
      .map((h: { command: string }) => h.command);
    expect(stopCommands.some((c: string) => c.includes('echo Stop:completed'))).toBe(true);
    expect(mockStopStatusCmd).not.toHaveBeenCalled();
  });

  it('injects the in-flight subagent counter only into the relevant event scripts', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const bodyOf = eventScriptBody;

    // Counter mutations land in exactly the four counter-affecting scripts.
    // The counter is now a fallback — stop_status_writer.py prefers the Stop
    // payload's `background_tasks` — but it is consulted whenever that payload
    // reports nothing holding (empty *or* absent), so it must still be
    // maintained on every CLI version.
    expect(bodyOf('SubagentStart')).toContain('.subagents');
    expect(bodyOf('SubagentStart')).toContain('n=n+1');
    expect(bodyOf('SubagentStop')).toContain('n=max(0,n-1)');
    // SessionStart resets the counter but skips mid-turn auto-compaction.
    expect(bodyOf('SessionStart')).toContain('"n":0');
    expect(bodyOf('SessionStart')).toContain('!="compact"');
    // PostToolUse only refreshes the timestamp for subagent tool activity.
    expect(bodyOf('PostToolUse')).toContain('.subagents');
    expect(bodyOf('PostToolUse')).toContain('if d.get("agent_id")');
    expect(bodyOf('PostToolUse')).not.toContain('n=n+1');
    // Unrelated event scripts stay counter-free.
    expect(bodyOf('PreToolUse')).not.toContain('.subagents');
    expect(bodyOf('UserPromptSubmit')).not.toContain('.subagents');
  });

  it('wires tool-failure capture onto PostToolUseFailure and nowhere else', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const commandsFor = (event: string) => hookCommandsFor(written, event);

    // The exact emitted command: session-var + marker, as the cleanup and
    // the hook runtime key off them.
    expect(commandsFor('PostToolUseFailure')).toContain('capture-toolfailure CLAUDE_IDE_SESSION_ID # finevibe-hook');
    for (const event of Object.keys(written.hooks)) {
      if (event === 'PostToolUseFailure') continue;
      expect(commandsFor(event).some((c: string) => c.includes('capture-toolfailure'))).toBe(false);
    }
  });

  it('omits PostToolUseFailure on a CLI older than its minimum version', () => {
    // 2.1.118 supports PermissionDenied (2.1.89) but not PostToolUseFailure (2.1.119).
    vi.mocked(getClaudeVersion).mockReturnValueOnce('2.1.118');
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const hookEvents = Object.keys(JSON.parse(settingsWrites()[0]).hooks);
    expect(hookEvents).toContain('PermissionDenied');
    expect(hookEvents).not.toContain('PostToolUseFailure');
  });

  it('requests a longer timeout only for SessionEnd, whose default budget is 1.5s', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    const timeoutsFor = (event: string) => hookHandlersFor(written, event).map((h) => h.timeout);

    expect(timeoutsFor('SessionEnd')).toEqual([5]);
    for (const event of Object.keys(written.hooks)) {
      if (event === 'SessionEnd') continue;
      expect(timeoutsFor(event).every((t: number | undefined) => t === undefined)).toBe(true);
    }
  });

  it('captures only real hook-payload fields into inspector events', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const body = eventScriptBody('Notification');

    // Real per-event fields the timeline renders.
    for (const field of ['notification_type', 'new_cwd', 'teammate_name', 'task_subject', 'action']) {
      expect(body).toContain(`"${field}"`);
    }
    // Captured fields are limited to what something actually reads — there is no
    // generic payload viewer, so an unread field is written, parsed, IPC'd and
    // typed for nothing.
    for (const field of ['load_reason', 'memory_type', 'elicitation_id', 'tool_use_id']) {
      expect(body).not.toContain(`"${field}"`);
    }
    // None of these is a top-level hook-payload field, so the code reading them
    // was dead. `type`/`username` are especially easy to re-add by mistake: they
    // appear in the docs' Elicitation example, but nested inside
    // requested_schema.properties.username.type.
    for (const field of ['config_key', 'question', 'answer', 'username']) {
      expect(body).not.toContain(`"${field}"`);
    }
    expect(body).not.toContain('elicitation_type');
    // Long strings are truncated before hitting the .events log.
    expect(body).toContain('len(v)>2000');
  });

  // PostToolUse now fires only on SUCCESS, so treating any non-empty
  // tool_response as a failure produced a .toolfailure file for every
  // successful tool call. The only PostToolUse-derived signal left is a Read
  // truncated by the token cap, which is a success, not a failure.
  it('derives a .toolfailure from PostToolUse only for a token-capped Read', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const body = eventScriptBody('PostToolUse');

    expect(body).toContain('truncatedByTokenCap');
    expect(body).toContain('tn=="Read"');
    // No blanket "any tool_response is an error" synthesis.
    expect(body).not.toContain('tool_result');
    expect(body).not.toContain('fe=tr');
  });

  // CC >= 2.1.50 treats WorktreeCreate as a path-replacement hook that must
  // create the worktree itself and print the path. Installing an observer hook
  // breaks worktree creation. See issue #110.
  it('does not install a WorktreeCreate hook', () => {
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    installHooks();

    const written = JSON.parse(settingsWrites()[0]);
    expect(Object.keys(written.hooks)).not.toContain('WorktreeCreate');

    const installed = vi.mocked(installEventScript).mock.calls.map(([name]) => name);
    expect(installed).not.toContain('claude_event_WorktreeCreate.py');
  });
});

describe('removeMcpServer writable-path allowlist', () => {
  it('accepts a listed config file the renderer spelled with different casing', () => {
    // The allowlist is built from homedir()/projectPath/configDir; the renderer
    // echoes back the path the list call produced. On Windows the same file
    // arrives with different drive-letter and directory casing, so an exact
    // string compare makes deleting a listed server a silent no-op.
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => n(p).toLowerCase()) as typeof fs.realpathSync);
    mockReadFileSync.mockImplementation((p: fs.PathLike) => {
      if (n(String(p)).toLowerCase().endsWith('/.claude.json')) {
        return JSON.stringify({ mcpServers: { leak: { command: 'x' } } });
      }
      throw enoent();
    });

    removeMcpServer('leak', '/Mock/Home/.claude.json', 'user');

    expect([...atomicWrites().keys()]).toEqual(['/Mock/Home/.claude.json']);
    expect(JSON.parse(atomicWrites().get('/Mock/Home/.claude.json')!).mcpServers).toEqual({});
  });

  it('refuses a write target that is not a known MCP config file', () => {
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => p) as typeof fs.realpathSync);

    expect(() => removeMcpServer('x', '/mock/home/.ssh/authorized_keys', 'user'))
      .toThrow(/Not a writable MCP config path/);
    expect(atomicWrites().size).toBe(0);
  });
});

// 1c69afb: with a profile pinned through CLAUDE_CONFIG_DIR, MCP add/remove/get
// must operate on the pinned profile's config dir. Before the fix, addMcpServer
// always wrote ~/.claude.json and getClaudeConfig always read ~/.claude* — so a
// profiled project registered servers against the default account and the panel
// showed a config the launched CLI never reads; removeMcpServer's allowlist had
// no configDir entries, so deleting a profile server threw.
describe('profile-scoped MCP config', () => {
  const profileDir = path.join('/mock/home', '.finevibe', 'profiles', 'work');
  const profileClaudeJson = path.join(profileDir, '.claude.json');
  const profileConfig = (servers: Record<string, unknown>) => {
    mockReadFileSync.mockImplementation((p: fs.PathLike) => {
      if (n(String(p)) === n(profileClaudeJson)) return JSON.stringify({ mcpServers: servers });
      throw enoent();
    });
  };

  beforeEach(() => {
    // The add-side config-dir gate accepts only dirs the store handed out.
    storeProfiles.push({ configDir: profileDir });
  });

  it('addMcpServer with a config dir writes the profile store, not ~/.claude.json', () => {
    addMcpServer('github', { command: 'npx', args: ['-y', 'srv'] }, 'user', undefined, profileDir);

    expect([...atomicWrites().keys()]).toEqual([n(profileClaudeJson)]);
    expect(JSON.parse(atomicWrites().get(n(profileClaudeJson))!).mcpServers).toEqual({
      github: { command: 'npx', args: ['-y', 'srv'] },
    });
  });

  it('addMcpServer without a config dir keeps writing ~/.claude.json', () => {
    addMcpServer('github', { url: 'http://x' }, 'user');

    expect([...atomicWrites().keys()]).toEqual(['/mock/home/.claude.json']);
  });

  it('addMcpServer refuses a config dir the store never handed out', () => {
    // `configDir` is a verbatim IPC arg and the target is `<configDir>/.claude.json`,
    // which the CLI reads on its next launch - a `~/.ssh` here plants a file in
    // the one directory whose contents other daemons act on.
    expect(() => addMcpServer('x', { url: 'http://x' }, 'user', undefined, path.join('/mock/home', '.ssh')))
      .toThrow(/Not a writable MCP config path/);
    expect(atomicWrites().size).toBe(0);
  });

  it('addMcpServer accepts a config dir below a known project', () => {
    // Custom profile paths live anywhere the user picked, including inside a
    // project; the gate is the store's dir list, not the managed root.
    storeProjects.push('/project');
    const insideProject = path.join('/project', '.finevibe-config');
    mockReadFileSync.mockImplementation(() => { throw enoent(); });

    addMcpServer('github', { url: 'http://x' }, 'user', undefined, insideProject);

    expect([...atomicWrites().keys()]).toEqual([n(path.join(insideProject, '.claude.json'))]);
  });

  it('addMcpServer accepts the profile dir spelled with other casing', () => {
    // Canonical compare, as on the remove side: the store records
    // C:\profiles\work, the renderer sends c:\profiles\work.
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => n(p).toLowerCase()) as typeof fs.realpathSync);

    addMcpServer('github', { url: 'http://x' }, 'user', undefined, n(profileDir).toUpperCase());

    expect([...atomicWrites().keys()].map((k) => k.toLowerCase())).toEqual([n(profileClaudeJson).toLowerCase()]);
  });

  it('getClaudeConfig lists the profile store and not the default account\'s', async () => {
    mockReadFileSync.mockImplementation((p: fs.PathLike) => {
      const key = n(String(p));
      if (key === n(profileClaudeJson)) return JSON.stringify({ mcpServers: { profileServer: { url: 'profile-url' } } });
      if (key === '/mock/home/.claude.json') return JSON.stringify({ mcpServers: { defaultServer: { url: 'default-url' } } });
      throw enoent();
    });

    const config = await getClaudeConfig('/project', profileDir);
    expect(config.mcpServers).toEqual([
      { name: 'profileServer', url: 'profile-url', status: 'configured', scope: 'user', filePath: profileClaudeJson },
    ]);
  });

  it('removeMcpServer deletes from the profile store and writes back only that file', () => {
    profileConfig({ keep: { command: 'k' }, zap: { command: 'z' } });

    removeMcpServer('zap', profileClaudeJson, 'user', undefined, profileDir);

    expect([...atomicWrites().keys()]).toEqual([n(profileClaudeJson)]);
    expect(JSON.parse(atomicWrites().get(n(profileClaudeJson))!).mcpServers).toEqual({
      keep: { command: 'k' },
    });
  });

  it('removeMcpServer accepts the profile file echoed back with different case and separators', () => {
    // 57a0f8a: the allowlist is built from configDir; the renderer echoes the
    // listed path spelled with other casing/separators. Comparing canonical
    // forms (realpath + case fold, mocked here as the folded FS) must accept
    // it; an exact string compare threw and the delete no-opped.
    vi.mocked(fs.realpathSync).mockImplementation(((p: string) => n(p).toLowerCase()) as typeof fs.realpathSync);
    // The folded FS the realpath mock models is case-insensitive, like the
    // Windows/macOS filesystems this tolerance targets: reads must answer for
    // every spelling of the file, not just the exact one.
    mockReadFileSync.mockImplementation((p: fs.PathLike) => {
      if (n(String(p)).toLowerCase() === n(profileClaudeJson).toLowerCase()) {
        return JSON.stringify({ mcpServers: { keep: { command: 'k' }, zap: { command: 'z' } } });
      }
      throw enoent();
    });
    const echoed = n(profileClaudeJson).toUpperCase();

    removeMcpServer('zap', echoed, 'user', undefined, profileDir);

    expect([...atomicWrites().keys()].map((k) => k.toLowerCase())).toEqual([n(echoed).toLowerCase()]);
    expect(JSON.parse([...atomicWrites().values()][0]).mcpServers).toEqual({
      keep: { command: 'k' },
    });
  });

  it('refuses a profile config file when no config dir was given', () => {
    // The profile tree is writable only through a declared configDir; an
    // unpinned remove must not write into it.
    profileConfig({ zap: { command: 'z' } });

    expect(() => removeMcpServer('zap', profileClaudeJson, 'user'))
      .toThrow(/Not a writable MCP config path/);
    expect(atomicWrites().size).toBe(0);
  });
});
