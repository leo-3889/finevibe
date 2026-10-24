import { vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

// P2-59: the canonical caches are proven by counting `realpathSync` - the
// sync syscall the fs:/git: gates used to pay on every call, per root.
const realpathSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({ realpathSync }));

// %VAR% expansion is gated on the module-level `isWin` const in platform.ts,
// which a test cannot flip; the mock re-exports it as a getter over a
// mutable stub so both platform branches run on any host.
const platformStub = vi.hoisted(() => ({ isWin: false }));
vi.mock('./platform', () => ({ get isWin() { return platformStub.isWin; } }));

import {
  expandUserPath, resolveUserPath, isBinaryBuffer, isMacPackagePath,
  canonicalPath, canonicalRoot,
  invalidateCanonicalPathCache, invalidateCanonicalPathIfRootsChanged,
  TARGET_CANONICAL_CACHE_MAX, TARGET_CANONICAL_TTL_MS, ROOT_CANONICAL_CACHE_MAX,
} from './fs-utils';

/** Install a fake filesystem: keys are the existing paths (resolved), values
 * what realpathSync answers (identity for plain dirs, a target for links). */
function existingFs(entries: Record<string, string>): void {
  realpathSync.mockImplementation((p: unknown) => {
    const key = path.resolve(String(p));
    const mapped = entries[key];
    if (mapped === undefined) {
      const err = new Error(`ENOENT: no such file or directory, realpath '${key}'`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return mapped;
  });
  realpathSync.mockClear();
}

beforeEach(() => {
  invalidateCanonicalPathCache();
  // Pin the roots-signature baseline so each test's
  // invalidateCanonicalPathIfRootsChanged calls report deltas, not the
  // first-ever observation.
  invalidateCanonicalPathIfRootsChanged({ projects: [], profiles: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

const home = '/mock/home';

describe('expandUserPath', () => {
  it('expands ~ alone to homedir', () => {
    expect(expandUserPath('~')).toBe(path.join(home));
  });

  it('expands ~/subdir to homedir/subdir', () => {
    expect(expandUserPath('~/git/my-project')).toBe(path.join(home, 'git/my-project'));
  });

  it('expands ~/ (trailing slash only) to homedir with trailing slash', () => {
    expect(expandUserPath('~/')).toBe(path.join(home, '/'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandUserPath('/absolute/path/to/project')).toBe('/absolute/path/to/project');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandUserPath('relative/path')).toBe('relative/path');
  });

  it('does not expand ~username paths', () => {
    expect(expandUserPath('~otheruser/projects')).toBe('~otheruser/projects');
  });

  it('does not expand empty string', () => {
    expect(expandUserPath('')).toBe('');
  });
});

describe('expandUserPath Windows %VAR% expansion', () => {
  const ENV = 'FINEVIBE_TEST_ENV';
  beforeEach(() => { delete process.env[ENV]; });
  afterEach(() => {
    delete process.env[ENV];
    platformStub.isWin = false;
  });

  it('leaves %VAR% literal on POSIX (POSIX shells expand before main sees the path)', () => {
    platformStub.isWin = false;
    process.env[ENV] = 'expanded';
    expect(expandUserPath(`%${ENV}%\\projects`)).toBe(`%${ENV}%\\projects`);
  });

  it('expands %VAR% on Windows', () => {
    platformStub.isWin = true;
    process.env[ENV] = 'C:\\Users\\me\\AppData';
    expect(expandUserPath(`%${ENV}%\\Roaming`)).toBe('C:\\Users\\me\\AppData\\Roaming');
  });

  it('leaves an unset %VAR% literal on Windows', () => {
    platformStub.isWin = true;
    expect(expandUserPath(`%${ENV}%\\Roaming`)).toBe(`%${ENV}%\\Roaming`);
  });

  it('expands %VAR% inside a ~ path on Windows', () => {
    platformStub.isWin = true;
    process.env[ENV] = 'data';
    expect(expandUserPath(`~/sub/%${ENV}%`)).toBe(path.join(home, 'sub', 'data'));
  });
});

// `~\` is the spelling cmd/PowerShell accept and users type into preferences;
// these paths never pass through a shell that would expand them.
describe('expandUserPath Windows ~\\ expansion', () => {
  afterEach(() => { platformStub.isWin = false; });

  it('expands ~\\sub to homedir/sub on Windows', () => {
    platformStub.isWin = true;
    expect(expandUserPath('~\\git\\my-project')).toBe(path.join(home, 'git', 'my-project'));
  });

  it('expands the mixed ~\\git/my-project on Windows', () => {
    platformStub.isWin = true;
    expect(expandUserPath('~\\git/my-project')).toBe(path.join(home, 'git', 'my-project'));
  });

  it('keeps ~\\ literal on POSIX — a backslash is legal filename data there', () => {
    platformStub.isWin = false;
    expect(expandUserPath('~\\git\\my-project')).toBe('~\\git\\my-project');
  });

  it('keeps expanding ~/ on POSIX (unchanged behaviour)', () => {
    platformStub.isWin = false;
    expect(expandUserPath('~/git/my-project')).toBe(path.join(home, 'git/my-project'));
  });

  it('does not expand ~otheruser on Windows (a ~user path, not a home ref)', () => {
    platformStub.isWin = true;
    expect(expandUserPath('~otheruser\\projects')).toBe('~otheruser\\projects');
  });
});

describe('isBinaryBuffer', () => {
  it('returns false for empty buffer', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for plain ASCII text', () => {
    expect(isBinaryBuffer(Buffer.from('hello world\nline two'))).toBe(false);
  });

  it('returns false for UTF-8 with multi-byte codepoints', () => {
    expect(isBinaryBuffer(Buffer.from('héllo 你好 🚀', 'utf-8'))).toBe(false);
  });

  it('returns true when a null byte is present in the first chunk', () => {
    const buf = Buffer.concat([Buffer.from('header'), Buffer.from([0x00]), Buffer.from('rest')]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('only sniffs the first 8000 bytes', () => {
    const head = Buffer.alloc(8000, 0x41);
    const tail = Buffer.from([0x00]);
    expect(isBinaryBuffer(Buffer.concat([head, tail]))).toBe(false);
  });

  it('flags a buffer that starts with a null byte', () => {
    expect(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
  });
});

describe('isMacPackagePath', () => {
  it('flags directories macOS launches instead of browsing', () => {
    expect(isMacPackagePath('out/FineVibe.app')).toBe(true);
    expect(isMacPackagePath('ios/Runner.xcodeproj')).toBe(true);
    // HFS+/APFS are case-insensitive.
    expect(isMacPackagePath('Some.APP')).toBe(true);
  });

  it('leaves ordinary folders and files alone', () => {
    expect(isMacPackagePath('src')).toBe(false);
    expect(isMacPackagePath('dist.old')).toBe(false);
    expect(isMacPackagePath('index.ts')).toBe(false);
  });
});

describe('canonicalPath caches (P2-59)', () => {
  const base = path.resolve('/mock/base');

  it('resolves an existing path with one realpathSync and serves repeats from the cache', () => {
    existingFs({ [base]: base });
    expect(canonicalPath(base)).toBe(base);
    expect(canonicalPath(base)).toBe(base);
    expect(canonicalPath(base)).toBe(base);
    // Fails before the fix: one realpathSync per call (3).
    expect(realpathSync.mock.calls).toHaveLength(1);
  });

  it('resolves a link in an existing parent directory', () => {
    const real = path.resolve('/mock/real');
    existingFs({ [base]: real, [real]: real });
    expect(canonicalPath(base)).toBe(real);
  });

  it('falls back to canonicalized parents for a non-existent target', () => {
    existingFs({ [base]: base });
    const target = path.join(base, 'new.txt');
    expect(canonicalPath(target)).toBe(path.join(base, 'new.txt'));
    // One bounded chain: the target (ENOENT) + its first existing ancestor.
    expect(realpathSync.mock.calls).toHaveLength(2);
  });

  it('bounds the parent walk and counts the whole chain as one cache entry', () => {
    existingFs({ [base]: base });
    const target = path.join(base, 'a', 'b', 'c.txt');
    expect(canonicalPath(target)).toBe(target);
    const first = realpathSync.mock.calls.length;
    expect(first).toBe(4); // c.txt, b, a fail; base resolves
    for (let i = 0; i < 9; i++) expect(canonicalPath(target)).toBe(target);
    // Fails before the fix: every call re-walks the chain (40 total).
    expect(realpathSync.mock.calls).toHaveLength(first);
  });

  it('canonicalizes a gated root/target pair once across N gated calls', () => {
    existingFs({ [base]: base });
    const target = path.join(base, 'new.txt');
    // The isWithinKnownProject shape: target canonicalized per call, plus
    // every allowed root canonicalized per call.
    for (let i = 0; i < 10; i++) {
      canonicalPath(target);
      canonicalRoot(base);
    }
    // root (1) + target chain (2), each exactly once; N calls cost <= the
    // distinct-path count. Fails before the fix: 10 * 3 = 30.
    expect(realpathSync.mock.calls).toHaveLength(3);
  });

  it('the cache absorbs the repeat for a slow, vanished root', () => {
    // The vanished mount: realpathSync throws for the root and its ancestor,
    // only the filesystem root resolves.
    const fsRoot = path.resolve(path.sep);
    existingFs({ [fsRoot]: fsRoot });
    const target = path.join(path.resolve('/slow/root'), 'file.txt');
    expect(canonicalPath(target)).toBe(target);
    const first = realpathSync.mock.calls.length;
    expect(canonicalPath(target)).toBe(target);
    expect(canonicalPath(target)).toBe(target);
    expect(realpathSync.mock.calls).toHaveLength(first);
  });

  it('invalidateCanonicalPathCache forces re-resolution of roots and targets', () => {
    existingFs({ [base]: base });
    const target = path.join(base, 'new.txt');
    canonicalRoot(base);
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(1);
    invalidateCanonicalPathCache();
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(2);
    canonicalPath(target);
    invalidateCanonicalPathCache();
    canonicalPath(target);
    // 2 root calls + 2 target chains (2 realpath each).
    expect(realpathSync.mock.calls).toHaveLength(6);
  });

  it('invalidateCanonicalPathIfRootsChanged fires on project add/remove and configDir change', () => {
    existingFs({ [base]: base });
    const p1 = path.resolve('/mock/p1');
    const state = (paths: string[], configDirs: string[] = []) => ({
      projects: paths.map(p => ({ path: p })),
      profiles: configDirs.map(c => ({ configDir: c })),
    });
    invalidateCanonicalPathIfRootsChanged(state([p1]));
    canonicalRoot(base);
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(1);
    // An unchanged project/profile set keeps the cache warm.
    invalidateCanonicalPathIfRootsChanged(state([p1]));
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(1);
    // Project add invalidates.
    invalidateCanonicalPathIfRootsChanged(state([p1, path.resolve('/mock/p2')]));
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(2);
    // Profile configDir change invalidates.
    invalidateCanonicalPathIfRootsChanged(state([p1, path.resolve('/mock/p2')], ['/profiles/work']));
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(3);
    // Project removal invalidates.
    invalidateCanonicalPathIfRootsChanged(state([]));
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(4);
  });

  it('target entries expire after the TTL; root entries do not', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    existingFs({ [base]: base });
    const target = path.join(base, 'new.txt');
    canonicalPath(target);
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(3);
    vi.advanceTimersByTime(TARGET_CANONICAL_TTL_MS + 1);
    canonicalPath(target);
    expect(realpathSync.mock.calls).toHaveLength(5); // target chain re-walked
    canonicalRoot(base);
    expect(realpathSync.mock.calls).toHaveLength(5); // root is not TTL'd
  });

  it('the target cache is bounded and evicts least-recently-used entries', () => {
    existingFs({ [base]: base });
    const targets = Array.from({ length: TARGET_CANONICAL_CACHE_MAX }, (_, i) =>
      path.join(base, `f${i}.txt`));
    for (const t of targets) canonicalPath(t);
    canonicalPath(path.join(base, 'overflow.txt')); // evicts targets[0]
    const afterFill = realpathSync.mock.calls.length;
    canonicalPath(targets[0]);
    expect(realpathSync.mock.calls).toHaveLength(afterFill + 2); // evicted: re-walked
    canonicalPath(targets[targets.length - 1]);
    expect(realpathSync.mock.calls).toHaveLength(afterFill + 2); // recent: cached
  });

  it('the root cache is bounded and evicts least-recently-used roots (B1)', () => {
    const roots = Array.from({ length: ROOT_CANONICAL_CACHE_MAX + 1 }, (_, i) =>
      path.resolve(`/mock/roots/r${i}`));
    existingFs(Object.fromEntries(roots.map((r) => [r, r])));
    for (const r of roots.slice(0, ROOT_CANONICAL_CACHE_MAX)) canonicalRoot(r);
    // Insertion order doubles as recency: touching the oldest root moves it
    // to the tail, so the overflow evicts roots[1] and the touched root
    // survives the cap.
    canonicalRoot(roots[0]!);
    canonicalRoot(roots[ROOT_CANONICAL_CACHE_MAX]!);
    const afterFill = realpathSync.mock.calls.length;
    canonicalRoot(roots[1]!);
    expect(realpathSync.mock.calls.length).toBeGreaterThan(afterFill); // evicted: re-walked
    const afterRewalk = realpathSync.mock.calls.length;
    canonicalRoot(roots[0]!);
    expect(realpathSync.mock.calls).toHaveLength(afterRewalk); // touched: survived the cap
  });

  it('an unresolvable filesystem root falls back to the resolved form', () => {
    existingFs({});
    const target = path.resolve('/x/y');
    expect(canonicalPath(target)).toBe(target);
    expect(canonicalRoot(target)).toBe(target);
  });
});

// The one resolve step every `fs:` channel applies to a renderer path:
// expand, then `path.resolve`. The renderer composes `<folder>/<name>` with
// `/` joins, so Windows receives `E:\AI/Brillance` verbatim — the mixed
// spelling is what used to be persisted as the project path.
describe('resolveUserPath', () => {
  it('expands ~ to the resolved home dir', () => {
    expect(resolveUserPath('~')).toBe(path.resolve(home));
  });

  it('expands ~/x to home/x', () => {
    expect(resolveUserPath('~/git/Brillance')).toBe(path.resolve(home, 'git', 'Brillance'));
  });

  it('resolves a relative path against the cwd', () => {
    expect(resolveUserPath('relative/Brillance')).toBe(path.resolve('relative', 'Brillance'));
  });

  it('normalizes a mixed-separator absolute path to the platform spelling', () => {
    expect(resolveUserPath(`${home}/git/Brillance`)).toBe(path.resolve(home, 'git', 'Brillance'));
  });

  it('collapses a .. segment', () => {
    expect(resolveUserPath(path.join(home, 'git', '..', 'Brillance'))).toBe(path.resolve(home, 'Brillance'));
  });

  it('leaves $NAME unexpanded on POSIX (a literal %NAME% is filename data)', () => {
    platformStub.isWin = false;
    expect(resolveUserPath('%NOT_A_REAL_VAR%/projects')).toBe(path.resolve('%NOT_A_REAL_VAR%', 'projects'));
  });
});

describe('resolveUserPath Windows spellings', () => {
  const ENV = 'FINEVIBE_TEST_ENV';
  afterEach(() => {
    delete process.env[ENV];
    platformStub.isWin = false;
  });

  it('normalizes the renderer\'s E:\\AI/Brillance to E:\\AI\\Brillance', () => {
    platformStub.isWin = true;
    expect(resolveUserPath('E:\\AI/Brillance')).toBe('E:\\AI\\Brillance');
  });

  it('expands the ~\\ spelling users type into preferences', () => {
    platformStub.isWin = true;
    expect(resolveUserPath('~\\git\\Brillance')).toBe(path.resolve(home, 'git', 'Brillance'));
  });

  it('expands %APPDATA% before resolving', () => {
    platformStub.isWin = true;
    process.env[ENV] = 'C:\\Users\\me\\AppData\\Roaming';
    expect(resolveUserPath(`%${ENV}%\\projects\\Brillance`))
      .toBe('C:\\Users\\me\\AppData\\Roaming\\projects\\Brillance');
  });
});
