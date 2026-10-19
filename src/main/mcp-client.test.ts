import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeClient {
  connect: (transport: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools: unknown[] }>;
}

const mockState = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  connectImpl: (() => Promise.resolve()) as (transport: unknown) => Promise<void>,
  transportOptions: [] as unknown[],
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect: (transport: unknown) => Promise<void>;
    close = vi.fn(async () => {});
    listTools = vi.fn(async () => ({ tools: [{ name: 't' }] }));
    constructor(_clientInfo: unknown) {
      this.connect = vi.fn((transport: unknown) => mockState.connectImpl(transport));
      mockState.clients.push(this as unknown as FakeClient);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(public url: URL, public options?: unknown) {
      mockState.transportOptions.push(options);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(public url: URL, public options?: unknown) {
      mockState.transportOptions.push(options);
    }
  },
}));

import * as mcp from './mcp-client';

function defer(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function lastClient(): FakeClient {
  return mockState.clients[mockState.clients.length - 1];
}

beforeEach(() => {
  mockState.clients.length = 0;
  mockState.connectImpl = () => Promise.resolve();
});

describe('mcp-client lifecycle', () => {
  it('disconnect while connecting closes the client and drops the late completion', async () => {
    const d = defer();
    mockState.connectImpl = () => d.promise;
    const p = mcp.connect('a', 'http://localhost:3000/mcp');
    const client = lastClient();

    const disc = mcp.disconnect('a');
    d.resolve();
    const result = await p;
    await disc;

    expect(result.success).toBe(false);
    const tools = await mcp.listTools('a');
    expect(tools.success).toBe(false);
    expect(tools.error).toBe('Not connected');
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('disconnectAll while connecting covers the pending entry', async () => {
    const d = defer();
    mockState.connectImpl = () => d.promise;
    const p = mcp.connect('a', 'http://localhost:3000/mcp');
    const client = lastClient();

    const all = mcp.disconnectAll();
    d.resolve();
    await all;
    const result = await p;

    expect(result.success).toBe(false);
    const tools = await mcp.listTools('a');
    expect(tools.success).toBe(false);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('a late completion from an older connect cannot delete a newer one', async () => {
    const da = defer();
    const db = defer();
    mockState.connectImpl = () => da.promise;
    const pa = mcp.connect('a', 'http://a/mcp');
    const clientA = lastClient();

    mockState.connectImpl = () => db.promise;
    const pb = mcp.connect('a', 'http://b/mcp');
    const clientB = lastClient();

    db.resolve();
    const rb = await pb;
    expect(rb.success).toBe(true);

    da.resolve();
    const ra = await pa;
    expect(ra.success).toBe(false);

    // The newer connection survives and stays usable.
    const tools = await mcp.listTools('a');
    expect(tools.success).toBe(true);
    expect(clientB.close).not.toHaveBeenCalled();
    expect(clientA.close).toHaveBeenCalledTimes(1);
  });

  it('a failed handshake releases the partially created client', async () => {
    mockState.connectImpl = () => Promise.reject(new Error('boom'));
    const r = await mcp.connect('a', 'http://a/mcp');
    const client = lastClient();

    expect(r.success).toBe(false);
    expect(r.error).toBe('boom');
    expect(client.close).toHaveBeenCalledTimes(1);

    // The id is reusable after a failure.
    mockState.connectImpl = () => Promise.resolve();
    const r2 = await mcp.connect('a', 'http://a/mcp');
    expect(r2.success).toBe(true);
    const tools = await mcp.listTools('a');
    expect(tools.success).toBe(true);
  });

  it('repeated disconnect closes the client exactly once', async () => {
    await mcp.connect('a', 'http://a/mcp');
    const client = lastClient();

    await mcp.disconnect('a');
    await mcp.disconnect('a');
    await mcp.disconnect('a');

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('a reconnect after disconnect remains usable', async () => {
    await mcp.connect('a', 'http://a/mcp');
    await mcp.disconnect('a');
    await mcp.connect('a', 'http://a/mcp');

    const tools = await mcp.listTools('a');
    expect(tools.success).toBe(true);
  });

  it('disconnectAll abandons a hanging SDK close after the timeout', async () => {
    vi.useFakeTimers();
    try {
      await mcp.connect('a', 'http://a/mcp');
      const client = lastClient();
      client.close = vi.fn(() => new Promise<void>(() => {}));

      const all = mcp.disconnectAll();
      await vi.advanceTimersByTimeAsync(2000);
      await all;

      const tools = await mcp.listTools('a');
      expect(tools.success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pinnedFetch (redirect pinning)', () => {
  const fakeResponse = (init: { status?: number; headers?: Record<string, string>; url?: string }) =>
    ({
      status: init.status ?? 200,
      headers: new Headers(init.headers ?? {}),
      url: init.url ?? '',
    }) as Response;

  it('refuses a redirect to another host, naming the target', async () => {
    // The loopback exemption in mcpUrlPolicy skips the confirm dialog, so a 302
    // from a local endpoint is the path that reaches an unconfirmed host.
    const fetchStub = vi.fn(async () =>
      fakeResponse({ status: 302, headers: { location: 'https://collector.attacker.tld/mcp' } }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      await expect(mcp.pinnedFetch('localhost:9876')('http://localhost:9876/mcp'))
        .rejects.toThrow(/collector\.attacker\.tld/);
      // Refused at the request layer, never followed and inspected after.
      expect(fetchStub.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a redirect with an unparseable Location header', async () => {
    // A malformed Location must surface as a refusal, not as a URL parse error
    // that hides which hop was rejected.
    vi.stubGlobal('fetch', vi.fn(async () =>
      fakeResponse({ status: 302, headers: { location: 'http://%' } })));
    try {
      await expect(mcp.pinnedFetch('localhost:9876')('http://localhost:9876/mcp'))
        .rejects.toThrow(/unparseable Location/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a response arriving from a host other than the confirmed one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ url: 'https://other.example/mcp' })));
    try {
      await expect(mcp.pinnedFetch('localhost:9876')('http://localhost:9876/mcp'))
        .rejects.toThrow(/other\.example/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes a same-host response through untouched', async () => {
    const ok = fakeResponse({ status: 200, url: 'http://localhost:9876/mcp' });
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    try {
      await expect(mcp.pinnedFetch('localhost:9876')('http://localhost:9876/mcp')).resolves.toBe(ok);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('wires the pinned fetch into both transports', async () => {
    // The SDK builds every request from the transport's own fetch option, so a
    // transport constructed without it follows redirects to any host.
    // Plain array state: the lifecycle tests above already pushed entries.
    mockState.transportOptions.length = 0;
    await mcp.connect('stream', 'http://localhost:9876/mcp');
    await mcp.connect('sse', 'http://localhost:9876/sse');
    expect(mockState.transportOptions.map(o => typeof (o as { fetch?: unknown })?.fetch))
      .toEqual(['function', 'function']);
  });
});
