import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SSRF gate on `mcp:connect`: renderer-supplied URLs are policy-checked in
 * main before the client transport is created. Non-loopback http(s) requires
 * a native confirm dialog (buttons ['Cancel','Confirm'], response 1 = go).
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
/** Mirrors mcp-client's private `connections` Map so tests can assert
 * connector state (entry identity, generation, transport URL, closed flag)
 * instead of only counting mock calls. */
type FakeEntry = { generation: number; state: 'connecting' | 'connected'; transportUrl: string; closed: boolean };
const registry = vi.hoisted((): Map<string, FakeEntry> => new Map());
const mockConnect = vi.hoisted(() => vi.fn(async (id: string, url: string) => {
  const generation = (registry.get(id)?.generation ?? 0) + 1;
  registry.set(id, { generation, state: 'connected', transportUrl: url, closed: false });
  return { success: true };
}));
const mockShowMessageBox = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ response: 1 })));
const mockGetFocusedWindow = vi.hoisted(() => vi.fn(() => null as unknown));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => Promise<unknown>) => handlers.set(channel, fn),
  },
  BrowserWindow: {
    getFocusedWindow: () => mockGetFocusedWindow(),
  },
  dialog: {
    // Electron's 1-arg overload shifts args; normalize for assertions.
    showMessageBox: (...args: unknown[]) => {
      const twoArg = args.length > 1;
      return mockShowMessageBox(twoArg ? args[0] : undefined, twoArg ? args[1] : args[0]);
    },
  },
}));


vi.mock('./mcp-client', () => ({
  connect: mockConnect,
  disconnect: vi.fn((id: string) => {
    const entry = registry.get(id);
    if (entry) {
      entry.closed = true;
      registry.delete(id);
    }
    return { success: true };
  }),
  listTools: vi.fn(),
  listResources: vi.fn(),
  listPrompts: vi.fn(),
  callTool: vi.fn(),
  readResource: vi.fn(),
  getPrompt: vi.fn(),
}));

import { mcpUrlPolicy, registerMcpHandlers } from './mcp-ipc-handlers';

type ConnectResult = { success: boolean; error?: string };

async function connect(url: string): Promise<ConnectResult> {
  return (await handlers.get('mcp:connect')!('e', 's1', url)) as ConnectResult;
}

beforeEach(() => {
  handlers.clear();
  registry.clear();
  registerMcpHandlers();
  mockConnect.mockClear();
  mockShowMessageBox.mockClear();
  mockGetFocusedWindow.mockReset();
  mockGetFocusedWindow.mockReturnValue(null);
  mockShowMessageBox.mockResolvedValue({ response: 1 });
});

describe('mcpUrlPolicy', () => {
  it('rejects file: URLs', () => {
    const p = mcpUrlPolicy('file:///etc/passwd');
    expect(p.ok).toBe(false);
    expect(p.reason).toContain('file:');
  });

  it('rejects ws:/wss: (client transports are http(s) only)', () => {
    expect(mcpUrlPolicy('ws://localhost:3000/mcp').ok).toBe(false);
    expect(mcpUrlPolicy('wss://evil.example/mcp').ok).toBe(false);
  });

  it('rejects javascript: and data: (parse fine, are not transports)', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>']) {
      const p = mcpUrlPolicy(url);
      expect(p.ok).toBe(false);
      expect(p.reason).toContain(new URL(url).protocol);
    }
  });

  it('rejects unparseable URLs', () => {
    expect(mcpUrlPolicy('not a url').ok).toBe(false);
    expect(mcpUrlPolicy('//evil.example/mcp').ok).toBe(false);
  });

  it('requires confirm for non-loopback http(s)', () => {
    expect(mcpUrlPolicy('https://evil.example/mcp')).toEqual({ ok: true, needsConfirm: true });
    expect(mcpUrlPolicy('http://evil.example/mcp')).toEqual({ ok: true, needsConfirm: true });
    expect(mcpUrlPolicy('http://169.254.169.254/latest/meta-data')).toEqual({ ok: true, needsConfirm: true });
    expect(mcpUrlPolicy('HTTPS://EVIL.EXAMPLE/MCP')).toEqual({ ok: true, needsConfirm: true });
  });

  it('exempts loopback hosts', () => {
    for (const url of [
      'http://localhost:8787/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://127.0.0.53/mcp',
      'http://[::1]:3000/mcp',
      'http://LOCALHOST/mcp',
    ]) {
      expect(mcpUrlPolicy(url)).toEqual({ ok: true, needsConfirm: false });
    }
  });

  it('exempts spelled-out IPv6 loopback (the URL parser normalizes to [::1])', () => {
    for (const url of [
      'http://[0:0:0:0:0:0:0:1]:3000/mcp',
      'http://[0::1]/mcp',
      'https://[0:0:0:0:0:0:0:1]/sse',
    ]) {
      expect(mcpUrlPolicy(url)).toEqual({ ok: true, needsConfirm: false });
    }
  });

  it('exempts numerically obfuscated 127.x after URL normalization', () => {
    // The WHATWG parser collapses decimal/octal/hex/short IPv4 hosts to
    // 127.0.0.1, so these land in the same 127/8 exemption as the dotted form.
    for (const url of [
      'http://2130706433/mcp',
      'http://0177.0.0.1/mcp',
      'http://0x7f.1/mcp',
      'http://127.1/mcp',
    ]) {
      expect(mcpUrlPolicy(url)).toEqual({ ok: true, needsConfirm: false });
    }
  });

  it('gates on the parsed host, not the userinfo label', () => {
    // An `evil.example@` prefix on a loopback host is userinfo, not a host.
    expect(mcpUrlPolicy('http://user:pw@localhost:8080/mcp')).toEqual({ ok: true, needsConfirm: false });
    // ...and a `localhost@` prefix cannot smuggle a remote host past the gate.
    expect(mcpUrlPolicy('http://localhost@evil.example/mcp')).toEqual({ ok: true, needsConfirm: true });
  });

  it('requires confirm for loopback lookalikes the exemption does not match', () => {
    // Trailing dot, IPv4-mapped IPv6, and suffix lookalikes all fall through
    // to confirm: the exemption is exact-host/anchored-regex, never a prefix.
    // `*.localhost` is a name, and the gate does no DNS, so a suffix
    // exemption would be a resolver/hosts-file trust: `evil.localhost` and the
    // dev-style `mydev.localhost` both need the user's confirm.
    for (const url of [
      'http://localhost./mcp',
      'http://[::ffff:127.0.0.1]/mcp',
      'http://localhost.evil.example/mcp',
      'http://notlocalhost:9000/mcp',
      'http://evil.localhost/mcp',
      'http://mydev.localhost:8080/sse',
    ]) {
      expect(mcpUrlPolicy(url)).toEqual({ ok: true, needsConfirm: true });
    }
  });

  it('accepts stdio-style configs with no URL', () => {
    expect(mcpUrlPolicy('')).toEqual({ ok: true, needsConfirm: false });
    expect(mcpUrlPolicy('   ')).toEqual({ ok: true, needsConfirm: false });
  });
});

describe('mcp:connect handler', () => {
  it('rejects file: without touching the client', async () => {
    const r = await connect('file:///C:/secrets');
    expect(r.success).toBe(false);
    expect(r.error).toContain('file:');
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(registry.size).toBe(0); // no connector entry created
  });

  it('rejects ws: without touching the client', async () => {
    const r = await connect('ws://localhost:3000/mcp');
    expect(r.success).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(registry.size).toBe(0); // no connector entry created
  });

  it('connects loopback URLs with no dialog', async () => {
    const r = await connect('http://localhost:8787/mcp');
    expect(r.success).toBe(true);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledWith('s1', 'http://localhost:8787/mcp');
    expect(registry.get('s1')).toMatchObject({
      state: 'connected',
      transportUrl: 'http://localhost:8787/mcp',
      closed: false,
    });
  });

  it('asks for confirm on a remote host and connects on Confirm', async () => {
    const r = await connect('https://evil.example/mcp');
    expect(r.success).toBe(true);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    const [win, options] = mockShowMessageBox.mock.calls[0];
    expect(win).toBeUndefined(); // no focused window -> 1-arg overload
    expect(options.message).toContain('evil.example');
    expect(options.defaultId).toBe(0); // Cancel is the default
    expect(mockConnect).toHaveBeenCalledWith('s1', 'https://evil.example/mcp');
    expect(registry.get('s1')).toMatchObject({
      generation: 1,
      state: 'connected',
      transportUrl: 'https://evil.example/mcp',
      closed: false,
    });
  });

  it('attaches the dialog to the focused window when present', async () => {
    const win = { title: 'focused' };
    mockGetFocusedWindow.mockReturnValue(win);
    await connect('https://evil.example/mcp');
    expect(mockShowMessageBox.mock.calls[0][0]).toBe(win);
  });

  it('aborts the connect when the confirm is declined', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    const r = await connect('https://evil.example/mcp');
    expect(r.success).toBe(false);
    expect(r.error).toContain('cancelled');
    expect(mockConnect).not.toHaveBeenCalled();
    expect(registry.has('s1')).toBe(false); // no transport was ever registered
  });

  it('makes Cancel the default and cancel-affirmative button', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    const r = await connect('https://evil.example/mcp');
    const [, options] = mockShowMessageBox.mock.calls[0];
    expect(options.buttons).toEqual(['Cancel', 'Confirm']);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(r.success).toBe(false);
    expect(registry.size).toBe(0); // declining the default connects nothing
  });

  it('confirm-cancel leaves an existing connector entry untouched', async () => {
    await connect('http://localhost:8787/mcp'); // seed a live loopback connector
    const before = registry.get('s1')!;
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    const r = await connect('https://evil.example/mcp');
    expect(r.success).toBe(false);
    expect(r.error).toContain('cancelled');
    const after = registry.get('s1')!;
    expect(after).toBe(before); // entry not replaced: no generation bump
    expect(after.generation).toBe(1);
    expect(after.state).toBe('connected');
    expect(after.transportUrl).toBe('http://localhost:8787/mcp');
    expect(after.closed).toBe(false); // the cancel never tore the transport down
  });
});
