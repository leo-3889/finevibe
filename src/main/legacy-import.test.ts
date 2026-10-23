import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { listImportableLegacyProjects } from './legacy-import';

// Same real-temp-dir pattern as userdata-migration.test.ts: the function
// takes `homedir`, so a synthetic home under tmpdir exercises the real
// fs.readFileSync; injected `pathExists` keeps the pure-logic tests free of
// filesystem setup (and lets them use literal Windows-style spellings on
// any platform).

const dirs: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-legacy-import-test-'));
  dirs.push(root);
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A home dir; `content` is written to `.vibeyard/state.json` when non-null. */
function legacyHome(root: string, content: string | null): string {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  if (content !== null) {
    const dir = path.join(home, '.vibeyard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), content);
  }
  return home;
}

function stateWith(projects: unknown[]): string {
  return JSON.stringify({ version: 1, projects });
}

const existsAll = () => true;

describe('listImportableLegacyProjects', () => {
  it('returns [] when the legacy state file does not exist', () => {
    const home = legacyHome(tmpRoot(), null);
    expect(listImportableLegacyProjects({ homedir: home, existingPaths: [] })).toEqual([]);
  });

  it('returns [] when the legacy state file is not parseable', () => {
    const home = legacyHome(tmpRoot(), '{"projects": [oops');
    expect(listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll })).toEqual([]);
  });

  it('returns [] when the state is not an object or projects is not an array', () => {
    const root = tmpRoot();
    for (const content of ['[1,2]', 'null', '"text"', '{"version":1,"projects":"nope"}', '{"version":1}']) {
      const home = legacyHome(root, content);
      expect(listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll })).toEqual([]);
    }
  });

  it('drops entries with a missing, non-string, or blank name or path', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([
      { name: 'Kept', path: 'C:\\repo\\kept', sessions: [] },
      { path: 'C:\\repo\\nameless' },
      { name: 'Pathless' },
      { name: '  ', path: 'C:\\repo\\blank-name' },
      { name: 'Blank path', path: ' ' },
      { name: 42, path: 'C:\\repo\\numeric-name' },
      { name: 'Object path', path: { p: 1 } },
      'not an entry',
      null,
    ]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll });
    expect(out).toEqual([{ name: 'Kept', path: path.normalize('C:\\repo\\kept'), sessions: 0 }]);
  });

  it('drops entries whose path does not exist', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([
      { name: 'Live', path: 'C:\\repo\\live' },
      { name: 'Gone', path: 'C:\\repo\\gone' },
    ]));
    const out = listImportableLegacyProjects({
      homedir: home,
      existingPaths: [],
      pathExists: (p) => p === 'C:\\repo\\live',
    });
    expect(out.map((p) => p.name)).toEqual(['Live']);
  });

  it('never throws when the injected pathExists throws', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([{ name: 'Boom', path: 'C:\\repo\\boom' }]));
    expect(listImportableLegacyProjects({
      homedir: home,
      existingPaths: [],
      pathExists: () => { throw new Error('EPERM'); },
    })).toEqual([]);
  });

  it('filters projects already on the board, case-insensitively on win32 only', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([{ name: 'Alpha clone', path: '/projects/alpha' }]));
    const out = listImportableLegacyProjects({
      homedir: home,
      existingPaths: ['/projects/ALPHA'],
      pathExists: existsAll,
    });
    // win32 filesystems are case-insensitive: the board already has that
    // directory. POSIX keeps it - `alpha` and `ALPHA` are distinct dirs.
    expect(out).toHaveLength(process.platform === 'win32' ? 0 : 1);
  });

  it('matches existing paths through separator and trailing-separator variants', () => {
    const root = tmpRoot();
    const existing = path.join(root, 'proj');
    fs.mkdirSync(existing);
    const variant = process.platform === 'win32'
      ? existing.replace(/\\/g, '/')
      : existing + path.sep;
    const home = legacyHome(root, stateWith([{ name: 'Dupe', path: variant }]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [existing], pathExists: existsAll });
    expect(out).toEqual([]);
  });

  it('dedupes paths inside the legacy list, keeping the first entry', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([
      { name: 'First', path: 'C:\\repo\\dup', sessions: ['a'] },
      { name: 'Second', path: 'C:/repo//dup' },
    ]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll });
    expect(out).toEqual([{ name: 'First', path: path.normalize('C:\\repo\\dup'), sessions: 1 }]);
  });

  it('counts sessions, treating absent or non-array as 0', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([
      { name: 'A', path: 'C:\\r\\a', sessions: ['s1', 's2', 's3'] },
      { name: 'B', path: 'C:\\r\\b' },
      { name: 'C', path: 'C:\\r\\c', sessions: 'abc' },
      { name: 'D', path: 'C:\\r\\d', sessions: { n: 2 } },
    ]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll });
    expect(Object.fromEntries(out.map((p) => [p.name, p.sessions]))).toEqual({ A: 3, B: 0, C: 0, D: 0 });
  });

  it('sorts by name', () => {
    const root = tmpRoot();
    const home = legacyHome(root, stateWith([
      { name: 'charlie', path: 'C:\\r\\c' },
      { name: 'alpha', path: 'C:\\r\\a' },
      { name: 'bravo', path: 'C:\\r\\b' },
    ]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll });
    expect(out.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('caps the result at 500 entries', () => {
    const root = tmpRoot();
    const projects = Array.from({ length: 600 }, (_, i) => ({
      name: `proj-${String(i).padStart(3, '0')}`,
      path: `C:\\bulk\\p${i}`,
    }));
    const home = legacyHome(root, stateWith(projects));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [], pathExists: existsAll });
    expect(out).toHaveLength(500);
    expect(out[0].name).toBe('proj-000');
    expect(out[499].name).toBe('proj-499');
  });

  it('reads a real legacy state.json from the injected home with the default pathExists', () => {
    const root = tmpRoot();
    const live = path.join(root, 'work', 'real-project');
    fs.mkdirSync(live, { recursive: true });
    const home = legacyHome(root, stateWith([
      { id: 'p1', name: 'Real', path: live, sessions: [{ id: 's1' }, { id: 's2' }] },
      { id: 'p2', name: 'Deleted', path: path.join(root, 'work', 'gone-project'), sessions: [] },
    ]));
    const out = listImportableLegacyProjects({ homedir: home, existingPaths: [] });
    expect(out).toEqual([{ name: 'Real', path: live, sessions: 2 }]);
  });
});
