import { vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

import * as fs from 'fs';
import * as path from 'path';
import { getGeminiConfig } from './gemini-config';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const n = (p: string) => p.replace(/\\/g, '/');

function mockFiles(rawFiles: Record<string, string>): void {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawFiles)) files[n(k)] = v;
  mockReadFileSync.mockImplementation((p: any) => {
    const content = files[n(String(p))];
    if (content !== undefined) return content;
    throw new Error('ENOENT');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });
});

describe('getGeminiConfig', () => {
  it('returns empty config when no settings files exist', async () => {
    mockFiles({});

    const config = await getGeminiConfig('/project');
    expect(config).toEqual({ mcpServers: [], agents: [], skills: [], commands: [] });
  });

  it('reads MCP servers from user settings.json', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] },
        },
      }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].name).toBe('github');
    expect(config.mcpServers[0].url).toBe('docker');
    expect(config.mcpServers[0].scope).toBe('user');
  });

  it('reads MCP servers from project settings.json', async () => {
    mockFiles({
      '/project/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          slack: { url: 'http://localhost:3000/mcp' },
        },
      }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].name).toBe('slack');
    expect(config.mcpServers[0].url).toBe('http://localhost:3000/mcp');
    expect(config.mcpServers[0].scope).toBe('project');
  });

  it('project-level servers override user-level servers by name', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          github: { command: 'docker-user' },
        },
      }),
      '/project/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          github: { command: 'docker-project' },
        },
      }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0].url).toBe('docker-project');
    expect(config.mcpServers[0].scope).toBe('project');
  });

  it('handles malformed JSON gracefully', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': 'not-json',
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(0);
  });

  it('handles missing mcpServers key gracefully', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': JSON.stringify({ theme: 'dark' }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(0);
  });

  it('skips servers with no url or command', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          empty: { args: ['--verbose'] },
        },
      }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.mcpServers).toHaveLength(0);
  });

  it('always returns empty skills and commands', async () => {
    mockFiles({
      '/mock/home/.gemini/settings.json': JSON.stringify({
        mcpServers: {
          test: { command: 'test-cmd' },
        },
      }),
    });

    const config = await getGeminiConfig('/project');
    expect(config.skills).toEqual([]);
    expect(config.commands).toEqual([]);
  });

  it('reads agents from user and project .gemini/agents directories', async () => {
    mockReaddirSync.mockImplementation((dirPath: any) => {
      const input = n(String(dirPath));
      if (input === '/mock/home/.gemini/agents') return ['cmo.md'] as any;
      if (input === '/project/.gemini/agents') return ['proj.md'] as any;
      throw new Error('ENOENT');
    });
    mockFiles({
      '/mock/home/.gemini/agents/cmo.md': '---\nname: cmo\n---\nhi',
      '/project/.gemini/agents/proj.md': '---\nname: proj\nmodel: gemini-2.0\n---\nbody',
    });

    const config = await getGeminiConfig('/project');
    expect(config.agents).toEqual([
      { name: 'cmo', model: '', category: 'plugin', scope: 'user', filePath: path.join('/mock/home', '.gemini', 'agents', 'cmo.md') },
      { name: 'proj', model: 'gemini-2.0', category: 'plugin', scope: 'project', filePath: path.join('/project', '.gemini', 'agents', 'proj.md') },
    ]);
  });

  it('skips non-.md files and files without a name in frontmatter', async () => {
    mockReaddirSync.mockImplementation((dirPath: any) => {
      const input = n(String(dirPath));
      if (input === '/mock/home/.gemini/agents') return ['ok.md', 'README.txt', 'noname.md'] as any;
      throw new Error('ENOENT');
    });
    mockFiles({
      '/mock/home/.gemini/agents/ok.md': '---\nname: ok\n---\nhi',
      '/mock/home/.gemini/agents/noname.md': '---\ndescription: no name field\n---\nhi',
    });

    const config = await getGeminiConfig('/project');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe('ok');
  });

  it('user-scope agents win over project-scope on name collision', async () => {
    mockReaddirSync.mockImplementation((dirPath: any) => {
      const input = n(String(dirPath));
      if (input === '/mock/home/.gemini/agents' || input === '/project/.gemini/agents') return ['cmo.md'] as any;
      throw new Error('ENOENT');
    });
    mockFiles({
      '/mock/home/.gemini/agents/cmo.md': '---\nname: cmo\n---\nuser',
      '/project/.gemini/agents/cmo.md': '---\nname: cmo\n---\nproject',
    });

    const config = await getGeminiConfig('/project');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].scope).toBe('user');
  });
});
