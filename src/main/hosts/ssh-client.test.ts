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
  sftpListDir,
  sftpRead,
  sftpReadRange,
  sftpStatSize,
  sftpWrite,
} from './ssh-client';

vi.mock('./secrets', () => ({
  getHostSecret: vi.fn((key: string) => (key.startsWith('keypass:') ? null : 'pw-for-host')),
}));

// ssh2-style SFTP wrapper: an in-memory file map, callbacks on setImmediate.
class FakeSftp extends EventEmitter {
  files = new Map<string, Buffer>();
  dirs = new Map<string, string[]>();
  /** When set, every op's callback fires with an error carrying this code. */
  failCode: number | null = null;
  /** When true, callbacks never fire (timeout tests). */
  hang = false;
  /** Max bytes a single READ yields (server short-read simulation). */
  readChunk = Infinity;
  /** READ at position >= eofAt answers with EOF status 1 (stat→read race). */
  eofAt: number | null = null;
  closed: string[] = [];

  private cb<T>(cb: (err: Error | null, value: T) => void, err: Error | null, value: T): void {
    setImmediate(() => cb(err, value));
  }
  private err(code: number): Error {
    return Object.assign(new Error(`sftp status ${code}`), { code });
  }
  sftp(cb: (err: Error | null, sftp: FakeSftp) => void): void {
    this.cb(cb, null, this);
  }
  readFile(p: string, cb: (err: Error | null, buf: Buffer) => void): void {
    if (this.hang) return;
    if (this.failCode !== null) return this.cb(cb, this.err(this.failCode), null as never);
    const buf = this.files.get(p);
    buf ? cb(null, buf) : this.cb(cb, this.err(2), null as never);
  }
  stat(p: string, cb: (err: Error | null, stats: { size: number }) => void): void {
    if (this.hang) return;
    if (this.failCode !== null) return this.cb(cb, this.err(this.failCode), null as never);
    const buf = this.files.get(p);
    buf ? cb(null, { size: buf.length }) : this.cb(cb, this.err(2), null as never);
  }
  open(p: string, _flag: string, cb: (err: Error | null, handle?: string) => void): void {
    if (this.hang) return;
    if (this.failCode !== null) return this.cb(cb, this.err(this.failCode), undefined as never);
    const buf = this.files.get(p);
    buf ? cb(null, `h:${p}`) : this.cb(cb, this.err(2), undefined as never);
  }
  read(
    handle: string,
    buf: Buffer,
    offset: number,
    length: number,
    position: number,
    cb: (err: Error | null, bytesRead?: number) => void,
  ): void {
    if (this.hang) return;
    const src = this.files.get(handle.slice(2));
    if (!src) return this.cb(cb, this.err(2), undefined as never);
    if (this.eofAt !== null && position >= this.eofAt) return this.cb(cb, this.err(1), undefined as never);
    const slice = src.subarray(position, position + Math.min(length, this.readChunk));
    slice.copy(buf, offset);
    cb(null, slice.length);
  }
  close(handle: string, cb: (err: Error | null) => void): void {
    this.closed.push(handle);
    this.cb(cb, null, undefined);
  }
  readdir(p: string, cb: (err: Error | null, list?: { filename: string }[]) => void): void {
    if (this.hang) return;
    if (this.failCode !== null) return this.cb(cb, this.err(this.failCode), undefined as never);
    const list = this.dirs.get(p);
    list ? cb(null, list.map((filename) => ({ filename }))) : this.cb(cb, this.err(2), undefined as never);
  }
  writeFile(p: string, content: string, cb: (err: Error | null) => void): void {
    if (this.hang) return;
    if (this.failCode !== null) return this.cb(cb, this.err(this.failCode), undefined);
    this.files.set(p, Buffer.from(content));
    cb(null);
  }
}

// Mock ssh2 Client: emits ready on construction tick; exec echoes the command.
class FakeClient extends EventEmitter {
  ended = false;
  sftpInstances = 0;
  fakeSftp = new FakeSftp();
  /** Subsystem-open hang (audit T2 #1): the sftp() callback never fires. */
  sftpHang = false;
  constructor(config: { host?: string; hostVerifier?: (key: Buffer) => boolean }) {
    super();
    setTimeout(() => {
      // ssh2 calls the configured hostVerifier with the server key before ready.
      config.hostVerifier?.(Buffer.from(`key-for-${config.host}`));
      this.emit('ready');
    }, 0);
  }
  sftp(cb: (err: Error | null, sftp: FakeSftp) => void): void {
    this.sftpInstances += 1;
    if (this.sftpHang) return;
    this.fakeSftp.sftp(cb);
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

describe('sftp lane', () => {
  it('read resolves content; missing (status 2) resolves null', async () => {
    await connect(base);
    made[0].fakeSftp.files.set('/home/dev/.claude/settings.json', Buffer.from('{"a":1}'));
    expect(await sftpRead(base, '/home/dev/.claude/settings.json')).toBe('{"a":1}');
    expect(await sftpRead(base, '/home/dev/nope.json')).toBeNull();
  });

  it('non-missing sftp errors propagate (not swallowed as null)', async () => {
    await connect(base);
    made[0].fakeSftp.failCode = 3; // permission denied
    await expect(sftpRead(base, '/x')).rejects.toThrow(/status 3/);
    await expect(sftpStatSize(base, '/x')).rejects.toThrow(/status 3/);
  });

  it('one sftp subsystem per connection, reused across ops', async () => {
    await sftpRead(base, '/a');
    await sftpRead(base, '/b');
    expect(made).toHaveLength(1);
    expect(made[0].sftpInstances).toBe(1);
  });

  it('readRange pages the file and always closes the handle', async () => {
    await connect(base);
    const s = made[0].fakeSftp;
    s.files.set('/big.jsonl', Buffer.from('0123456789'));
    const buf = await sftpReadRange(base, '/big.jsonl', 4, 3);
    expect(buf?.toString()).toBe('456');
    expect(s.closed).toEqual(['h:/big.jsonl']);
    // A failed read still closes the handle (no leaked fd on the server).
    s.read = (_h: string, _b: Buffer, _o: number, _l: number, _p: number, cb: (e: Error | null, n?: number) => void) => {
      cb(Object.assign(new Error('read failed'), { code: 4 }));
    };
    await expect(sftpReadRange(base, '/big.jsonl', 0, 3)).rejects.toThrow(/read failed/);
    expect(s.closed).toEqual(['h:/big.jsonl', 'h:/big.jsonl']);
  });

  it('stat/list/write resolve; missing stat/list resolve null', async () => {
    await connect(base);
    const s = made[0].fakeSftp;
    s.files.set('/f', Buffer.from('abc'));
    expect(await sftpStatSize(base, '/f')).toBe(3);
    expect(await sftpStatSize(base, '/gone')).toBeNull();
    s.dirs.set('/d', ['a', 'b']);
    expect(await sftpListDir(base, '/d')).toEqual(['a', 'b']);
    expect(await sftpListDir(base, '/gone')).toBeNull();
    await sftpWrite(base, '/w', 'hello');
    expect(s.files.get('/w')?.toString()).toBe('hello');
  });

  it('a wedged sftp op hits the timeout, not a hang', async () => {
    await connect(base);
    made[0].fakeSftp.hang = true;
    await expect(sftpRead(base, '/x', { timeoutMs: 30 })).rejects.toThrow(/sftp timeout/);
  });

  it('a wedged SUBSYSTEM OPEN hits the timeout too (audit T2 #1)', async () => {
    // The server accepts the SSH connection (ready fires) but the sftp
    // subsystem request never answers: the race timer must cover connect +
    // sftpFor, not just the op — the old placement hung the status poll
    // loop permanently.
    vi.useFakeTimers();
    try {
      const p = sftpRead(base, '/x', { timeoutMs: 30 });
      made[0].sftpHang = true; // after connect resolves, sftp() never calls back
      const settled = vi.fn();
      void p.then(() => settled('resolved'), () => settled('rejected'));
      // Budget = op timeout + connect budget (10 s + 1 s): short enough to
      // fire well before any hang becomes permanent.
      await vi.advanceTimersByTimeAsync(11_030 + 50);
      expect(settled).toHaveBeenCalledWith('rejected');
      await expect(p).rejects.toThrow(/sftp timeout: read \/x/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('readRange loops over server short reads to the full length (audit T2 #6)', async () => {
    await connect(base);
    const s = made[0].fakeSftp;
    s.files.set('/big.jsonl', Buffer.from('0123456789ABCDEF'));
    // OpenSSH-style read cap: every READ yields at most 4 bytes.
    s.readChunk = 4;
    const buf = await sftpReadRange(base, '/big.jsonl', 2, 12);
    expect(buf?.toString()).toBe('23456789ABCD'); // bytes 2..14, in 4-byte chunks
    expect(s.closed).toEqual(['h:/big.jsonl']);
  });

  it('EOF during readRange is a short read, not an error (audit T2 #10)', async () => {
    await connect(base);
    const s = made[0].fakeSftp;
    s.files.set('/f', Buffer.from('abc'));
    // Stat says the file is bigger (stat→read race: it truncated under us);
    // the server answers READ past EOF with status 1.
    s.eofAt = 2;
    const buf = await sftpReadRange(base, '/f', 0, 10);
    expect(buf?.toString()).toBe('abc'); // 3 bytes read, then the file hit EOF
    expect(s.closed).toEqual(['h:/f']);
    // A read positioned fully past EOF resolves empty (matches the local
    // lane's '' at position > size).
    s.eofAt = 0;
    const empty = await sftpReadRange(base, '/f', 5, 10);
    expect(empty?.toString()).toBe('');
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
