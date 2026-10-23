import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The Linux candidate scan reads `os.homedir()` and the platform flags at
// call time, so the fake home + Linux flags below drive P2-50 coverage on
// any host OS (same getter pattern as prompt-utils.test.ts).
const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => fixture.home,
}));
vi.mock('../platform', () => ({ isMac: false, isWin: false, isLinux: true }));

import { chromeProfileDir, chromeUserDataDir } from './paths';

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

describe('chromeUserDataDir (Linux candidates)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-chrome-home-'));
    dirs.push(home);
    fixture.home = home;
  });

  it('finds ~/.config/chromium on a chromium-only machine', () => {
    fs.mkdirSync(path.join(home, '.config', 'chromium'), { recursive: true });
    expect(chromeUserDataDir()).toBe(path.join(home, '.config', 'chromium'));
  });

  it('prefers stable google-chrome when chromium also exists', () => {
    fs.mkdirSync(path.join(home, '.config', 'chromium'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'google-chrome'), { recursive: true });
    expect(chromeUserDataDir()).toBe(path.join(home, '.config', 'google-chrome'));
  });

  it('finds the flatpak chromium sandbox dir', () => {
    fs.mkdirSync(
      path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'),
      { recursive: true },
    );
    expect(chromeUserDataDir()).toBe(
      path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'),
    );
  });

  it('finds the snap-confined chromium user-data dir', () => {
    fs.mkdirSync(path.join(home, 'snap', 'chromium', 'common', 'chromium'), { recursive: true });
    expect(chromeUserDataDir()).toBe(path.join(home, 'snap', 'chromium', 'common', 'chromium'));
  });

  it('prefers .config/chromium (and Chrome) over the snap dir', () => {
    fs.mkdirSync(path.join(home, 'snap', 'chromium', 'common', 'chromium'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config', 'chromium'), { recursive: true });
    expect(chromeUserDataDir()).toBe(path.join(home, '.config', 'chromium'));
    fs.mkdirSync(path.join(home, '.config', 'google-chrome'), { recursive: true });
    expect(chromeUserDataDir()).toBe(path.join(home, '.config', 'google-chrome'));
  });

  it('returns null when no candidate exists', () => {
    expect(chromeUserDataDir()).toBeNull();
  });
});
