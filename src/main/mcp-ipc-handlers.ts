import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as mcpClient from './mcp-client';

/** Exact loopback hosts for dev MCP servers; URL.parser lowercases the host. */
const LOCAL_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '::1': true, '[::1]': true };

/**
 * SSRF gate for renderer-supplied MCP URLs: the client transports are SSE +
 * StreamableHTTP (URL over http(s) only), so every other scheme is rejected
 * outright. Non-loopback http(s) needs an explicit user confirm.
 * The exemption is exact-host plus the 127/8 literal — never a name suffix:
 * the gate does no DNS, so trusting a `.localhost` suffix would hand the
 * decision to whatever the resolver/hosts file says, and `evil.localhost`
 * would reach a routable address with no confirm.
 * Empty URL = stdio-style config: nothing to gate.
 */
export function mcpUrlPolicy(url: string): { ok: boolean; needsConfirm: boolean; reason?: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: true, needsConfirm: false };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, needsConfirm: false, reason: 'Invalid MCP URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, needsConfirm: false, reason: `Unsupported MCP URL scheme "${parsed.protocol}" (http/https only)` };
  }
  const host = parsed.hostname;
  // `host in LOCAL_HOSTS` would walk the prototype chain: `constructor`,
  // `__proto__`, `toString` are inherited keys and would hit the exemption,
  // bypassing the confirm dialog. The exact-host promise covers own keys only.
  if (Object.hasOwn(LOCAL_HOSTS, host) || /^127(\.\d{1,3}){3}$/.test(host)) {
    return { ok: true, needsConfirm: false };
  }
  return { ok: true, needsConfirm: true };
}

async function confirmRemoteHost(host: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Connect to MCP server?',
    message: `Connect to ${host}?`,
    detail: 'FineVibe will send requests to this host from the main process. Only continue for servers you trust.',
    buttons: ['Cancel', 'Confirm'],
    defaultId: 0,
    cancelId: 0,
  };
  const win = BrowserWindow.getFocusedWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 1;
}

export function registerMcpHandlers(): void {
  // Errors go back as McpResult.error: the renderer's doConnect renders
  // result.error and a rejected invoke would leave the pane stuck on
  // "Connecting...", so the result channel is the surfacing mechanism here.
  ipcMain.handle('mcp:connect', async (_event, id: string, url: string) => {
    const policy = mcpUrlPolicy(url);
    if (!policy.ok) return { success: false, error: policy.reason ?? 'Rejected MCP URL' };
    if (policy.needsConfirm) {
      let host = url;
      try {
        host = new URL(url.trim()).hostname;
      } catch {
        // Policy already parsed it; unreachable. Keep the raw string as label.
      }
      if (!(await confirmRemoteHost(host))) {
        return { success: false, error: `Connection to ${host} cancelled` };
      }
    }
    return mcpClient.connect(id, url);
  });

  ipcMain.handle('mcp:disconnect', (_event, id: string) =>
    mcpClient.disconnect(id));

  ipcMain.handle('mcp:listTools', (_event, id: string) =>
    mcpClient.listTools(id));

  ipcMain.handle('mcp:listResources', (_event, id: string) =>
    mcpClient.listResources(id));

  ipcMain.handle('mcp:listPrompts', (_event, id: string) =>
    mcpClient.listPrompts(id));

  ipcMain.handle('mcp:callTool', (_event, id: string, name: string, args: Record<string, unknown>) =>
    mcpClient.callTool(id, name, args));

  ipcMain.handle('mcp:readResource', (_event, id: string, uri: string) =>
    mcpClient.readResource(id, uri));

  ipcMain.handle('mcp:getPrompt', (_event, id: string, name: string, args: Record<string, string>) =>
    mcpClient.getPrompt(id, name, args));
}
