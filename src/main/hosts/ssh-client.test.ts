import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { HostRecord } from '../../shared/types';
import {
  MAX_CACHED_CONNECTIONS,
  cachedConnectionCount,
  closeConnection,
  connect,
  connectConfigFor,
  exec,
  fingerprintOf,
  setClientFactoryForTests,
} from './ssh-client';

vi.mock('./secrets', () => ({
  getHostSecret: vi.fn((key: string) => (key.startsWith('keypass:') ? null : 'pw-for-host')),
}));

// Mock ssh2 Client: emits ready on construction tick; exec echoes the command.
class FakeClient extends EventEmitter {
  ended = false;
  constructor(config: { host?: string; hostVerifier?: (key: Buffer) => boolean }) {
    super();
    setTimeout(() => {
      // ssh2 calls the configured hostVerifier with the server key before ready.
      config.hostVerifier?.(Buffer.from(`key-for-${config.host}`));
      this.emit('ready');
    }, 0);
  }
  exec(command: string, cb: (err: Error | null, stream: EventEmitter) => void): void {
    const stream = new EventEmitter();
    // Deliver the stream first (ssh2 semantics), then its events, so the
    // caller has attached its listeners before data/close arrive.
    setImmediate(() => {
      cb(null, stream);
      setImmediate(() => {
        stream.emit('data', Buffer.from(`out:${command}`));
        stream.emit('close', 0);
      });
    });
  }
  end(): void {
    this.ended = true;
  }
}

const base: HostRecord = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  name: 'test',
  user: 'dev',
  host: '192.168.2.242',
  port: 2222,
  authKind: 'password',
  managedKey: false,
  enrollmentStatus: 'auth-ok',
};

let made: FakeClient[] = [];
beforeEach(() => {
  made = [];
  setClientFactoryForTests((config) => {
    const c = new FakeClient(config as { host?: string });
    made.push(c);
    return c as never;
  });
});

afterEach(() => {
  closeConnection(base.id);
  setClientFactoryForTests(null);
});

describe('connectConfigFor', () => {
  it('maps record fields (IPv6 brackets stripped, port kept)', () => {
    const cfg = connectConfigFor({ ...base, host: '[fe80::1]' });
    expect(cfg.host).toBe('fe80::1');
    expect(cfg.port).toBe(2222);
    expect(cfg.username).toBe('dev');
    expect(cfg.password).toBe('pw-for-host');
  });

  it('key auth without privateKeyPath throws before connect', () => {
    expect(() => connectConfigFor({ ...base, authKind: 'key', privateKeyPath: undefined })).toThrow(/privateKeyPath/);
  });
});

describe('connect', () => {
  it('resolves with client + SHA256 fingerprint', async () => {
    const { client, fingerprint } = await connect(base);
    expect(client).toBe(made[0]);
    expect(fingerprint).toBe(fingerprintOf(Buffer.from('key-for-192.168.2.242')));
    expect(fingerprint.startsWith('SHA256:')).toBe(true);
  });

  it('reuses the cached connection for the same host', async () => {
    await connect(base);
    await connect(base);
    expect(made).toHaveLength(1);
    expect(cachedConnectionCount()).toBe(1);
  });

  it('forceNew replaces the client', async () => {
    await connect(base);
    await connect(base, { forceNew: true });
    expect(made).toHaveLength(2);
  });

  it('rejects when the client errors before ready', async () => {
    setClientFactoryForTests(() => {
      // Bare emitter: never ready, errors on the next tick.
      const c = new EventEmitter();
      setTimeout(() => c.emit('error', new Error('auth failed')), 0);
      return c as never;
    });
    await expect(connect({ ...base, id: `${base.id}-err` })).rejects.toThrow('auth failed');
    // Failed entry is dropped so the next connect retries fresh.
    expect(cachedConnectionCount()).toBe(0);
  });
});

describe('exec', () => {
  it('runs over the cached connection and resolves stdout', async () => {
    const out = await exec(base, 'echo hi');
    expect(out).toBe('out:echo hi');
    expect(made).toHaveLength(1);
  });
});

describe('connection cache cap', () => {
  it('FIFO-evicts past MAX_CACHED_CONNECTIONS and ends the evicted client', async () => {
    const ids = Array.from({ length: MAX_CACHED_CONNECTIONS + 1 }, (_, i) => ({ ...base, id: `h${i}` }));
    const firsts: FakeClient[] = [];
    for (const rec of ids.slice(0, 3)) {
      await connect(rec);
      firsts.push(made[made.length - 1]);
    }
    // Jump straight to the cap by connecting the remaining ids.
    for (const rec of ids.slice(3)) {
      await connect(rec);
    }
    expect(cachedConnectionCount()).toBe(MAX_CACHED_CONNECTIONS);
    expect(firsts[0].ended).toBe(true);
    for (const rec of ids) closeConnection(rec.id);
  });
});
