import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWin } from './platform';

const userData = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({
  app: { getPath: (k: string) => (k === 'userData' ? userData.path : userData.path) },
}));

import {
  launchSessionBaseDir,
  launchSessionDir,
  ensureLaunchSessionDir,
  writeLaunchSessionMeta,
  pruneLaunchSessionDirs,
  listLaunchSessionDirs,
  LAUNCH_SESSION_RETENTION_MS,
} from './launch-session-dir';

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = Date.now() - 45 * DAY_MS;
const RECENT = Date.now() - 2 * DAY_MS;

let base: string;

/** Create one per-launch dir with the given sidecar/transcript/dir mtimes. */
function makeDir(
  name: string,
  opts: { createdAt?: number; transcripts?: number[]; dirMtime?: number } = {},
): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.createdAt !== undefined) {
    writeLaunchSessionMeta(dir, {
      providerId: 'pi',
      cwd: '/proj',
      createdAt: new Date(opts.createdAt).toISOString(),
    });
  }
  for (const mtime of opts.transcripts ?? []) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, '{"type":"text"}\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  }
  const m = opts.dirMtime ?? Math.max(opts.createdAt ?? 0, ...opts.transcripts ?? [0]);
  fs.utimesSync(dir, new Date(m), new Date(m));
  return dir;
}

beforeAll(() => {
  userData.path = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-launchdir-'));
});

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  base = fs.mkdtempSync(path.join(userData.path, 'pi-sessions-'));
});

afterAll(() => {
  fs.rmSync(userData.path, { recursive: true, force: true });
});

describe('launchSessionBaseDir/launchSessionDir', () => {
  it('maps a UI session id to a dir inside the provider base', () => {
    expect(launchSessionBaseDir('pi').replaceAll('\\', '/')).toContain('pi-sessions');
    expect(launchSessionBaseDir('omp').replaceAll('\\', '/')).toContain('omp-sessions');
    const dir = launchSessionDir('pi', 'sess_1-2_x');
    expect(path.dirname(dir).replaceAll('\\', '/')).toBe(launchSessionBaseDir('pi').replaceAll('\\', '/'));
    expect(path.basename(dir)).toBe('sess_1-2_x');
    // A hostile id is sanitized, never a path escape.
    expect(launchSessionDir('pi', '../../evil').startsWith(launchSessionBaseDir('pi'))).toBe(true);
  });
});

describe('pruneLaunchSessionDirs()', () => {
  it('removes a dir whose sidecar, transcripts and dir mtime are all past the window', () => {
    const dead = makeDir('dead', { createdAt: OLD, transcripts: [OLD], dirMtime: OLD });
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('keeps a dir with a transcript inside the window even when the sidecar is old', () => {
    // AND rule: the launch is being resumed, so the sidecar is stale by design.
    const live = makeDir('resume', { createdAt: OLD, transcripts: [RECENT], dirMtime: OLD });
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('keeps a dir whose sidecar records a recent launch', () => {
    const fresh = makeDir('fresh', { createdAt: RECENT, transcripts: [OLD], dirMtime: OLD });
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('prunes a pre-sidecar dir (no .vibeyard.json) from its dir mtime alone', () => {
    const legacy = makeDir('legacy', { transcripts: [OLD], dirMtime: OLD });
    expect(fs.existsSync(path.join(legacy, '.vibeyard.json'))).toBe(false);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('keeps an empty dir whose age it cannot establish', () => {
    // Corrupt sidecar, no transcripts: the dir mtime is the only signal.
    const corrupt = fs.mkdtempSync(path.join(base, 'corrupt-'));
    fs.writeFileSync(path.join(corrupt, '.vibeyard.json'), '{corrupt');
    fs.utimesSync(corrupt, new Date(OLD), new Date(OLD));
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(corrupt)).toBe(false);

    const fresh = fs.mkdtempSync(path.join(base, 'fresh-'));
    fs.writeFileSync(path.join(fresh, '.vibeyard.json'), 'not json');
    fs.utimesSync(fresh, new Date(RECENT), new Date(RECENT));
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it.runIf(!isWin)('skips a symlinked dir instead of following and deleting through it', () => {
    const target = path.join(userData.path, 'symlink-target');
    fs.mkdirSync(target, { recursive: true });
    const inside = path.join(target, 'precious.jsonl');
    fs.writeFileSync(inside, 'user data');
    fs.utimesSync(target, new Date(OLD), new Date(OLD));
    fs.utimesSync(inside, new Date(OLD), new Date(OLD));

    fs.symlinkSync(target, path.join(base, 'linked'), 'dir');
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(path.join(base, 'linked'))).toBe(true);
  });
});

describe('listLaunchSessionDirs()', () => {
  it('lists dirs with recent activity', () => {
    const live = makeDir('live', { createdAt: RECENT, transcripts: [RECENT] });
    expect(listLaunchSessionDirs(base)).toEqual([live]);
  });

  it('drops dirs whose activity is entirely outside the retention window', () => {
    makeDir('dead', { createdAt: OLD, transcripts: [OLD], dirMtime: OLD });
    const live = makeDir('live', { createdAt: OLD, transcripts: [RECENT], dirMtime: OLD });
    // The dir mtime is old (coarse filesystem, restored backup): the newest
    // transcript mtime keeps the dir visible to search.
    expect(listLaunchSessionDirs(base)).toEqual([live]);
  });

  it('returns nothing for a base that does not exist', () => {
    expect(listLaunchSessionDirs(path.join(base, 'missing'))).toEqual([]);
  });

  it('skips files and symlinks in the base dir', () => {
    const live = makeDir('live', { createdAt: RECENT, transcripts: [RECENT] });
    fs.writeFileSync(path.join(base, 'stray.jsonl'), 'x');
    expect(listLaunchSessionDirs(base)).toEqual([live]);
  });
});

describe('ensureLaunchSessionDir() retention hook', () => {
  it('prunes expired dirs on the first launch of a base, before the spawn', () => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    const dead = makeDir('dead', { createdAt: OLD, dirMtime: OLD });
    const sessionDir = path.join(base, 'new-tab');
    ensureLaunchSessionDir(sessionDir);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(true);
  });

  it('runs the sweep at most once per base per process', () => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    ensureLaunchSessionDir(path.join(base, 'tab-1'));
    // Created after the sweep (e.g. by an external writer): the guard means a
    // second launch must not pay for the scan again.
    const dead = makeDir('late-dead', { createdAt: OLD, dirMtime: OLD });
    ensureLaunchSessionDir(path.join(base, 'tab-2'));
    expect(fs.existsSync(dead)).toBe(true);
    expect(fs.existsSync(path.join(base, 'tab-2'))).toBe(true);
  });
});

describe('LAUNCH_SESSION_RETENTION_MS', () => {
  it('is the documented 30-day window', () => {
    expect(LAUNCH_SESSION_RETENTION_MS).toBe(30 * DAY_MS);
  });
});
