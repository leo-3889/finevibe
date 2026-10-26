// Managed keypairs + authorized_keys marker blocks (multi-host Phase 1).
//
// Pure string functions (table-testable) + a thin injectable remote-exec so
// the deploy/remove logic is testable without ssh2. The marker block is the
// contract with unenroll: exactly `# finevibe:<id> begin` / key line /
// `# finevibe:<id> end` — pre-existing key lines are never duplicated and
// user lines are never touched.

import * as fs from 'fs';
import * as path from 'path';
import { generateKeyPairSync } from 'crypto';
import { utils as sshUtils } from 'ssh2';
import type { HostRecord } from '../../shared/types';

/** `ssh-keygen`-style public key line: `<type> <base64> [comment]`. */
export interface PublicKeyLine {
  type: string;
  base64: string;
  comment: string;
}

export function publicKeyLine(publicKeyPem: string, comment: string): PublicKeyLine | null {
  // OpenSSH public keys are the wire format; PEM "BEGIN PUBLIC KEY" is
  // ssh2's export for ed25519/spki. Convert via ssh2 for openssh format.
  const line = sshUtils.parseKey(publicKeyPem, 'ssh');
  if (!line) return null;
  const single = Array.isArray(line) ? line[0] : line;
  if (!single) return null;
  return {
    type: single.type ?? 'ssh-ed25519',
    base64: single.body ?? '',
    comment,
  };
}

/** Render one managed key's marker block for authorized_keys. */
export function markerBlock(hostId: string, pubKeyLine: string): string {
  return `# finevibe:${hostId} begin\n${pubKeyLine}\n# finevibe:${hostId} end`;
}

/**
 * Insert `block` into `authorizedKeys` idempotently: if the key line already
 * exists anywhere (marker block or bare), return the content unchanged.
 * Pure — table-tested for idempotency/collisions.
 */
export function authorizedKeysWithBlock(authorizedKeys: string, hostId: string, pubKeyLine: string): string | null {
  const block = markerBlock(hostId, pubKeyLine);
  const existing = authorizedKeys.split(/\r?\n/);
  // Already present as a bare line or inside any marker block → no-op.
  if (existing.some((line) => line.trim() === pubKeyLine.trim())) return null;
  const trimmed = authorizedKeys.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n${block}\n` : `${block}\n`;
}

/**
 * Remove exactly the marker block for `hostId` (begin line through end line).
 * Returns content unchanged (null) when no block exists.
 */
export function authorizedKeysWithoutBlock(authorizedKeys: string, hostId: string): string | null {
  const begin = `# finevibe:${hostId} begin`;
  const end = `# finevibe:${hostId} end`;
  const lines = authorizedKeys.split(/\r?\n/);
  const out: string[] = [];
  let removed = false;
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === begin) {
      inBlock = true;
      removed = true;
      continue;
    }
    if (inBlock) {
      if (line.trim() === end) inBlock = false;
      continue;
    }
    out.push(line);
  }
  if (!removed) return null;
  return out.join('\n').replace(/\s+$/, '') + '\n';
}

/** Build the remote command that deploys the block (mkdir/chmod idiom). */
export function authorizedKeysDeployCommands(
  block: string,
  presentCheck: string,
): string {
  // Single-quoted heredoc-free write: append via printf on the remote side.
  // `presentCheck` is the already-evaluated answer ('yes' when the key line
  // exists) — the caller ran the probe; this command only writes when absent.
  const quoted = block.replace(/'/g, `'\\''`);
  return `if [ "${presentCheck}" = "yes" ]; then exit 0; fi; ` +
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `printf '%s\\n' '${quoted}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/** Generate an ed25519 keypair under `<userData>/hosts/<id>/`, 0600. Returns paths. */
export function generateManagedKeypair(userDataDir: string, hostId: string): { privateKeyPath: string; publicKeyPath: string } {
  const dir = path.join(userDataDir, 'hosts', hostId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const privateKeyPath = path.join(dir, 'id_ed25519');
  const publicKeyPath = path.join(dir, 'id_ed25519.pub');
  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  const parsed = sshUtils.parseKey(publicKey, 'ssh');
  const line = Array.isArray(parsed) ? parsed[0] : parsed;
  const pubLine = line ? `${line.type} ${line.body} finevibe:${hostId}` : '';
  fs.writeFileSync(publicKeyPath, pubLine ? `${pubLine}\n` : '', { mode: 0o600 });
  return { privateKeyPath, publicKeyPath };
}

/** Read a managed/user public key line from disk ('' when unreadable). */
export function readPublicKeyLine(privateKeyPath: string): string {
  try {
    const priv = fs.readFileSync(privateKeyPath, 'utf8');
    const parsed = sshUtils.parseKey(priv);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key) return '';
    const pub = typeof key.getPublicSSH === 'function' ? key.getPublicSSH() : null;
    if (!pub) return '';
    return `${key.type} ${Buffer.from(pub).toString('base64')} finevibe`;
  } catch {
    // Fallback: the sibling .pub file (managed keys always write one).
    try {
      return fs.readFileSync(`${privateKeyPath}.pub`, 'utf8').trim();
    } catch {
      return '';
    }
  }
}

/** True when the record's key is finevibe-owned (delete on unenroll). */
export function isManagedKey(record: HostRecord): boolean {
  return record.managedKey;
}
