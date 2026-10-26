// ssh2 facade (multi-host Phase 1) — the programmatic lane.
//
// All non-interactive work goes through here: connect-test (fingerprint
// capture for TOFU), exec probes, key deployment. Interactive shells keep
// using system `ssh -tt` via pty-manager (the interactive lane).
//
// Connection cache is module-level and capped (module-map-governance): one
// ssh2 Client per hostId, FIFO-evicted past MAX_CACHED_CONNECTIONS, dead
// clients dropped on use. Tests mock `ssh2` via the injectable factory.

import * as fs from 'fs';
import { createHash } from 'crypto';
import { Client } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import type { HostRecord } from '../../shared/types';
import { getHostSecret } from './secrets';

/** Cap for the per-host connection cache (module-map-governance allowlist). */
export const MAX_CACHED_CONNECTIONS = 32;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
/** Sftp ops ride interactive lanes (config reads, sidecar polls): keep them
 * snappy — the enrollment PREREQ_TIMEOUT_MS idiom (10 s), not the 30 s exec
 * default. A wedged sftp channel must never park a UI-adjacent read. */
const DEFAULT_SFTP_TIMEOUT_MS = 10_000;

type ClientFactory = (config: ConnectConfig) => Client;

// ssh2 idiom: construct, then .connect(config) — the constructor takes no
// connection options.
let clientFactory: ClientFactory = (config) => {
  const client = new Client();
  client.connect(config);
  return client;
};
/** Test seam: replace the ssh2 Client constructor (pass null to restore). */
export function setClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory =
    factory ??
    ((config) => {
      const client = new Client();
      client.connect(config);
      return client;
    });
}

interface CachedConnection {
  client: Client;
  ready: Promise<void>;
}

const connections = new Map<string, CachedConnection>();
// FIFO order tracking for eviction (Map preserves insertion order; evict the
// oldest key on insert past the cap).
const insertionOrder: string[] = [];

function evictOldestIfNeeded(): void {
  while (insertionOrder.length > MAX_CACHED_CONNECTIONS) {
    const oldest = insertionOrder[0];
    if (oldest === undefined) break;
    const conn = connections.get(oldest);
    connections.delete(oldest);
    insertionOrder.shift();
    if (conn) conn.client.end();
  }
}

/** Build the ssh2 ConnectConfig from a HostRecord + secrets. Pure-ish (reads secrets store). */
export function connectConfigFor(record: HostRecord): ConnectConfig {
  const config: ConnectConfig = {
    host: record.host.replace(/^\[|\]$/g, ''), // ssh2 wants bare IPv6, not brackets
    port: record.port,
    username: record.user,
  };
  if (record.authKind === 'key') {
    if (!record.privateKeyPath) throw new Error(`host ${record.id}: key auth without privateKeyPath`);
    const privateKey = fs.readFileSync(record.privateKeyPath, 'utf8');
    const passphrase = getHostSecret(`keypass:${record.id}`) ?? undefined;
    config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase;
  } else {
    const password = getHostSecret(record.id);
    if (password === null) throw new Error(`host ${record.id}: password auth but no stored secret`);
    config.password = password;
  }
  return config;
}

/**
 * Connect (or reuse a cached connection) to `record`. Resolves once `ready`
 * fires; rejects on error/timeout. The server fingerprint is captured via
 * the `hostVerifier` seam (TOFU); `verifyHostKey` (enrollment, §4 step 2)
 * rejects the connection when the captured fingerprint does not match the
 * pinned one — the rejection is then the `host-key-changed` error.
 */
export function connect(
  record: HostRecord,
  opts?: { timeoutMs?: number; forceNew?: boolean; verifyHostKey?: (fingerprint: string) => boolean },
): Promise<{ client: Client; fingerprint: string }> {
  const existing = connections.get(record.id);
  if (existing && !opts?.forceNew) {
    return existing.ready.then(() => ({ client: existing.client, fingerprint: existingFingerprint(existing) ?? '' }));
  }
  const config = connectConfigFor(record);
  config.readyTimeout = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let fingerprint = '';
  let refused = false;
  let connRef: CachedConnection | null = null;
  config.hostVerifier = (key: Buffer) => {
    fingerprint = fingerprintOf(key);
    if (connRef) setFingerprint(connRef, fingerprint);
    if (opts?.verifyHostKey && !opts.verifyHostKey(fingerprint)) {
      refused = true;
      return false; // ssh2 refuses the connection
    }
    return true;
  };
  const client = clientFactory(config);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ssh connect timeout ${config.host}:${config.port}`)), (opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) + 1000);
    client.on('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(refused ? new Error('host-key-changed') : err);
    });
    client.on('close', () => {
      clearTimeout(timer);
      reject(refused ? new Error('host-key-changed') : new Error('connection closed before ready'));
    });
  });
  const conn: CachedConnection = { client, ready };
  connRef = conn;
  setFingerprint(conn, fingerprint);
  // forceNew replaces an existing entry: drop its FIFO slot (audit T1 #1) and
  // close the old client so eviction accounting stays exact.
  if (opts?.forceNew) {
    const old = connections.get(record.id);
    if (old) {
      old.client.end();
      connections.delete(record.id);
    }
    const dup = insertionOrder.indexOf(record.id);
    if (dup >= 0) insertionOrder.splice(dup, 1);
  }
  connections.set(record.id, conn);
  insertionOrder.push(record.id);
  evictOldestIfNeeded();
  // On failure, drop the cache entry so the next call retries fresh.
  ready.catch((err: unknown) => {
    // Every remote lane's failure funnels through here — one searchable
    // line per failed connect in <logs>/finevibe.log (owner gate: "check
    // FineVibe logs for issues"). Consumers may ALSO log their own context
    // (fs rails do); this is the lane-level net.
    console.warn(`[hosts] ssh connect failed ${record.user}@${record.host}:${record.port}: ${err instanceof Error ? err.message : String(err)}`);
    if (connections.get(record.id) === conn) {
      connections.delete(record.id);
      const idx = insertionOrder.indexOf(record.id);
      if (idx >= 0) insertionOrder.splice(idx, 1);
    }
  });
  return ready.then(() => ({ client, fingerprint: existingFingerprint(conn) ?? fingerprint }));
}

// ssh2 emits `handshake` before `ready`; store the fingerprint on the
// connection via a side WeakMap so cached reconnects can return it.
const fingerprints = new WeakMap<Client, string>();
function setFingerprint(conn: CachedConnection, fp: string): void {
  if (fp) fingerprints.set(conn.client, fp);
}
function existingFingerprint(conn: CachedConnection): string | undefined {
  return fingerprints.get(conn.client);
}

/** SHA256 fingerprint in OpenSSH form: `SHA256:<base64>`. */
export function fingerprintOf(serverKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(serverKey).digest('base64')}`;
}

/** Run `command` on `record`'s host; resolves with stdout. Closes the channel. */
export function exec(record: HostRecord, command: string, opts?: { timeoutMs?: number }): Promise<string> {
  const timeout = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  return connect(record).then(
    ({ client }) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ssh exec timeout: ${command}`)), timeout);
        client.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          let out = '';
          stream.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8');
          });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`ssh exec exit ${code}: ${command.slice(0, 80)}`));
          });
          stream.on('error', (e: Error) => {
            clearTimeout(timer);
            reject(e);
          });
        });
      }),
  );
}

// --- sftp lane (per-host providers plan §3: the file plane) ---
//
// One sftp subsystem per cached connection, reused across ops (R4: ssh2
// multiplexes channels; the connection cache is the bound point). The
// WeakMap is bounded by construction — a wrapper dies with its client, and
// clients are FIFO-evicted past MAX_CACHED_CONNECTIONS.
const sftpByClient = new WeakMap<Client, Promise<SFTPWrapper>>();

function sftpFor(client: Client): Promise<SFTPWrapper> {
  let p = sftpByClient.get(client);
  if (!p) {
    p = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    // A failed subsystem request must not poison the client slot.
    p.catch(() => sftpByClient.delete(client));
    sftpByClient.set(client, p);
  }
  return p;
}

/** Run one sftp callback-style op with the file-lane timeout bound.
 * The race timer wraps the WHOLE chain — connect, sftp subsystem open, and
 * the op — because a server that accepts the SSH connection but never answers
 * the subsystem request would otherwise hang the caller forever (audit T2 #1:
 * that hang wedged the status poll loop permanently). Budget: the connect
 * budget (readyTimeout + slack, matching connect's own timer) + the op
 * timeout. */
const CONNECT_BUDGET_MS = DEFAULT_CONNECT_TIMEOUT_MS + 1000;
function sftpOp<T>(
  record: HostRecord,
  label: string,
  run: (sftp: SFTPWrapper, done: (err: Error | null, value: T) => void) => void,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const timeout = (opts?.timeoutMs ?? DEFAULT_SFTP_TIMEOUT_MS) + CONNECT_BUDGET_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ssh sftp timeout: ${label}`)), timeout);
    connect(record)
      .then(({ client }) => sftpFor(client))
      .then(
        (sftp) =>
          new Promise<T>((res, rej) =>
            run(sftp, (err, value) => (err ? rej(err) : res(value))),
          ),
      )
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

/** sftp status errors carry the numeric SFTP status code; 2 = No Such File,
 * 1 = EOF (a read positioned past the end — a short read, not a failure,
 * mirroring the local lane returning '' at position > size; audit T2 #10). */
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  return code === 2 || code === 'ENOENT';
}
function isEof(err: unknown): boolean {
  return (err as { code?: number | string } | null)?.code === 1;
}

/**
 * Read a remote text file. Resolves null when the file does not exist —
 * the provider-fs seam maps "missing" to null, matching local ENOENT.
 */
export function sftpRead(record: HostRecord, remotePath: string, opts?: { timeoutMs?: number }): Promise<string | null> {
  return sftpOp<string | null>(
    record,
    `read ${remotePath}`,
    (sftp, done) => sftp.readFile(remotePath, (err, buf) => (err ? done(isNotFound(err) ? null : err, null) : done(null, buf.toString('utf8')))),
    opts,
  );
}

/** Remote file size in bytes, or null when the file does not exist. */
export function sftpStatSize(record: HostRecord, remotePath: string, opts?: { timeoutMs?: number }): Promise<number | null> {
  return sftpOp<number | null>(
    record,
    `stat ${remotePath}`,
    (sftp, done) => sftp.stat(remotePath, (err, stats) => (err ? done(isNotFound(err) ? null : err, null) : done(null, stats.size))),
    opts,
  );
}

/**
 * Paged read: up to `length` bytes from `position` (the transcript-tail
 * primitive — never opens the whole file). Null when the file is gone.
 */
export function sftpReadRange(
  record: HostRecord,
  remotePath: string,
  position: number,
  length: number,
  opts?: { timeoutMs?: number },
): Promise<Buffer | null> {
  return sftpOp<Buffer | null>(
    record,
    `read ${remotePath}@${position}+${length}`,
    (sftp, done) => {
      sftp.open(remotePath, 'r', (err, handle) => {
        if (err) {
          done(isNotFound(err) ? null : err, null);
          return;
        }
        const buf = Buffer.alloc(length);
        // SFTP permits short reads (OpenSSH's sftp-server caps a single READ
        // at ~32 KB): loop until `length` bytes, 0 bytes, or error, so a
        // window near the cap is the FULL window, not its oldest slice
        // (audit T2 #6). EOF at any position is a short read, not a failure
        // (audit T2 #10 — the stat→read race can truncate under us; the
        // local lane returns '' at position > size).
        const readLoop = (offset: number): void => {
          sftp.read(handle, buf, offset, length - offset, position + offset, (readErr, bytesRead) => {
            if (readErr) {
              // The handle must close even when the read failed, or the server
              // keeps the fd open for the life of the connection.
              sftp.close(handle, () => {
                if (isEof(readErr)) done(null, buf.subarray(0, offset));
                else done(isNotFound(readErr) ? null : readErr, null);
              });
              return;
            }
            const next = offset + Math.max(0, bytesRead ?? 0);
            if (next === offset || next >= length) {
              sftp.close(handle, () => done(null, buf.subarray(0, next)));
              return;
            }
            readLoop(next);
          });
        };
        readLoop(0);
      });
    },
    opts,
  );
}

/** List one remote directory's entry names (empty list for an empty dir). */
export function sftpListDir(record: HostRecord, remoteDir: string, opts?: { timeoutMs?: number }): Promise<string[] | null> {
  return sftpOp<string[] | null>(
    record,
    `ls ${remoteDir}`,
    (sftp, done) =>
      sftp.readdir(remoteDir, (err, list) =>
        err ? done(isNotFound(err) ? null : err, null) : done(null, list.map((e) => e.filename)),
      ),
    opts,
  );
}

/**
 * readdir with the dir-ness the file browser needs (readdir's attrs carry the
 * mode; the name-only sftpListDir cannot answer "is this a directory").
 * Null when the directory is gone.
 */
export function sftpListDirEntries(
  record: HostRecord,
  remoteDir: string,
  opts?: { timeoutMs?: number },
): Promise<Array<{ name: string; isDirectory: boolean }> | null> {
  return sftpOp<Array<{ name: string; isDirectory: boolean }> | null>(
    record,
    `ls ${remoteDir}`,
    (sftp, done) =>
      sftp.readdir(remoteDir, (err, list) =>
        err
          ? done(isNotFound(err) ? null : err, null)
          : done(null, list.map((e) => ({ name: e.filename, isDirectory: e.attrs.isDirectory() }))),
      ),
    opts,
  );
}

/** Full stat for the remote file browser; null when the path does not exist. */
export function sftpStat(
  record: HostRecord,
  remotePath: string,
  opts?: { timeoutMs?: number },
): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
  return sftpOp<{ size: number; mtimeMs: number; isDirectory: boolean } | null>(
    record,
    `stat ${remotePath}`,
    (sftp, done) =>
      sftp.stat(remotePath, (err, stats) =>
        err
          ? done(isNotFound(err) ? null : err, null)
          : done(null, { size: stats.size, mtimeMs: stats.mtime * 1000, isDirectory: stats.isDirectory() }),
      ),
    opts,
  );
}

/**
 * Write a remote text file (create/truncate). Enrollment's settings merge is
 * the only writer; the parent dir must already exist (the exec lane owns
 * mkdir -p, per the enrollment idiom).
 */
export function sftpWrite(record: HostRecord, remotePath: string, content: string, opts?: { timeoutMs?: number }): Promise<void> {
  return sftpOp<void>(
    record,
    `write ${remotePath}`,
    (sftp, done) => sftp.writeFile(remotePath, content, (err) => (err ? done(err, undefined) : done(null, undefined))),
    opts,
  );
}

/** Close and forget a host's cached connection (host delete / tests). */
export function closeConnection(hostId: string): void {
  const conn = connections.get(hostId);
  if (!conn) return;
  connections.delete(hostId);
  const idx = insertionOrder.indexOf(hostId);
  if (idx >= 0) insertionOrder.splice(idx, 1);
  conn.client.end();
}

/** Test seam: current cache size. */
export function cachedConnectionCount(): number {
  return connections.size;
}
