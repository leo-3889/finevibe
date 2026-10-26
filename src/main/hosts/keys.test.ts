import { describe, expect, it } from 'vitest';
import { authorizedKeysWithBlock, authorizedKeysWithoutBlock, markerBlock } from './keys';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPubkeydata finevibe:host-1';
const ID = 'host-1';

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
});

describe('markerBlock', () => {
  it('uses the documented begin/end grammar', () => {
    expect(markerBlock('abc', KEY)).toBe(`# finevibe:abc begin\n${KEY}\n# finevibe:abc end`);
  });
});
