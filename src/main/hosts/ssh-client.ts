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
import type { ConnectConfig } from 'ssh2';
import type { HostRecord } from '../../shared/types';
import { getHostSecret } from './secrets';

/** Cap for the per-host connection cache (module-map-governance allowlist). */
export const MAX_CACHED_CONNECTIONS = 32;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

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
  ready.catch(() => {
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
