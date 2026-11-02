// Managed keypairs + authorized_keys marker blocks (multi-host Phase 1).
//
// Pure string functions (table-testable) + a thin injectable remote-exec so
// the deploy/remove logic is testable without ssh2. The marker block is the
// contract with unenroll: exactly `# finevibe:<id> begin` / key line /
// `# finevibe:<id> end` — pre-existing key lines are never duplicated and
// user lines are never touched.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPairSync } from 'crypto';
import { utils as sshUtils } from 'ssh2';
import { canonicalPath } from '../fs-utils';

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
 * Remove exactly the marker block for `hostId`. Returns content unchanged
 * (null) when no block exists.
 *
 * Two row-33 rules the first cut violated:
 * - An UNTERMINATED block (a deploy truncated mid-write leaves the `end`
 *   marker unwritten) consumes only the begin line plus the one key line
 *   `markerBlock` writes. The old loop stayed "in block" to EOF and deleted
 *   every key the user appended afterwards.
 * - The remainder is re-emitted faithfully: split on `\n` only (so a CRLF
 *   file's untouched lines keep their `\r`), and no trailing-whitespace
 *   normalization. The only addition is a final newline when the kept
 *   content lacks one — the deploy lane appends with `>>`, and a tail without
 *   a newline would fuse the next key onto this file's last line.
 */
export function authorizedKeysWithoutBlock(authorizedKeys: string, hostId: string): string | null {
  const begin = `# finevibe:${hostId} begin`;
  const end = `# finevibe:${hostId} end`;
  const lines = authorizedKeys.split('\n');
  const drop = lines.map(() => false);
  let removed = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== begin) continue;
    removed = true;
    drop[i] = true;
    // begin / key line / end, or begin / key line / EOF when the deploy was
    // cut short. A line that is itself the end marker means the block was
    // empty — never consume a foreign key as the block's key line.
    if (i + 1 < lines.length && lines[i + 1].trim() !== end) {
      drop[i + 1] = true;
      i += 1;
    }
    if (i + 1 < lines.length && lines[i + 1].trim() === end) {
      drop[i + 1] = true;
      i += 1;
    }
  }
  if (!removed) return null;
  const kept = lines.filter((_, i) => !drop[i]).join('\n');
  return kept.length > 0 && !kept.endsWith('\n') ? `${kept}\n` : kept;
}

/**
 * Build the remote command that deploys the block (mkdir/chmod idiom).
 * `presentCheck` is a locally-computed literal — never remote output
 * (audit T1 #3: it is embedded inside double quotes).
 */
export function authorizedKeysDeployCommands(
  block: string,
  presentCheck: 'yes' | 'no',
): string {
  // Single-quoted heredoc-free write: append via printf on the remote side.
  // `presentCheck` is the already-evaluated answer ('yes' when the key line
  // exists) — the caller ran the probe; this command only writes when absent.
  const quoted = block.replace(/'/g, `'\\''`);
  return `if [ "${presentCheck}" = "yes" ]; then exit 0; fi; ` +
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `printf '%s\\n' '${quoted}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/** FineVibe's own key tree — the only place a key pair counts as MANAGED. */
function managedKeyRoot(userDataDir: string): string {
  return path.join(userDataDir, 'hosts');
}

/**
 * Containment on canonical forms (the P2-59 gate idiom: `canonicalPath`
 * resolves links + `..`, tolerating a missing tail). Equal-but-differently-
 * spelled paths match, a link cannot escape the root, and the root itself
 * never counts as inside (it is a directory, the target must be a file in it).
 */
function isInsideDir(root: string, target: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Audit row 34 (key exfil): `privateKeyPath` arrives from the renderer, but
 * MAIN reads the file — `ssh-client.connectConfigFor` on every connect, and
 * `readPublicKeyLine` in the enrollment key-deploy step, which sends the
 * public half to the renderer-CHOSEN host. Two roots are legal:
 * `<userData>/hosts/` (the pair `hosts:generateKey` wrote) and `~/.ssh/` (the
 * Add-host Browse button's target). Anything else is an unbounded
 * renderer-steered local file read and is refused at the IPC boundary.
 *
 * Chosen over "ignore `privateKeyPath` for non-managed keys": a browsed key
 * path is a supported feature whose value round-trips through `hosts:update`,
 * so dropping it would make an existing host's key uneditable — and would
 * leave the same read reachable through `hosts:create`.
 */
export function isRendererKeyPathAllowed(userDataDir: string, privateKeyPath: string): boolean {
  return isInsideDir(managedKeyRoot(userDataDir), privateKeyPath)
    || isInsideDir(path.join(os.homedir(), '.ssh'), privateKeyPath);
}

/**
 * Audit row 31: `managedKey` is main's, not the renderer's — a pair is managed
 * exactly when it sits in FineVibe's own key tree. The flag drives the key
 * deploy step and the delete-time unlink of `<dir>/id_ed25519`, so trusting a
 * renderer value could have FineVibe delete a foreign `~/.ssh/id_ed25519`.
 */
export function isManagedKeyPath(userDataDir: string, privateKeyPath: string): boolean {
  return isInsideDir(managedKeyRoot(userDataDir), privateKeyPath);
}

/** Generate an ed25519 keypair under `<userData>/hosts/<id>/`, 0600. Returns paths. */
export function generateManagedKeypair(userDataDir: string, hostId: string): { privateKeyPath: string; publicKeyPath: string } {
  const dir = path.join(managedKeyRoot(userDataDir), hostId);
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
