import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { authorizedKeysWithBlock, authorizedKeysWithoutBlock, isManagedKeyPath, isRendererKeyPathAllowed, markerBlock } from './keys';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPubkeydata finevibe:host-1';
const ID = 'host-1';

// Audit 34/31 gate fixtures: a real temp tree (the gate canonicalizes, so the
// paths must exist for the symlink case to mean anything).
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'fv-keys-'));
const USER_DATA = join(TMP_ROOT, 'user-data');
const MANAGED_ROOT = join(USER_DATA, 'hosts');
mkdirSync(MANAGED_ROOT, { recursive: true });
const MANAGED_KEY = join(MANAGED_ROOT, 'h1', 'id_ed25519');
const HOME_KEY = join(homedir(), '.ssh', 'id_ed25519');

describe('authorizedKeysWithBlock', () => {
  it('appends the marker block to a file with existing keys', () => {
    const base = 'ssh-rsa AAAAexisting user@laptop\n';
    const out = authorizedKeysWithBlock(base, ID, KEY);
    expect(out).toBe(`${base}${markerBlock(ID, KEY)}\n`);
    // The pre-existing key line is untouched.
    expect(out!.startsWith('ssh-rsa AAAAexisting user@laptop\n')).toBe(true);
  });

  it('creates the file content when empty', () => {
    expect(authorizedKeysWithBlock('', ID, KEY)).toBe(`${markerBlock(ID, KEY)}\n`);
  });

  it('is idempotent: the bare key line already present is a no-op', () => {
    const bare = `# my keys\n${KEY}\nssh-rsa AAAAother\n`;
    expect(authorizedKeysWithBlock(bare, ID, KEY)).toBeNull();
  });

  it('is idempotent: an existing marker block for this id is a no-op', () => {
    const withBlock = `${markerBlock(ID, KEY)}\n`;
    expect(authorizedKeysWithBlock(withBlock, ID, KEY)).toBeNull();
  });

  it('normalizes a file without a trailing newline', () => {
    const out = authorizedKeysWithBlock('ssh-rsa AAAAone', ID, KEY);
    expect(out).toBe(`ssh-rsa AAAAone\n${markerBlock(ID, KEY)}\n`);
  });
});

describe('authorizedKeysWithoutBlock', () => {
  it('removes exactly the marker block, leaving foreign lines', () => {
    const foreign = 'ssh-rsa AAAAexisting user@laptop';
    const content = `${foreign}\n${markerBlock(ID, KEY)}\nssh-ed25519 AAAAother finevibe:host-2\n`;
    const out = authorizedKeysWithoutBlock(content, ID);
    expect(out).toBe(`${foreign}\nssh-ed25519 AAAAother finevibe:host-2\n`);
  });

  it('returns null when no block for the id exists', () => {
    expect(authorizedKeysWithoutBlock('ssh-rsa AAAAexisting\n', ID)).toBeNull();
  });

  it('only removes the requested id block (collision check)', () => {
    const block1 = markerBlock('h1', KEY);
    const block2 = markerBlock('h2', KEY);
    const content = `${block1}\n${block2}\n`;
    const out = authorizedKeysWithoutBlock(content, 'h1');
    expect(out).toContain('# finevibe:h2 begin');
    expect(out).not.toContain('# finevibe:h1 begin');
  });

  it('deploy/remove round-trip restores the original content', () => {
    const original = 'ssh-rsa AAAAexisting user@laptop\n';
    const deployed = authorizedKeysWithBlock(original, ID, KEY)!;
    expect(authorizedKeysWithoutBlock(deployed, ID)).toBe(original);
  });

  // Audit row 33: a deploy cut short leaves the begin marker without its end
  // marker. The removal used to stay "in block" to EOF and delete every key
  // the user appended after it — unenroll silently locked them out.
  it('drops only the begin + key line of an UNTERMINATED block, keeping the tail', () => {
    const content = `ssh-rsa AAAAexisting user@laptop\n# finevibe:${ID} begin\n${KEY}\nssh-ed25519 AAAAother user@work\nssh-rsa AAAAthird user@home\n`;
    const out = authorizedKeysWithoutBlock(content, ID);
    expect(out).toBe('ssh-rsa AAAAexisting user@laptop\nssh-ed25519 AAAAother user@work\nssh-rsa AAAAthird user@home\n');
  });

  it('removes an unterminated block at EOF without inventing a tail', () => {
    const content = `ssh-rsa AAAAexisting user@laptop\n# finevibe:${ID} begin\n${KEY}`;
    expect(authorizedKeysWithoutBlock(content, ID)).toBe('ssh-rsa AAAAexisting user@laptop\n');
  });

  it('is newline-tolerant: CRLF lines and a marker without a trailing newline', () => {
    const content = `ssh-rsa AAAAexisting user@laptop\r\n# finevibe:${ID} begin\r\n${KEY}\r\n# finevibe:${ID} end`;
    const out = authorizedKeysWithoutBlock(content, ID)!;
    // The untouched foreign line keeps its CRLF bytes; the rewrite ends in a
    // newline so the deploy lane's `>>` cannot fuse the next key onto it.
    expect(out).toBe('ssh-rsa AAAAexisting user@laptop\r\n');
  });

  it('leaves a foreign key alone when the begin marker is empty-bodied', () => {
    // begin / end adjacent: the line after begin is the end marker, so the
    // only two marker lines go — no real key is ever consumed as block body.
    const content = `# finevibe:${ID} begin\n# finevibe:${ID} end\nssh-rsa AAAAexisting user@laptop\n`;
    expect(authorizedKeysWithoutBlock(content, ID)).toBe('ssh-rsa AAAAexisting user@laptop\n');
  });
});

describe('markerBlock', () => {
  it('uses the documented begin/end grammar', () => {
    expect(markerBlock('abc', KEY)).toBe(`# finevibe:abc begin\n${KEY}\n# finevibe:abc end`);
  });
});

// Audit row 34: the renderer supplies privateKeyPath, main reads the file and
// ships its public half to a renderer-chosen host.
describe('isRendererKeyPathAllowed', () => {
  it('accepts the managed key tree and the user\'s own ~/.ssh', () => {
    expect(isRendererKeyPathAllowed(USER_DATA, MANAGED_KEY)).toBe(true);
    expect(isRendererKeyPathAllowed(USER_DATA, HOME_KEY)).toBe(true);
  });

  it('refuses anything outside both roots, including the root itself and an empty path', () => {
    expect(isRendererKeyPathAllowed(USER_DATA, '/etc/passwd')).toBe(false);
    expect(isRendererKeyPathAllowed(USER_DATA, join(TMP_ROOT, 'elsewhere', 'id_ed25519'))).toBe(false);
    expect(isRendererKeyPathAllowed(USER_DATA, MANAGED_ROOT)).toBe(false);
    expect(isRendererKeyPathAllowed(USER_DATA, '')).toBe(false);
  });

  it('refuses traversal and a symlinked directory inside the managed root', () => {
    expect(isRendererKeyPathAllowed(USER_DATA, join(MANAGED_ROOT, '..', '..', 'escape', 'id_ed25519'))).toBe(false);
    // The link target must exist: the gate canonicalizes to the deepest
    // existing ancestor, so a dangling link is not yet an escape.
    mkdirSync(join(TMP_ROOT, 'elsewhere'), { recursive: true });
    symlinkSync(join(TMP_ROOT, 'elsewhere'), join(MANAGED_ROOT, 'link'), 'dir');
    expect(isRendererKeyPathAllowed(USER_DATA, join(MANAGED_ROOT, 'link', 'id_ed25519'))).toBe(false);
  });
});

// Audit row 31: managedKey is derived from the path, never taken from the patch.
describe('isManagedKeyPath', () => {
  it('is true only inside the FineVibe key tree', () => {
    expect(isManagedKeyPath(USER_DATA, MANAGED_KEY)).toBe(true);
    expect(isManagedKeyPath(USER_DATA, HOME_KEY)).toBe(false);
    expect(isManagedKeyPath(USER_DATA, join(TMP_ROOT, 'id_ed25519'))).toBe(false);
  });
});
