import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SSRF gate on `mcp:connect`: renderer-supplied URLs are policy-checked in
 * main before the client transport is created. Non-loopback http(s) requires
 * a native confirm dialog (buttons ['Cancel','Confirm'], response 1 = go).
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const mockConnect = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ success: true })));
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
  disconnect: vi.fn(),
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

  it('rejects unparseable URLs', () => {
    expect(mcpUrlPolicy('not a url').ok).toBe(false);
    expect(mcpUrlPolicy('//evil.example/mcp').ok).toBe(false);
  });

  it('requires confirm for non-loopback http(s)', () => {
    expect(mcpUrlPolicy('https://evil.example/mcp')).toEqual({ ok: true, needsConfirm: true });
    expect(mcpUrlPolicy('http://169.254.169.254/latest/meta-data')).toEqual({ ok: true, needsConfirm: true });
  });

  it('exempts loopback hosts', () => {
    for (const url of [
      'http://localhost:8787/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://127.0.0.53/mcp',
      'http://[::1]:3000/mcp',
      'http://mydev.localhost:8080/sse',
      'http://LOCALHOST/mcp',
    ]) {
      expect(mcpUrlPolicy(url)).toEqual({ ok: true, needsConfirm: false });
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
  });

  it('rejects ws: without touching the client', async () => {
    const r = await connect('ws://localhost:3000/mcp');
    expect(r.success).toBe(false);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('connects loopback URLs with no dialog', async () => {
    const r = await connect('http://localhost:8787/mcp');
    expect(r.success).toBe(true);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalledWith('s1', 'http://localhost:8787/mcp');
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
  });
});
