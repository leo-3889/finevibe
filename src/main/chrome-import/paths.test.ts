import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromeProfileDir } from './paths';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempUserData(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-chrome-paths-'));
  dirs.push(root);
  return root;
}

describe('chromeProfileDir containment', () => {
  it("accepts Chrome's own profile ids", () => {
    const userData = tempUserData();
    fs.mkdirSync(path.join(userData, 'Default'));
    expect(chromeProfileDir(userData, 'Default')).toBe(path.join(userData, 'Default'));
  });

  it('allows the user-data dir itself (profileId "." keeps the root identity)', () => {
    const userData = tempUserData();
    expect(chromeProfileDir(userData, '.')).toBe(path.resolve(userData));
  });

  it('throws for a plain traversal id', () => {
    const userData = tempUserData();
    expect(() => chromeProfileDir(userData, '..')).toThrow(/Invalid Chrome profile id/);
    expect(() => chromeProfileDir(userData, '../../Secrets')).toThrow(/Invalid Chrome profile id/);
  });

  it('throws for an id whose link target leaves the user-data dir (P2-3)', () => {
    // The old gate was a string prefix on the resolved path, so a symlinked
    // profile dir INSIDE the user-data dir passed it while its canonical
    // target (any cookie DB on the machine) was the directory the import
    // copied from. Canonical containment closes the link.
    const userData = tempUserData();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-chrome-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'Cookies'), 'foreign-db');
    fs.symlinkSync(outside, path.join(userData, 'Profile 1'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => chromeProfileDir(userData, 'Profile 1')).toThrow(/Invalid Chrome profile id/);
  });

  it('throws for a link in an existing parent that leaves the user-data dir', () => {
    const userData = tempUserData();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-chrome-outside-'));
    dirs.push(outside);
    const link = path.join(userData, 'link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => chromeProfileDir(userData, path.join('link', 'Profile 1'))).toThrow(/Invalid Chrome profile id/);
  });
});
