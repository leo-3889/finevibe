import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpResult } from '../shared/types';

export type { McpResult };

interface McpConnection {
  client: Client;
  transport: SSEClientTransport | StreamableHTTPClientTransport;
  closed: boolean;
}

interface McpEntry {
  generation: number;
  state: 'connecting' | 'connected';
  conn: McpConnection | null;
}

/** Bounded teardown: abandon an SDK close that hangs this long. */
const CLOSE_TIMEOUT_MS = 2000;

const connections = new Map<string, McpEntry>();
/** Resolve when `promise` settles or after `ms`, whichever comes first. Never rejects. */
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** Close a partially or fully created connection at most once, with a bounded timeout. */
function closeConnection(conn: McpConnection): Promise<void> {
  if (conn.closed) return Promise.resolve();
  conn.closed = true;
  const close = Promise.resolve()
    .then(() => conn.client.close())
    .catch(() => {
      // ignore close errors
    });
  return settleWithin(close, CLOSE_TIMEOUT_MS);
}

function getConnected(id: string): McpConnection | undefined {
  const entry = connections.get(id);
  if (!entry || entry.state !== 'connected' || !entry.conn) return undefined;
  return entry.conn;
}

/** URL parse that never throws; null = unparseable, which is always refused. */
function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * fetch wrapper pinning a transport to the host the user confirmed.
 *
 * The SDK builds its requests with plain fetch and the spec default
 * `redirect: 'follow'`, and `mcpUrlPolicy` only ever sees the URL the user
 * typed. A loopback-exempt endpoint (the no-confirm path) can answer
 * `302 -> https://attacker.tld/`, and the whole MCP handshake plus every
 * JSON-RPC payload built from user content then leaves the main process for a
 * host no dialog ever named.
 *
 * Redirects are refused outright (`redirect: 'manual'`) and the final response
 * origin is checked as well: an MCP endpoint is a single fixed URL, so a real
 * server never needs to hop hosts, and refusing is strictly safer than
 * re-running the confirm dialog for the hop.
 */
export function pinnedFetch(approvedHost: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const base = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const location = response.headers.get('location');
      // A malformed Location is refused, never followed: it is the host we
      // cannot name, so it cannot be the approved one.
      const target = location ? parseUrl(location, base)?.origin : null;
      throw new Error(
        `MCP server redirected to ${target ?? 'an unparseable Location header'}; `
        + `only the confirmed host (${approvedHost}) is allowed.`,
      );
    }
    const finalUrl = response.url ? parseUrl(response.url) : null;
    if (finalUrl && finalUrl.host !== approvedHost) {
      throw new Error(
        `MCP server answered from ${finalUrl.host}; only the confirmed host (${approvedHost}) is allowed.`,
      );
    }
    return response;
  };
}

export async function connect(id: string, url: string): Promise<McpResult> {
  const previous = connections.get(id);
  const entry: McpEntry = {
    generation: (previous?.generation ?? 0) + 1,
    state: 'connecting',
    conn: null,
  };
  connections.set(id, entry);
  if (previous?.conn) {
    void closeConnection(previous.conn);
  }

  let conn: McpConnection;
  try {
    // One host is approved: the URL the policy (and, for remote hosts, the
    // user's confirmation) was evaluated against.
    const approvedHost = new URL(url).host;
    const transportOptions = { fetch: pinnedFetch(approvedHost) };
    const transport = url.endsWith('/sse')
      ? new SSEClientTransport(new URL(url), transportOptions)
      : new StreamableHTTPClientTransport(new URL(url), transportOptions);
    const client = new Client({ name: 'vibeyard-mcp-inspector', version: '1.0.0' });
    conn = { client, transport, closed: false };
  } catch (err) {
    if (connections.get(id) === entry) connections.delete(id);
    return { success: false, error: (err as Error).message };
  }

  // Publish before awaiting the handshake so a concurrent disconnect can find and close it.
  entry.conn = conn;

  try {
    await conn.client.connect(conn.transport);
  } catch (err) {
    if (connections.get(id) === entry) connections.delete(id);
    await closeConnection(conn);
    return { success: false, error: (err as Error).message };
  }

  if (connections.get(id) !== entry) {
    // A disconnect (or a newer connect) invalidated this attempt: close it
    // instead of installing a stale connection.
    await closeConnection(conn);
    return { success: false, error: 'Connection cancelled' };
  }

  entry.state = 'connected';
  return { success: true };
}

export async function disconnect(id: string): Promise<McpResult> {
  const entry = connections.get(id);
  if (!entry) return { success: true };
  connections.delete(id);
  if (entry.conn) {
    await closeConnection(entry.conn);
  }
  return { success: true };
}

export async function listTools(id: string): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.listTools();
    return { success: true, data: result.tools };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function listResources(id: string): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.listResources();
    return { success: true, data: result.resources };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function listPrompts(id: string): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.listPrompts();
    return { success: true, data: result.prompts };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function callTool(id: string, name: string, args: Record<string, unknown>): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.callTool({ name, arguments: args });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function readResource(id: string, uri: string): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.readResource({ uri });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function getPrompt(id: string, name: string, args: Record<string, string>): Promise<McpResult> {
  const conn = getConnected(id);
  if (!conn) return { success: false, error: 'Not connected' };
  try {
    const result = await conn.client.getPrompt({ name, arguments: args });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function disconnectAll(): Promise<void> {
  const entries = [...connections.values()];
  connections.clear();
  await Promise.all(entries.filter((e) => e.conn).map((e) => closeConnection(e.conn!)));
}
