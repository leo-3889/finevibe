// Remote provider config reads (per-host providers plan §2/§3 file plane).
//
// The remote twin of each provider's local getConfig, reading the host's
// config files through the readProviderFile seam. The Provider interface's
// getConfig stays local-fs (its implementations read agents/skills trees);
// remote v1 surfaces what the ProviderConfig shape can carry from JSON
// files over sftp — MCP servers. Agents/skills/commands stay empty:
// ponytail: enumerating those trees remotely is a dir-walk protocol over
// sftp, add it when the host config panel has a real consumer.

import type { McpServer, ProviderConfig, ProviderId } from '../../shared/types';
import { readProviderFile } from './provider-fs';

const EMPTY: ProviderConfig = { mcpServers: [], agents: [], skills: [], commands: [] };

/** Join two posix path fragments (host-side), dropping empty segments. */
function joinPosix(base: string, rel: string): string {
  if (!base) return rel;
  return `${base.replace(/\/+$/, '')}/${rel}`;
}

/** Map a JSON `mcpServers` object to the ProviderConfig shape (pi/claude idiom). */
function mcpServersFromJson(raw: unknown, filePath: string, scope: 'user' | 'project'): McpServer[] {
  const servers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const out: McpServer[] = [];
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof cfg === 'string') {
      out.push({ name, url: cfg, status: 'configured', scope, filePath });
      continue;
    }
    if (cfg === null || typeof cfg !== 'object') continue;
    const c = cfg as { url?: unknown; command?: unknown; args?: unknown };
    const url =
      typeof c.url === 'string' && c.url
        ? c.url
        : [typeof c.command === 'string' ? c.command : undefined,
            ...(Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [])]
            .filter(Boolean)
            .join(' ');
    if (url) out.push({ name, url, status: 'configured', scope, filePath });
  }
  return out;
}

/** Parse a seam-read JSON file; malformed/missing reads contribute no servers. */
async function serversFrom(hostId: string, relPath: string, scope: 'user' | 'project'): Promise<McpServer[]> {
  let raw: string | null;
  try {
    raw = await readProviderFile(hostId, relPath);
  } catch (err) {
    // An unreadable config file is an empty contribution, not a failed read:
    // mirrors the local getConfig readers, which swallow per-file errors and
    // keep the servers they did parse.
    console.warn(`remote config read failed for ${relPath}:`, err);
    return [];
  }
  if (raw === null) return [];
  try {
    return mcpServersFromJson(JSON.parse(raw), relPath, scope);
  } catch {
    return [];
  }
}

/**
 * The host's provider config. `configDir` is the profile's config dir ON
 * THE HOST (absolute posix), already gated by the caller against that host's
 * recorded profiles. `projectPath` is the project path on the host, only
 * consulted by the project-scope files.
 */
export async function getRemoteProviderConfig(
  providerId: ProviderId,
  hostId: string,
  projectPath: string,
  configDir?: string,
): Promise<ProviderConfig> {
  switch (providerId) {
    case 'pi':
    case 'pi-bolt': {
      // Pi's MCP servers live in mcp.json inside the agent tree (the pinned
      // profile's own tree when a configDir is given — same rule as the
      // local getConfig: a fallback to the default dir would show another
      // login's servers, tokens included).
      const mcpPath = joinPosix(configDir ?? '~/.pi/agent', 'mcp.json');
      return { ...EMPTY, mcpServers: await serversFrom(hostId, mcpPath, 'user') };
    }
    case 'claude': {
      // User scope: <configDir|~/.claude>/settings.json + the .mcp.json
      // siblings; project scope: <project>/.claude/settings.json +
      // <project>/.mcp.json. Later sources override by name (local
      // getClaudeConfig's dedupe order, project last = wins).
      const userServers = [
        ...(await serversFrom(hostId, joinPosix(configDir ?? '~/.claude', 'settings.json'), 'user')),
        ...(await serversFrom(hostId, joinPosix(configDir ?? '~', '.mcp.json'), 'user')),
      ];
      const projectServers = projectPath
        ? [
            ...(await serversFrom(hostId, joinPosix(projectPath, '.claude/settings.json'), 'project')),
            ...(await serversFrom(hostId, joinPosix(projectPath, '.mcp.json'), 'project')),
          ]
        : [];
      const byName = new Map<string, McpServer>();
      for (const s of [...userServers, ...projectServers]) byName.set(s.name, s);
      return { ...EMPTY, mcpServers: [...byName.values()] };
    }
    default:
      // omp (config.yml), codex (config.toml), copilot/gemini (own trees):
      // no JSON-over-sftp surface to mirror in v1 — the same answer the
      // local omp getConfig gives.
      return { ...EMPTY };
  }
}
