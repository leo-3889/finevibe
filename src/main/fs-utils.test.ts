import { vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

// P2-59: the canonical caches are proven by counting `realpathSync` - the
// sync syscall the fs:/git: gates used to pay on every call, per root.
const realpathSync = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({ realpathSync }));

import {
  expandUserPath, isBinaryBuffer, isMacPackagePath,
  canonicalPath, canonicalRoot,
  invalidateCanonicalPathCache, invalidateCanonicalPathIfRootsChanged,
  TARGET_CANONICAL_CACHE_MAX, TARGET_CANONICAL_TTL_MS,
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

  it('an unresolvable filesystem root falls back to the resolved form', () => {
    existingFs({});
    const target = path.resolve('/x/y');
    expect(canonicalPath(target)).toBe(target);
    expect(canonicalRoot(target)).toBe(target);
  });
});
