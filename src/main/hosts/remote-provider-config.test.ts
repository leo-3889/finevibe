import { beforeEach, describe, expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn<(hostId: string, relPath: string) => Promise<string | null>>());
vi.mock('./provider-fs', () => ({ readProviderFile: read }));

import { getRemoteProviderConfig } from './remote-provider-config';

function mcpJson(servers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: servers });
}

beforeEach(() => {
  read.mockReset().mockResolvedValue(null);
});

describe('getRemoteProviderConfig — pi / pi-bolt', () => {
  it('reads mcp.json from the pinned config dir, mapping url and command forms', async () => {
    read.mockImplementation(async (_h, p) =>
      p === '/home/dev/.finevibe/profiles/p1/mcp.json'
        ? mcpJson({
            remote: { url: 'https://x/mcp' },
            local: { command: 'npx', args: ['-y', 'pkg'] },
            bare: 'https://bare/mcp',
            junk: 42,
          })
        : null,
    );
    const cfg = await getRemoteProviderConfig('pi', 'lab', '/home/dev/proj', '/home/dev/.finevibe/profiles/p1');
    expect(cfg.agents).toEqual([]);
    expect(cfg.mcpServers).toEqual([
      { name: 'remote', url: 'https://x/mcp', status: 'configured', scope: 'user', filePath: '/home/dev/.finevibe/profiles/p1/mcp.json' },
      { name: 'local', url: 'npx -y pkg', status: 'configured', scope: 'user', filePath: '/home/dev/.finevibe/profiles/p1/mcp.json' },
      { name: 'bare', url: 'https://bare/mcp', status: 'configured', scope: 'user', filePath: '/home/dev/.finevibe/profiles/p1/mcp.json' },
    ]);
  });

  it('defaults to the ~/.pi/agent tree and never falls back to a second dir', async () => {
    await getRemoteProviderConfig('pi-bolt', 'lab', '/home/dev/proj');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('lab', '~/.pi/agent/mcp.json');
  });

  it('malformed JSON contributes nothing and does not throw', async () => {
    read.mockResolvedValue('{oops');
    expect((await getRemoteProviderConfig('pi', 'lab', '/x')).mcpServers).toEqual([]);
  });

  it('an unreadable file is an empty contribution, not a failed read', async () => {
    read.mockRejectedValue(new Error('connection closed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await getRemoteProviderConfig('pi', 'lab', '/x')).mcpServers).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('getRemoteProviderConfig — claude', () => {
  it('merges user and project scope; project wins by name', async () => {
    read.mockImplementation(async (_h, p) => {
      if (p === '~/.claude/settings.json') return mcpJson({ shared: { url: 'user-url' }, mine: { url: 'u2' } });
      if (p === '~/.mcp.json') return mcpJson({ homeFile: 'https://home/mcp' });
      if (p === '/home/dev/proj/.claude/settings.json') return mcpJson({ shared: { url: 'project-url' } });
      if (p === '/home/dev/proj/.mcp.json') return mcpJson({ projFile: { url: 'https://proj/mcp' } });
      return null;
    });
    const cfg = await getRemoteProviderConfig('claude', 'lab', '/home/dev/proj');
    const byName = new Map(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName.get('shared')).toMatchObject({ url: 'project-url', scope: 'project' });
    expect(byName.get('mine')).toMatchObject({ url: 'u2', scope: 'user' });
    expect(byName.get('homeFile')).toMatchObject({ url: 'https://home/mcp', scope: 'user' });
    expect(byName.get('projFile')).toMatchObject({ url: 'https://proj/mcp', scope: 'project' });
  });

  it('a profile configDir redirects the user-scope settings read', async () => {
    await getRemoteProviderConfig('claude', 'lab', '/home/dev/proj', '/home/dev/.finevibe/profiles/c1');
    expect(read).toHaveBeenCalledWith('lab', '/home/dev/.finevibe/profiles/c1/settings.json');
    expect(read).toHaveBeenCalledWith('lab', '/home/dev/.finevibe/profiles/c1/.mcp.json');
  });
});

describe('getRemoteProviderConfig — providers without a JSON surface', () => {
  it('omp answers the empty config and reads nothing (YAML, like the local twin)', async () => {
    expect(await getRemoteProviderConfig('omp', 'lab', '/x')).toEqual({
      mcpServers: [], agents: [], skills: [], commands: [],
    });
    expect(read).not.toHaveBeenCalled();
  });
});

// Phase 4c: the config plane reaches 7/7 — codex (TOML), copilot and gemini
// (JSON) join pi/pi-bolt/omp/claude.
describe('getRemoteProviderConfig — codex (Phase 4c)', () => {
  it('parses [mcp_servers.*] from config.toml, user + project, project wins', async () => {
    read.mockImplementation(async (_h, p) => {
      if (p === '~/.codex/config.toml') return '[mcp_servers.shared]\ncommand = "user-cmd"\n[mcp_servers.uonly]\nurl = "https://u/mcp"\n';
      if (p === '/x/.codex/config.toml') return '[mcp_servers.shared]\ncommand = "project-cmd"\n';
      return null;
    });
    const cfg = await getRemoteProviderConfig('codex', 'lab', '/x');
    const byName = new Map(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName.get('shared')).toMatchObject({ url: 'project-cmd', scope: 'project' });
    expect(byName.get('uonly')).toMatchObject({ url: 'https://u/mcp', scope: 'user' });
  });

  it('a profile configDir redirects the user-scope toml read', async () => {
    await getRemoteProviderConfig('codex', 'lab', '/x', '/home/dev/.finevibe/profiles/x1');
    expect(read).toHaveBeenCalledWith('lab', '/home/dev/.finevibe/profiles/x1/config.toml');
  });
});

describe('getRemoteProviderConfig — copilot (Phase 4c)', () => {
  it('merges mcp-config.json pair; USER wins on collision (local rule)', async () => {
    read.mockImplementation(async (_h, p) => {
      if (p === '~/.copilot/mcp-config.json') return mcpJson({ shared: { url: 'user-url' } });
      if (p === '/x/.copilot/mcp-config.json') return mcpJson({ shared: { url: 'project-url' }, pj: { url: 'p' } });
      return null;
    });
    const cfg = await getRemoteProviderConfig('copilot', 'lab', '/x');
    const byName = new Map(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName.get('shared')).toMatchObject({ url: 'user-url', scope: 'user' });
    expect(byName.get('pj')).toMatchObject({ scope: 'project' });
  });
});

describe('getRemoteProviderConfig — gemini (Phase 4c)', () => {
  it('merges settings.json pair; project overrides by name (local order)', async () => {
    read.mockImplementation(async (_h, p) => {
      if (p === '~/.gemini/settings.json') return mcpJson({ shared: { url: 'user-url' } });
      if (p === '/x/.gemini/settings.json') return mcpJson({ shared: { url: 'project-url' } });
      return null;
    });
    const cfg = await getRemoteProviderConfig('gemini', 'lab', '/x');
    const byName = new Map(cfg.mcpServers.map((s) => [s.name, s]));
    expect(byName.get('shared')).toMatchObject({ url: 'project-url', scope: 'project' });
  });
});
