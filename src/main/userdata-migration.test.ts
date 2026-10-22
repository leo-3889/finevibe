import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateLegacyUserData } from './userdata-migration';

const dirs: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-migration-test-'));
  dirs.push(root);
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function layout(root: string) {
  // Simulates an install under the pre-cutover identity:
  //   home/.vibeyard/state.json + nested profile tree
  //   appData/Vibeyard/... userData incl. browser partitions
  const home = path.join(root, 'home');
  const appData = path.join(root, 'appData');
  const legacyHome = path.join(home, '.vibeyard');
  const legacyUserData = path.join(appData, 'Vibeyard');
  write(path.join(legacyHome, 'state.json'), '{"projects":[]}');
  write(path.join(legacyHome, 'profiles', 'work', 'mcp.json'), '{}');
  write(path.join(legacyUserData, 'Local State'), 'chromium');
  write(path.join(legacyUserData, 'Partitions', 'finevibe-browser-iso-s1', 'Cookies'), 'keep');
  write(path.join(legacyUserData, 'Partitions', 'vibeyard-browser-iso-old', 'Cookies'), 'stale');
  write(path.join(legacyUserData, 'indexeddb', 'level'), 'index');
  return { home, appData, legacyHome, legacyUserData, userData: path.join(appData, 'finevibe') };
}

describe('migrateLegacyUserData', () => {
  it('copies the legacy home and userData trees into the finevibe locations', () => {
    const root = tmpRoot();
    const { home, appData, userData } = layout(root);

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(report.home.source).toBe(path.join(home, '.vibeyard'));
    expect(report.appData.source).toBe(path.join(appData, 'Vibeyard'));
    expect(fs.readFileSync(path.join(home, '.finevibe', 'state.json'), 'utf8')).toBe('{"projects":[]}');
    expect(fs.readFileSync(path.join(home, '.finevibe', 'profiles', 'work', 'mcp.json'), 'utf8')).toBe('{}');
    expect(fs.readFileSync(path.join(userData, 'Local State'), 'utf8')).toBe('chromium');
    expect(fs.readFileSync(path.join(userData, 'indexeddb', 'level'), 'utf8')).toBe('index');
    expect(report.home.errors).toEqual([]);
    expect(report.appData.errors).toEqual([]);
  });

  it('purges old-prefix browser partitions instead of copying them', () => {
    const root = tmpRoot();
    const { home, appData, userData } = layout(root);

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(report.appData.purged).toBe(1);
    expect(fs.existsSync(path.join(userData, 'Partitions', 'vibeyard-browser-iso-old'))).toBe(false);
    expect(fs.existsSync(path.join(userData, 'Partitions', 'finevibe-browser-iso-s1', 'Cookies'))).toBe(true);
  });

  it('never overwrites newer destination files; merges only missing ones', () => {
    const root = tmpRoot();
    const { home, appData, userData, legacyHome, legacyUserData } = layout(root);
    write(path.join(home, '.finevibe', 'state.json'), '{"projects":["new"]}');
    write(path.join(userData, 'Local State'), 'newer');
    write(path.join(legacyHome, 'agentmemory.log'), 'daemon');
    void legacyUserData;

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(fs.readFileSync(path.join(home, '.finevibe', 'state.json'), 'utf8')).toBe('{"projects":["new"]}');
    expect(fs.readFileSync(path.join(userData, 'Local State'), 'utf8')).toBe('newer');
    expect(fs.readFileSync(path.join(home, '.finevibe', 'agentmemory.log'), 'utf8')).toBe('daemon');
    expect(report.home.skipped).toBeGreaterThan(0);
  });

  it('is idempotent: the marker short-circuits later launches', () => {
    const root = tmpRoot();
    const { home, appData, userData, legacyHome } = layout(root);

    migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });
    write(path.join(legacyHome, 'late.json'), 'after-marker');

    const second = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(second.home.copied).toBe(0);
    expect(second.appData.copied).toBe(0);
    expect(fs.existsSync(path.join(home, '.finevibe', 'late.json'))).toBe(false);
  });

  it('is a no-op when no legacy tree exists', () => {
    const root = tmpRoot();
    const home = path.join(root, 'home');
    const appData = path.join(root, 'appData');
    const userData = path.join(appData, 'finevibe');

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(report.home.source).toBeNull();
    expect(report.appData.source).toBeNull();
    expect(fs.existsSync(path.join(home, '.finevibe'))).toBe(false);
  });

  it('records per-file failures and keeps walking (locked-file degradation)', () => {
    const root = tmpRoot();
    const { home, appData, userData } = layout(root);
    // Destination has a FILE where the source has a DIRECTORY: mkdirSync of
    // the nested destination parent fails (ENOTDIR/EEXIST on every platform)
    // -> recorded per-file, walk continues.
    write(path.join(home, '.finevibe', 'profiles'), 'squatter');

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(report.home.errors.length).toBe(1);
    expect(report.home.errors[0]).toContain(path.join('profiles', 'work', 'mcp.json'));
    // The rest of the tree still migrated.
    expect(fs.existsSync(path.join(home, '.finevibe', 'state.json'))).toBe(true);
    // Marker is NOT written when files failed, so a later launch retries them.
    expect(fs.existsSync(path.join(home, '.finevibe', '.finevibe-migrated'))).toBe(false);
  });

  // 'Vibeyard' and 'vibeyard' are one directory only on Windows; on a
  // case-sensitive FS the dev tree is a third tree the migration never sees.
  it.runIf(process.platform === 'win32')('migrates from the dev lowercase userData tree when present', () => {
    // Windows filesystems are case-insensitive: 'Vibeyard' and 'vibeyard'
    // are the same dir there, so assert the migration ran from the dev-named
    // tree, not which candidate path won the lookup.
    const root = tmpRoot();
    const { home, appData, userData } = layout(root);
    const dev = path.join(appData, 'vibeyard');
    write(path.join(dev, 'probe-cache.json'), 'dev');

    const report = migrateLegacyUserData({ homedir: home, appDataDir: appData, userDataDir: userData });

    expect(['Vibeyard', 'vibeyard']).toContain(path.basename(String(report.appData.source)));
    expect(fs.readFileSync(path.join(userData, 'probe-cache.json'), 'utf8')).toBe('dev');
  });
});
