import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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
  readLaunchSessionMeta,
  readLaunchSessionMetaCached,
  pruneLaunchSessionDirs,
  protectLaunchSessionDir,
  listLaunchSessionDirs,
  LAUNCH_SESSION_RETENTION_MS,
  _setPruneScanLimitForTesting,
} from './launch-session-dir';

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD = Date.now() - 45 * DAY_MS;
const RECENT = Date.now() - 2 * DAY_MS;
// P1-16: a session resumed after 31 days idle — past the 30-day window, so
// every timestamp in its dir reads as expired.
const RESUMED = Date.now() - 31 * DAY_MS;

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

/**
 * P2-74: a dir link inside the swept base, on every platform. Windows real
 * symlinks need Developer Mode/admin, so the guard runs there with a
 * junction — the reparse point Windows users actually create, and the one
 * libuv reports as a symlink (lstat → isSymbolicLink), i.e. the guard
 * branch sees the same shape on win32 that CI exercises on linux.
 */
function linkDir(link: string, target: string): void {
  fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');
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

  it('S1-10: ids that collapse to the same sanitized spelling keep distinct dirs', () => {
    const a = launchSessionDir('pi', 'a:b');
    const b = launchSessionDir('pi', 'a/b');
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(path.dirname(dir)).toBe(launchSessionBaseDir('pi'));
      expect(path.basename(dir).startsWith('a_b-')).toBe(true);
    }
    // Deterministic: the same raw id always maps to the same dir.
    expect(launchSessionDir('pi', 'a:b')).toBe(a);
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

  it('prunes a pre-sidecar dir (no .finevibe.json) from its dir mtime alone', () => {
    const legacy = makeDir('legacy', { transcripts: [OLD], dirMtime: OLD });
    expect(fs.existsSync(path.join(legacy, '.finevibe.json'))).toBe(false);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('keeps an empty dir whose age it cannot establish', () => {
    // Corrupt sidecar, no transcripts: the dir mtime is the only signal.
    const corrupt = fs.mkdtempSync(path.join(base, 'corrupt-'));
    fs.writeFileSync(path.join(corrupt, '.finevibe.json'), '{corrupt');
    fs.utimesSync(corrupt, new Date(OLD), new Date(OLD));
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(corrupt)).toBe(false);

    const fresh = fs.mkdtempSync(path.join(base, 'fresh-'));
    fs.writeFileSync(path.join(fresh, '.finevibe.json'), 'not json');
    fs.utimesSync(fresh, new Date(RECENT), new Date(RECENT));
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('P1-16: skips a protected dir past the window — the resume target', () => {
    // Fail-before: the sweep had no exclusion for the dir a resume points
    // at, so a session restored after 31 d idle (every timestamp past the
    // 30-day window; its transcript lives ONLY in this dir) was deleted by
    // the sweep its own launch scheduled. protectLaunchSessionDir() now
    // registers it at launch/resume and the sweep skips it — while
    // unprotected expired dirs are still collected.
    const resumed = makeDir('resumed', { createdAt: RESUMED, transcripts: [RESUMED], dirMtime: RESUMED });
    const control = makeDir('dead', { createdAt: RESUMED, dirMtime: RESUMED });
    protectLaunchSessionDir(resumed);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(1);
    expect(fs.existsSync(resumed)).toBe(true);
    expect(fs.existsSync(path.join(resumed, 'resumed.jsonl'))).toBe(true);
    expect(fs.existsSync(control)).toBe(false);
  });

  it('skips a symlinked dir instead of following and deleting through it', () => {
    const target = path.join(userData.path, 'symlink-target');
    fs.mkdirSync(target, { recursive: true });
    const inside = path.join(target, 'precious.jsonl');
    fs.writeFileSync(inside, 'user data');
    fs.utimesSync(target, new Date(OLD), new Date(OLD));
    fs.utimesSync(inside, new Date(OLD), new Date(OLD));

    linkDir(path.join(base, 'linked'), target);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(0);
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(path.join(base, 'linked'))).toBe(true);
  });
});

describe('pruneLaunchSessionDirs() scan bound (P2-57)', () => {
  afterEach(() => _setPruneScanLimitForTesting(null));

  it('examines the oldest dirs first, reaching expired dirs hidden past the raw readdir slice', () => {
    // 13 dirs, limit 6. The young dirs occupy the whole raw readdir prefix
    // (names a*), pushing every expired dir (z*) past the slice boundary:
    // an unsorted slice(0, limit) would never examine — never delete — them,
    // and every launch adds another dir.
    _setPruneScanLimitForTesting(6);
    const young = [0, 1, 2, 3, 4, 5, 6].map(i =>
      makeDir(`a${i}`, { createdAt: RECENT, transcripts: [RECENT] }),
    );
    const expired = [0, 1, 2, 3, 4].map(i =>
      makeDir(`z${i}`, { createdAt: OLD - i * DAY_MS, dirMtime: OLD - i * DAY_MS }),
    );
    expect(fs.readdirSync(base).length).toBeGreaterThan(6);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(5);
    for (const d of expired) expect(fs.existsSync(d)).toBe(false);
    for (const d of young) expect(fs.existsSync(d)).toBe(true);
  });

  it('examines exactly the oldest `limit` dirs and finishes the job on the next pass', () => {
    // 5 expired dirs (z0 oldest … z4 newest) + 1 young, limit 3: one pass is
    // bounded, so it deletes the 3 OLDEST expired dirs; the survivors' mtimes
    // still lead every future scan.
    _setPruneScanLimitForTesting(3);
    const dirs = [0, 1, 2, 3, 4].map(i => makeDir(`z${i}`, { dirMtime: OLD - (4 - i) * DAY_MS }));
    const young = makeDir('a-young', { createdAt: RECENT, transcripts: [RECENT] });
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(3);
    expect(dirs.filter(d => fs.existsSync(d)).map(d => path.basename(d))).toEqual(['z3', 'z4']);
    expect(fs.existsSync(young)).toBe(true);
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(2);
    expect(fs.readdirSync(base)).toEqual(['a-young']);
  });

  it('sorts with lstat only: the oldest entry may be a symlink and is never followed', () => {
    // The symlink is the oldest entry and sorts first in raw readdir order;
    // the sort must lstat (not stat) it, park it behind the real dirs, and
    // the bounded scan must delete the two expired dirs without touching it.
    _setPruneScanLimitForTesting(2);
    const target = path.join(userData.path, 'p2-57-target');
    fs.mkdirSync(target, { recursive: true });
    const inside = path.join(target, 'precious.jsonl');
    fs.writeFileSync(inside, 'user data');
    fs.utimesSync(target, new Date(OLD - 10 * DAY_MS), new Date(OLD - 10 * DAY_MS));
    linkDir(path.join(base, 'a-linked'), target);
    const dead1 = makeDir('b-dead-1', { dirMtime: OLD });
    const dead2 = makeDir('b-dead-2', { dirMtime: OLD - DAY_MS });
    const live = makeDir('c-live', { createdAt: RECENT, transcripts: [RECENT] });
    expect(pruneLaunchSessionDirs(base, Date.now())).toBe(2);
    expect(fs.existsSync(dead1)).toBe(false);
    expect(fs.existsSync(dead2)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(inside)).toBe(true);
    expect(fs.existsSync(path.join(base, 'a-linked'))).toBe(true);
  });
});

describe('listLaunchSessionDirs()', () => {
  const dirsOf = (entries: Array<{ dir: string; mtimeMs: number }>) => entries.map(e => e.dir);

  it('lists dirs with recent activity', async () => {
    const live = makeDir('live', { createdAt: RECENT, transcripts: [RECENT] });
    const entries = await listLaunchSessionDirs(base);
    expect(dirsOf(entries)).toEqual([live]);
    // PA-19: the lstat mtime the retention gate paid for rides along — it is
    // the meta cache key, so the sidecar read needs no second stat.
    expect(entries[0].mtimeMs).toBeCloseTo(fs.lstatSync(live).mtimeMs, 0);
  });

  it('drops dirs whose activity is entirely outside the retention window', async () => {
    makeDir('dead', { createdAt: OLD, transcripts: [OLD], dirMtime: OLD });
    const live = makeDir('live', { createdAt: OLD, transcripts: [RECENT], dirMtime: OLD });
    // The dir mtime is old (coarse filesystem, restored backup): the newest
    // transcript mtime keeps the dir visible to search.
    expect(dirsOf(await listLaunchSessionDirs(base))).toEqual([live]);
  });

  it('returns nothing for a base that does not exist', async () => {
    expect(await listLaunchSessionDirs(path.join(base, 'missing'))).toEqual([]);
  });

  it('skips files and symlinks in the base dir', async () => {
    const live = makeDir('live', { createdAt: RECENT, transcripts: [RECENT] });
    fs.writeFileSync(path.join(base, 'stray.jsonl'), 'x');
    expect(dirsOf(await listLaunchSessionDirs(base))).toEqual([live]);
  });
});

describe('readLaunchSessionMetaCached()', () => {
  it('reads the sidecar once per dir mtime (PA-19)', async () => {
    const dir = makeDir('live', { createdAt: RECENT, transcripts: [RECENT] });
    const dirMtime = fs.lstatSync(dir).mtimeMs;
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    try {
      const sidecarOnly = (call: unknown[]) => String(call[0]).endsWith('.finevibe.json');
      const first = await readLaunchSessionMetaCached(dir, dirMtime);
      expect(first?.cwd).toBe('/proj');
      expect(readSpy.mock.calls.filter(sidecarOnly)).toHaveLength(1);

      // Same dir mtime: served from the cache, no second read.
      const second = await readLaunchSessionMetaCached(dir, dirMtime);
      expect(second).toEqual(first);
      expect(readSpy.mock.calls.filter(sidecarOnly)).toHaveLength(1);

      // A write into the dir bumps its mtime (the sidecar is written once at
      // launch; any later touch is conservative invalidation): re-read.
      writeLaunchSessionMeta(dir, { providerId: 'pi', cwd: '/other', createdAt: new Date(RECENT).toISOString() });
      // Force a strictly-newer dir mtime: on a fast filesystem the write can
      // land inside the same timestamp granularity, making the cache key
      // identical and the invalidation assertion a coin flip.
      const bump = new Date(dirMtime + 5000);
      fs.utimesSync(dir, bump, bump);
      const moved = fs.lstatSync(dir).mtimeMs;
      expect(moved).toBeGreaterThan(dirMtime);
      const third = await readLaunchSessionMetaCached(dir, moved);
      expect(third?.cwd).toBe('/other');
      expect(readSpy.mock.calls.filter(sidecarOnly)).toHaveLength(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('mirrors readLaunchSessionMeta on a missing sidecar', async () => {
    const legacy = makeDir('legacy', { transcripts: [RECENT] });
    expect(await readLaunchSessionMetaCached(legacy, fs.lstatSync(legacy).mtimeMs)).toBeNull();
    expect(readLaunchSessionMeta(legacy)).toBeNull();
  });
});

describe('ensureLaunchSessionDir() retention hook', () => {
  it('S2-04/scout-2: prunes on the next macrotask, never on the spawn path', async () => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    const dead = makeDir('dead', { createdAt: OLD, dirMtime: OLD });
    const sessionDir = path.join(base, 'new-tab');
    ensureLaunchSessionDir(sessionDir);
    // The spawn path must return synchronously WITHOUT the sweep: the dir
    // is created, the expired dir is still there.
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(dead)).toBe(true);
    // The deferred sweep removes it on the next macrotask.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(true);
  });

  it('runs the sweep at most once per base per process', async () => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    ensureLaunchSessionDir(path.join(base, 'tab-1'));
    await new Promise((resolve) => setImmediate(resolve)); // sweep consumed
    // Created after the sweep (e.g. by an external writer): the guard means a
    // second launch must not pay for the scan again.
    const dead = makeDir('late-dead', { createdAt: OLD, dirMtime: OLD });
    ensureLaunchSessionDir(path.join(base, 'tab-2'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(dead)).toBe(true);
    expect(fs.existsSync(path.join(base, 'tab-2'))).toBe(true);
  });

  it('P1-16: a resumed launch protects its pre-existing expired dir from the sweep it schedules', async () => {
    // Fail-before: the resume calls ensureLaunchSessionDir() with the
    // session's pre-existing dir; every timestamp in it is past the window,
    // and the deferred sweep this call schedules deleted it (the transcript
    // jsonl is the session's only copy) before the provider's sidecar
    // rewrite could land. The target is now protected synchronously,
    // before the sweep is scheduled, so it survives.
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    const resumeDir = makeDir('resumed-tab', { createdAt: RESUMED, transcripts: [RESUMED], dirMtime: RESUMED });
    const transcript = path.join(resumeDir, 'resumed-tab.jsonl');
    ensureLaunchSessionDir(resumeDir);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(transcript)).toBe(true);
    expect(fs.existsSync(resumeDir)).toBe(true);
  });

  it('P1-16: a restore burst protects a resumed tab from the sweep the first launch scheduled', async () => {
    // App restore: tab A (fresh) launches first and arms the one-shot sweep
    // of the base; tab B resumes after 31 d idle, before the sweep runs.
    // Fail-before: the sweep deleted B's expired dir with its transcript.
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(base, { recursive: true });
    ensureLaunchSessionDir(path.join(base, 'tab-a-new'));
    const bDir = makeDir('tab-b-resume', { createdAt: RESUMED, transcripts: [RESUMED], dirMtime: RESUMED });
    ensureLaunchSessionDir(bDir);
    const dead = makeDir('dead', { createdAt: OLD, dirMtime: OLD });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(bDir)).toBe(true);
    expect(fs.existsSync(path.join(bDir, 'tab-b-resume.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'tab-a-new'))).toBe(true);
    expect(fs.existsSync(dead)).toBe(false);
  });

});

describe('LAUNCH_SESSION_RETENTION_MS', () => {
  it('is the documented 30-day window', () => {
    expect(LAUNCH_SESSION_RETENTION_MS).toBe(30 * DAY_MS);
  });
});
