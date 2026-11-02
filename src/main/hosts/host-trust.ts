// Per-host SSH trust store (audit row 35).
//
// The interactive lanes — `spawnShellPty`'s remote shell and `resolveLaunchSpec`'s
// remote provider wrap — run the SYSTEM `ssh -tt`, so they trust a known_hosts
// file, NOT `HostRecord.hostKeyFingerprint` (and `-o UserKnownHostsFile=`
// REPLACES the default list, so a FineVibe lane never consults the user's
// `~/.ssh/known_hosts` once a host is seeded). With no FineVibe-owned file a host
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
import { getHostSecret } from './secrets';

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
  fs.writeFileSync(file, `${line}\n`, { mode: 0o600 });
  // `writeFileSync`'s `mode` applies only on CREATE, so a re-seed over a file
  // that lost its 0600 (a sync tool, a stray `chmod`, an fsck) would leave a
  // group-writable trust store — the one file whose contents decide which MITM
  // key the app terminal accepts. Force it on every write. (Windows: chmod is
  // near a no-op there; the ACL story is the documented sibling gap.)
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * The `-o UserKnownHostsFile=` value, quoted only when it needs it. OpenSSH
 * tokenizes an `-o` value on unquoted whitespace, so a userData path with a
 * space (`C:\Users\Jane Doe\AppData\Roaming\finevibe`, the ordinary Windows
 * case) would be read as TWO files and the seeded one would never be found →
 * hard refuse on every app lane. Inside quotes OpenSSH treats `\` as an escape,
 * so a Windows path gets its separators doubled before quoting; unquoted values
 * pass through with backslashes literal.
 */
export function sshConfigPathValue(file: string): string {
  return /\s/.test(file) ? `"${file.replace(/\\/g, '\\\\')}"` : file;
}

/**
 * The `-o` options a seeded registry host contributes to the app's `ssh` argv:
 * point at FineVibe's store, refuse unknown keys, and (key-auth hosts with no
 * stored passphrase) refuse password prompts entirely so a failed key auth exits
 * with `Permission denied (publickey)` instead of parking the pane on three
 * prompts. Password-auth hosts are left alone — typing the password IS the flow.
 * A key-auth record whose key HAS a stored passphrase is left alone too: the
 * passphrase lives in the OS keychain for the ssh2 lanes and cannot be handed to
 * the system `ssh`, so the pane prompt is the only way such a key unlocks.
 * Empty when the host was never seeded, so the caller falls back to the user's
 * store (pre-row-35 behavior).
 */
export function hostTrustSshArgs(record: HostRecord): string[] {
  const file = hostTrustStorePath(app.getPath('userData'), record.id);
  if (!fs.existsSync(file)) return [];
  const args = ['-o', `UserKnownHostsFile=${sshConfigPathValue(file)}`, '-o', 'StrictHostKeyChecking=yes'];
  if (record.authKind === 'key' && getHostSecret(`keypass:${record.id}`) === null) {
    args.push('-o', 'NumberOfPasswordPrompts=0');
  }
  return args;
}
