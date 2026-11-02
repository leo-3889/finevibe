// Per-host SSH trust store (audit row 35).
//
// The interactive lanes — `spawnShellPty`'s remote shell and `resolveLaunchSpec`'s
// remote provider wrap — run the SYSTEM `ssh -tt`, so they trust a known_hosts
// file, NOT `HostRecord.hostKeyFingerprint`. With no FineVibe-owned file a host
// that is pinned AND approved in-app still accepts a MITM key in the app's own
// terminal whenever the user's `~/.ssh/known_hosts` has no entry for it.
//
// The file is seeded at enrollment from the wire public key ssh-client's
// verifier accepted: the record's pin is `SHA256:<base64(sha256(key))>`, a hash,
// so a known_hosts line can never be derived from it — the handshake key is the
// only honest source. Both lanes then point ssh at the file with
// `StrictHostKeyChecking=yes`, so a key FineVibe never seeded is a hard refuse
// in the app terminal instead of a y/n prompt that would append the attacker's
// key into this very file.
//
// No seeded file (record never enrolled / never pin-verified) = no `-o` flags at
// all: the lane keeps today's behavior of consulting the user's own store.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { HostRecord } from '../../shared/types';

/** File name inside `<userData>/hosts/<id>/` (the managed-key dir, keys.ts). */
export const HOST_TRUST_FILE = 'known_hosts';

export function hostTrustStorePath(userDataDir: string, hostId: string): string {
  return path.join(userDataDir, 'hosts', hostId, HOST_TRUST_FILE);
}

/**
 * The token ssh looks a key up under: the bare host on the default port,
 * `[host]:port` for any other port (OpenSSH writes/reads the bracketed
 * `host:port` form when `-p` is not 22 — a plain-host line never matches).
 * Bracketed IPv6 records (`[fd00::5]`, the registry grammar) lose the brackets,
 * which is the spelling ssh strips them to.
 */
export function knownHostsToken(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return port === 22 ? bare : `[${bare}]:${port}`;
}

/**
 * One `<token> <keytype> <base64>` known_hosts line from the SSH wire public-key
 * blob (the Buffer ssh2 hands `hostVerifier`, the same bytes the pin hashes).
 * The blob is `string(keytype) …` in SSH wire encoding; the keytype is what the
 * line needs verbatim. Throws on an unparsable/unknown type — a junk line in a
 * trust store is worse than none.
 */
export function knownHostsLine(record: HostRecord, serverKey: Buffer): string {
  const len = serverKey.length >= 4 ? serverKey.readUInt32BE(0) : 0;
  const keytype = len > 0 && 4 + len <= serverKey.length ? serverKey.toString('ascii', 4, 4 + len) : '';
  if (!/^(?:ssh|ecdsa|sk)-[A-Za-z0-9-]+$/.test(keytype)) {
    throw new Error(`host ${record.id}: server key is not a recognised SSH public key blob`);
  }
  return `${knownHostsToken(record.host, record.port)} ${keytype} ${serverKey.toString('base64')}`;
}

/**
 * Write `<userData>/hosts/<id>/known_hosts` (0600, parent mkdir -p) for a record
 * whose handshake key just passed the pin gate. Overwrites: a re-pin (row 118
 * rotation) re-seeds with the new key. Returns the path written.
 */
export function seedHostTrustStore(record: HostRecord, serverKey: Buffer): string {
  const line = knownHostsLine(record, serverKey);
  const file = hostTrustStorePath(app.getPath('userData'), record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // `mode` applies on create, which is the only case here (the path is
  // id-derived and FineVibe-owned); a pre-existing file keeps its own mode.
  fs.writeFileSync(file, `${line}\n`, { mode: 0o600 });
  return file;
}

/**
 * The ssh argv a seeded store contributes: point at it and refuse hard. Empty
 * when the host was never seeded, so the caller falls back to the user's store.
 */
export function hostTrustSshArgs(record: HostRecord): string[] {
  const file = hostTrustStorePath(app.getPath('userData'), record.id);
  if (!fs.existsSync(file)) return [];
  return ['-o', `UserKnownHostsFile=${file}`, '-o', 'StrictHostKeyChecking=yes'];
}
