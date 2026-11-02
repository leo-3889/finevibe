// Remote open/add folder (per-host providers T5, plan §6, UR-6): the path
// gate, the host gate, and the exec/sftp shapes. ssh-client is a scripted
// fake (the enrollment.test.ts idiom); host-registry answers from a stub.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types';

const sftp = vi.hoisted(() => ({
  entries: vi.fn(),
  stat: vi.fn(),
  read: vi.fn(),
  readRange: vi.fn(),
}));
vi.mock('./ssh-client', () => ({
  sftpListDirEntries: (record: unknown, dir: string, opts?: unknown) => sftp.entries(record, dir, opts),
  sftpStat: (record: unknown, p: string, opts?: unknown) => sftp.stat(record, p, opts),
  sftpRead: (record: unknown, p: string, opts?: unknown) => sftp.read(record, p, opts),
  sftpReadRange: (record: unknown, p: string, pos: number, len: number, opts?: unknown) =>
    sftp.readRange(record, p, pos, len, opts),
  exec: vi.fn(),
}));

// Project containment reads the persisted store (parent plan §11): the file
// lanes only answer inside known project roots of the same host.
const store = vi.hoisted(() => ({ projects: [] as Array<{ path: string; hostId?: string }> }));
vi.mock('../store', () => ({ loadState: () => ({ projects: store.projects }) }));

import { exec } from './ssh-client';
import { getHost } from './host-registry';
import {
  cloneRemoteRepo,
  ensureRemoteDir,
  expandRemotePath,
  invalidateRemoteHome,
  isRemotePathInKnownProject,
  listRemoteDir,
  listRemoteDirs,
  MAX_REMOTE_HOME_CACHE,
  normalizeRemotePath,
  readRemoteFile,
  resolveRemoteHome,
  statRemotePath,
} from './remote-fs';

vi.mock('./host-registry', () => ({ getHost: vi.fn() }));

const enrolled: HostRecord = {
  id: 'h1', name: 'remote1', user: 'dev', host: '192.0.2.242', port: 22,
  authKind: 'key', managedKey: true, enrollmentStatus: 'enrolled',
  prerequisites: { git: { ok: true, path: '/usr/bin/git' } },
};

const dirEntry = (name: string, isDirectory: boolean) => ({ name, isDirectory });

beforeEach(() => {
  vi.mocked(getHost).mockReset().mockImplementation((id) => (id === 'h1' ? enrolled : null));
  sftp.entries.mockReset();
  sftp.stat.mockReset();
  sftp.read.mockReset();
  sftp.readRange.mockReset();
  vi.mocked(exec).mockReset();
  // Row 129: the home probe is a real lane every test now rides — script it to
  // the host's absolute home, everything else answers empty by default.
  vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) =>
    cmd.includes('$HOME') ? '/home/dev\n' : '');
  invalidateRemoteHome('h1');
  store.projects = [{ path: '/home/dev/dev/app', hostId: 'h1' }];
});

describe('remote home resolution (row 129)', () => {
  // The defect: sftp has no tilde expansion, so `~` reached the host as a
  // literal directory name and every Browse answered `No such directory: ~`.
  it('asks the exec lane for $HOME once per host and caches it (lazy resolve)', async () => {
    sftp.entries.mockResolvedValue([]);
    await listRemoteDirs('h1', '~');
    await listRemoteDirs('h1', '~/projects');
    expect(vi.mocked(exec).mock.calls.map((c) => c[1])).toEqual([`printf '%s' "$HOME"`]);
  });

  it('probes a fresh home after a failed probe (a failure is never cached)', async () => {
    vi.mocked(exec).mockResolvedValueOnce('');
    await expect(resolveRemoteHome(enrolled)).resolves.toBeNull();
    await expect(resolveRemoteHome(enrolled)).resolves.toBe('/home/dev');
  });

  // The enrollment warm hook (enrollment.ts step 7) is the same call, so a
  // freshly-enrolled host's first Browse answers with zero extra execs.
  it('serves the first Browse from the enrollment warm-up', async () => {
    await resolveRemoteHome(enrolled); // what enrollHost's dirs step does
    vi.mocked(exec).mockClear();
    sftp.entries.mockResolvedValue([dirEntry('projects', true)]);
    await expect(listRemoteDirs('h1', '~')).resolves.toEqual({
      ok: true, dirs: ['~/projects'], home: '/home/dev',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('never probes for an absolute spelling (the tree rails stay cheap)', async () => {
    sftp.entries.mockResolvedValue([]);
    await listRemoteDirs('h1', '/srv/projects');
    expect(exec).not.toHaveBeenCalled();
  });

  it('refuses a multi-line or relative $HOME instead of anchoring on it', async () => {
    vi.mocked(exec).mockResolvedValueOnce('/home/dev\nextra');
    await expect(resolveRemoteHome(enrolled)).resolves.toBeNull();
    vi.mocked(exec).mockResolvedValueOnce('dev');
    await expect(resolveRemoteHome(enrolled)).resolves.toBeNull();
  });

  it('drops the oldest host past MAX_REMOTE_HOME_CACHE (LRU, capped)', async () => {
    for (let i = 0; i < MAX_REMOTE_HOME_CACHE + 1; i += 1) {
      await resolveRemoteHome({ ...enrolled, id: `host-${i}` });
    }
    vi.mocked(exec).mockClear();
    await resolveRemoteHome({ ...enrolled, id: 'host-0' }); // evicted: re-probed
    await resolveRemoteHome({ ...enrolled, id: `host-${MAX_REMOTE_HOME_CACHE}` }); // still cached
    expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
  });

  it('expands the canonical spellings client-side and passes absolutes through', () => {
    expect(expandRemotePath('~', '/home/dev')).toBe('/home/dev');
    expect(expandRemotePath('~/dev/app', '/home/dev')).toBe('/home/dev/dev/app');
    expect(expandRemotePath('/srv/app', '/home/dev')).toBe('/srv/app');
    expect(expandRemotePath('~', null)).toBeNull();
    expect(expandRemotePath('~/x', null)).toBeNull();
    expect(expandRemotePath('/x', null)).toBe('/x');
  });
});

describe('normalizeRemotePath', () => {
  it('anchors home-relative spellings on ~ and keeps absolutes', () => {
    expect(normalizeRemotePath('~')).toBe('~');
    expect(normalizeRemotePath('~/projects')).toBe('~/projects');
    expect(normalizeRemotePath('~/projects/')).toBe('~/projects');
    expect(normalizeRemotePath('/home/dev/dev')).toBe('/home/dev/dev');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('~/a//b/')).toBe('~/a/b');
  });

  it('converts backslashes (a Windows-typed field) to slashes', () => {
    expect(normalizeRemotePath('~/projects\\demo')).toBe('~/projects/demo');
  });

  it('rejects traversal, relatives, bare ~user, NUL and junk', () => {
    expect(normalizeRemotePath('../etc')).toBeNull();
    expect(normalizeRemotePath('~/../etc')).toBeNull();
    expect(normalizeRemotePath('/a/..')).toBeNull();
    expect(normalizeRemotePath('projects/demo')).toBeNull();
    expect(normalizeRemotePath('~dev/dev')).toBeNull();
    expect(normalizeRemotePath('~/a\0b')).toBeNull();
    expect(normalizeRemotePath('')).toBeNull();
    expect(normalizeRemotePath('   ')).toBeNull();
    expect(normalizeRemotePath(42 as never)).toBeNull();
  });
});

describe('gate', () => {
  it('every verb refuses an unknown host and a non-enrolled one', async () => {
    for (const id of ['ghost', '']) {
      expect(await listRemoteDirs(id, '~')).toMatchObject({ ok: false });
      expect(await statRemotePath(id, '~')).toMatchObject({ ok: false });
      expect(await ensureRemoteDir(id, '~/x')).toMatchObject({ ok: false });
      expect(await cloneRemoteRepo(id, 'https://github.com/o/r', '~/r')).toMatchObject({ ok: false });
    }
    vi.mocked(getHost).mockReturnValue({ ...enrolled, enrollmentStatus: 'draft' });
    expect(await listRemoteDirs('h1', '~')).toMatchObject({ ok: false });
    expect(sftp.entries).not.toHaveBeenCalled();

    vi.mocked(getHost).mockReturnValue({ ...enrolled, enrollmentStatus: 'partial' });
    sftp.entries.mockResolvedValue([]);
    await expect(listRemoteDirs('h1', '~')).resolves.toEqual({ ok: true, dirs: [], home: '/home/dev' });
  });

  it('refuses an unsafe path before any lane runs', async () => {
    await expect(listRemoteDirs('h1', '~/../etc')).resolves.toMatchObject({ ok: false });
    await expect(statRemotePath('h1', '../x')).resolves.toMatchObject({ ok: false });
    await expect(ensureRemoteDir('h1', '~/a/..')).resolves.toMatchObject({ ok: false });
    expect(sftp.entries).not.toHaveBeenCalled();
    expect(sftp.stat).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('listRemoteDirs', () => {
  // Row 129 regression pin: the seed the browser opens on. The sftp lane gets
  // the ABSOLUTE home; the listing stays in the canonical `~` spelling and the
  // payload answers `home` so the modal can label the root `~` and persist an
  // absolute selection.
  it('hands sftp the resolved absolute home, never the literal ~ (row 129)', async () => {
    sftp.entries.mockResolvedValue([dirEntry('projects', true)]);
    const res = await listRemoteDirs('h1', '~');
    expect(sftp.entries).toHaveBeenCalledWith(enrolled, '/home/dev', { timeoutMs: 10000 });
    expect(sftp.entries.mock.calls.every(([, dir]) => dir !== '~' && !dir.startsWith('~/'))).toBe(true);
    expect(res).toEqual({ ok: true, dirs: ['~/projects'], home: '/home/dev' });
  });

  it('refuses a ~-anchored listing when $HOME is unresolvable', async () => {
    vi.mocked(exec).mockResolvedValue('');
    await expect(listRemoteDirs('h1', '~/projects')).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('home directory'),
    });
    expect(sftp.entries).not.toHaveBeenCalled();
    // Absolute spellings never needed the home: they keep working.
    sftp.entries.mockResolvedValue([dirEntry('app', true)]);
    await expect(listRemoteDirs('h1', '/srv')).resolves.toMatchObject({ ok: true, dirs: ['/srv/app'] });
  });

  it('lists dirs only, hides dot-names, sorts, prefix-filters, joins', async () => {
    sftp.entries.mockResolvedValue([
      dirEntry('zeta', true), dirEntry('Beta', true), dirEntry('.git', true),
      dirEntry('README.md', false),
    ]);
    const res = await listRemoteDirs('h1', '~/projects');
    expect(res).toEqual({ ok: true, dirs: ['~/projects/Beta', '~/projects/zeta'], home: '/home/dev' });
    const prefixed = await listRemoteDirs('h1', '~/projects', 'z');
    expect(prefixed.dirs).toEqual(['~/projects/zeta']);
    // The root keeps its single slash; an absolute seed needs no home, so the
    // payload carries none (the browser only labels `~` for a home seed).
    sftp.entries.mockResolvedValue([dirEntry('home', true)]);
    await expect(listRemoteDirs('h1', '/')).resolves.toEqual({ ok: true, dirs: ['/home'] });
  });

  it('answers ok:false for a missing directory and a lane failure', async () => {
    sftp.entries.mockResolvedValue(null);
    await expect(listRemoteDirs('h1', '~/gone')).resolves.toMatchObject({ ok: false });
    sftp.entries.mockRejectedValue(new Error('sftp timeout'));
    await expect(listRemoteDirs('h1', '~')).resolves.toMatchObject({ ok: false, error: 'sftp timeout' });
  });
});

describe('statRemotePath', () => {
  it('answers isDirectory/size/mtime, {ok:false} when missing', async () => {
    sftp.stat.mockResolvedValue({ size: 4096, mtimeMs: 1700000000000, isDirectory: true });
    await expect(statRemotePath('h1', '~/dev')).resolves.toEqual({
      ok: true, isDirectory: true, size: 4096, mtimeMs: 1700000000000,
    });
    sftp.stat.mockResolvedValue(null);
    await expect(statRemotePath('h1', '~/gone')).resolves.toEqual({ ok: false });
    expect(sftp.stat).toHaveBeenCalledWith(enrolled, '/home/dev/dev', { timeoutMs: 10000 });
  });

  // Audit R93 pin: this function is the Add-project DIR BROWSER (`hosts:stat`).
  // It stays outside the project roots on purpose — the browser has to name
  // folders that are not projects yet, and the enrolled HostRecord is that
  // flow's consent. The TREE rails (fs:exists / fs:stat / fs:isDirectory) call
  // isRemotePathInKnownProject themselves; pinning the difference here is what
  // stops a future "fix" from gating the browser too.
  it('is NOT project-contained: the dir-browser lane answers outside every project', async () => {
    sftp.stat.mockResolvedValue({ size: 1, mtimeMs: 0, isDirectory: false });
    await expect(statRemotePath('h1', '/etc/hosts')).resolves.toMatchObject({ ok: true });
    expect(sftp.stat).toHaveBeenCalledOnce();
  });
});

describe('ensureRemoteDir', () => {
  it('mkdir -p over the exec lane and answers the echoed canonical path', async () => {
    vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) =>
      cmd.includes('$HOME') ? '/home/dev' : '/home/dev/projects/demo');
    const res = await ensureRemoteDir('h1', '~/projects/demo');
    expect(res).toEqual({ ok: true, path: '/home/dev/projects/demo' });
    const cmd = vi.mocked(exec).mock.calls[1][1] as string;
    expect(cmd).toBe(`mkdir -p "/home/dev/projects/demo" && printf '%s' "/home/dev/projects/demo"`);
  });

  // Row 129 non-regression: quoting `~` (or `~/`) is literal to the remote
  // shell, so the old `'~/'` shim CREATED a directory named `~`. The path is
  // expanded against the resolved home before it is ever quoted.
  it('expands a bare ~ to the home dir, never a literal "~" directory', async () => {
    vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) =>
      cmd.includes('$HOME') ? '/home/dev' : '/home/dev');
    await expect(ensureRemoteDir('h1', '~')).resolves.toEqual({ ok: true, path: '/home/dev' });
    const cmd = vi.mocked(exec).mock.calls[1][1] as string;
    expect(cmd).toBe(`mkdir -p "/home/dev" && printf '%s' "/home/dev"`);
    expect(cmd).not.toContain('~');
    expect(cmd).not.toContain('$HOME');
  });

  it('refuses a reply that is not an absolute path', async () => {
    vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) =>
      cmd.includes('$HOME') ? '/home/dev' : 'relative/spelling');
    await expect(ensureRemoteDir('h1', '~/x')).resolves.toMatchObject({ ok: false });
  });

  it('reports an exec failure as an error (mkdir on an existing file)', async () => {
    vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) => {
      if (cmd.includes('$HOME')) return '/home/dev';
      throw new Error('ssh exec exit 1: mkdir');
    });
    await expect(ensureRemoteDir('h1', '~/x')).resolves.toMatchObject({ ok: false, error: 'ssh exec exit 1: mkdir' });
  });
});

describe('cloneRemoteRepo', () => {
  it('mirrors the local URL gate: allowlisted hosts only', async () => {
    for (const url of ['https://evil.example/o/r', 'file:///tmp/x', 'ext::sh -c x', 42]) {
      expect(await cloneRemoteRepo('h1', url as never, '~/r')).toMatchObject({ ok: false, error: 'Unsupported repository URL' });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('clones on the host with quoted argv', async () => {
    sftp.stat.mockResolvedValue(null);
    vi.mocked(exec).mockImplementation(async (_r: unknown, cmd: string) =>
      cmd.includes('$HOME') ? '/home/dev' : '');
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/projects/r'))
      .resolves.toEqual({ ok: true });
    // The home probe rides first (row 129), the clone is the second exec.
    const cmd = vi.mocked(exec).mock.calls[1][1] as string;
    // Row 129: the destination is expanded client-side, so the quoted argv
    // carries the absolute path (a quoted `~/…` is literal to the shell).
    expect(cmd).toBe(`git clone -- "https://github.com/o/r" "/home/dev/projects/r"`);
  });

  it('refuses a non-empty / non-directory destination (the local pre-check)', async () => {
    sftp.stat.mockResolvedValue({ size: 0, mtimeMs: 0, isDirectory: false });
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/r'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('not a directory') });

    sftp.stat.mockResolvedValue({ size: 4096, mtimeMs: 0, isDirectory: true });
    sftp.entries.mockResolvedValue([dirEntry('x', true)]);
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/r'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('not empty') });
    // Row 129: the pre-check stats the ABSOLUTE destination, and the only exec
    // that ran is the cached home probe — never the clone.
    expect(sftp.stat).toHaveBeenCalledWith(enrolled, '/home/dev/r', { timeoutMs: 10000 });
    expect(vi.mocked(exec).mock.calls.every(([, cmd]) => !cmd.startsWith('git clone'))).toBe(true);
  });

  it('refuses when git is missing on the host', async () => {
    vi.mocked(getHost).mockReturnValue({
      ...enrolled, prerequisites: { git: { ok: false } },
    });
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/r'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('git is not installed') });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('isRemotePathInKnownProject (file-lane containment, §11)', () => {
  it('answers inside a project root of the same host, tolerating trailing slashes', () => {
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app')).toBe(true);
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/src/main.ts')).toBe(true);
    store.projects = [{ path: '/home/dev/dev/app/', hostId: 'h1' }];
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/x')).toBe(true);
  });

  it('rejects siblings, parents, and other hosts', () => {
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app2')).toBe(false);
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev')).toBe(false);
    expect(isRemotePathInKnownProject('h2', '/home/dev/dev/app')).toBe(false);
    // A project with no hostId is a local project (store normalizes, the
    // helper must not lean on that): never a root for a remote lane.
    store.projects = [{ path: '/home/dev/dev/app' }];
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app')).toBe(false);
  });

  // Audit R94: provider:getConfig used a raw startsWith, and joinPosix +
  // normalizeProviderPath collapse `..` lexically AFTER the compare, so
  // `/proj/evil/../../secret` passed the gate and the fixed config filenames
  // (.mcp.json, tokens in) were read out of `/secret` on the host. The same
  // rule normalizeRemotePath applies: `..` dies on the RAW segments.
  it('rejects `..` traversal before the compare (arbitrary host-dir config read)', () => {
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/../../secret')).toBe(false);
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/x/../..')).toBe(false);
    // Strict by design (no `..` at all, the normalizeRemotePath rule): a
    // spelling that WOULD collapse back inside is still refused, so the gate
    // never depends on a later lexical collapse.
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/src/../src/a.ts')).toBe(false);
    // A root spelled with a duplicated separator or trailing slash compares in
    // its normalized form; the contained child still answers.
    store.projects = [{ path: '/home/dev//dev/app/', hostId: 'h1' }];
    expect(isRemotePathInKnownProject('h1', '/home/dev/dev/app/src/a.ts')).toBe(true);
  });

  it('refuses a non-string and a relative spelling instead of matching one', () => {
    expect(isRemotePathInKnownProject('h1', undefined as never)).toBe(false);
    expect(isRemotePathInKnownProject('h1', 'dev/app' as never)).toBe(false);
  });
});

describe('listRemoteDir (fs:listDir rail)', () => {
  it('lists files and dirs with joined paths', async () => {
    sftp.entries.mockResolvedValue([dirEntry('src', true), dirEntry('README.md', false)]);
    const res = await listRemoteDir('h1', '/home/dev/dev/app');    expect(res).toEqual({
      ok: true,
      entries: [
        { name: 'src', path: '/home/dev/dev/app/src', isDirectory: true },
        { name: 'README.md', path: '/home/dev/dev/app/README.md', isDirectory: false },
      ],
    });
  });

  it('caps one listing at MAX_REMOTE_LIST_ENTRIES', async () => {
    sftp.entries.mockResolvedValue(
      Array.from({ length: 2500 }, (_, i) => dirEntry(`f${i}`, false)),
    );
    const res = await listRemoteDir('h1', '/home/dev/dev/app');
    expect(res.ok && res.entries).toHaveLength(2000);
  });

  it('refuses outside the host project roots before touching sftp', async () => {
    const res = await listRemoteDir('h1', '/home/dev/etc');
    expect(res.ok).toBe(false);
    expect(sftp.entries).not.toHaveBeenCalled();
  });

  it('refuses unenrolled hosts, traversal, and dead dirs', async () => {
    vi.mocked(getHost).mockReturnValue({ ...enrolled, enrollmentStatus: 'draft' });
    expect((await listRemoteDir('h1', '/home/dev/dev/app')).ok).toBe(false);
    vi.mocked(getHost).mockReturnValue(enrolled);
    expect((await listRemoteDir('h1', '/home/dev/dev/app/../../etc')).ok).toBe(false);
    sftp.entries.mockResolvedValue(null);
    expect((await listRemoteDir('h1', '/home/dev/dev/app')).ok).toBe(false);
  });

  // Row 129: a project stored in the canonical `~` spelling is a known project
  // root AND reaches sftp as an absolute path.
  it('expands a home-anchored project root for the sftp lane', async () => {
    store.projects = [{ path: '~/dev/app', hostId: 'h1' }];
    sftp.entries.mockResolvedValue([dirEntry('src', true)]);
    const res = await listRemoteDir('h1', '~/dev/app');
    expect(sftp.entries).toHaveBeenCalledWith(enrolled, '/home/dev/dev/app', { timeoutMs: 10000 });
    expect(res).toEqual({ ok: true, entries: [{ name: 'src', path: '~/dev/app/src', isDirectory: true }] });
  });
});

describe('readRemoteFile (fs:readFile rail)', () => {
  it('reads a text file after the head sniff', async () => {
    sftp.stat.mockResolvedValue({ isDirectory: false, size: 12, mtimeMs: 0 });
    sftp.readRange.mockResolvedValue(Buffer.from('hello world\n'));
    sftp.read.mockResolvedValue('hello world\n');
    await expect(readRemoteFile('h1', '/home/dev/dev/app/x.txt'))
      .resolves.toEqual({ ok: true, content: 'hello world\n' });
    expect(sftp.stat).toHaveBeenCalledWith(enrolled, '/home/dev/dev/app/x.txt', { timeoutMs: 10000 });
  });

  it('sniffs NUL as binary before the full read', async () => {
    sftp.stat.mockResolvedValue({ isDirectory: false, size: 100, mtimeMs: 0 });
    sftp.readRange.mockResolvedValue(Buffer.from([104, 105, 0, 33]));
    await expect(readRemoteFile('h1', '/home/dev/dev/app/bin'))
      .resolves.toEqual({ ok: false, reason: 'binary' });
    expect(sftp.read).not.toHaveBeenCalled();
  });

  it('refuses over-cap sizes, dirs, missing files, and off-project paths', async () => {
    sftp.stat.mockResolvedValue({ isDirectory: false, size: 9 * 1024 * 1024, mtimeMs: 0 });
    expect(await readRemoteFile('h1', '/home/dev/dev/app/big')).toEqual({ ok: false, reason: 'error' });
    sftp.stat.mockResolvedValue({ isDirectory: true, size: 0, mtimeMs: 0 });
    expect(await readRemoteFile('h1', '/home/dev/dev/app/dir')).toEqual({ ok: false, reason: 'error' });
    sftp.stat.mockResolvedValue(null);
    expect(await readRemoteFile('h1', '/home/dev/dev/app/ghost')).toEqual({ ok: false, reason: 'error' });
    expect(await readRemoteFile('h1', '/etc/passwd')).toEqual({ ok: false, reason: 'error' });
    expect(sftp.read).not.toHaveBeenCalled();
  });
});

// R2 Phase 4a: the fs:listFiles sibling. Mirrors the local non-git walk:
// DFS, depth cap, ignore set, dotfiles skipped, posix-relative output.
describe('walkRemoteFiles (fs:listFiles rail, Phase 4a)', () => {
  it('walks the tree and returns posix-relative file paths', async () => {
    const { walkRemoteFiles } = await import('./remote-fs.js');
    sftp.entries.mockImplementation((_r: unknown, dir: string) =>
      Promise.resolve(
        dir === '/home/dev/dev/app'
          ? [dirEntry('src', true), dirEntry('README.md', false), dirEntry('node_modules', true), dirEntry('.hidden', false)]
          : dir === '/home/dev/dev/app/src'
            ? [dirEntry('main.ts', false), dirEntry('util.ts', false)]
            : [],
      ),
    );
    const files = await walkRemoteFiles('h1', '/home/dev/dev/app');
    // DFS in readdir order (the local walk's contract): src is listed before
    // README.md, so its children land first.
    expect(files).toEqual(['src/main.ts', 'src/util.ts', 'README.md']);
  });

  it('stops recursing at depth 5', async () => {
    const { walkRemoteFiles } = await import('./remote-fs.js');
    // A chain of nested dirs, each named d: root/d/d/d/d/d/d/file
    sftp.entries.mockImplementation((_r: unknown, dir: string) => {
      const depth = dir.split('/').length - 5; // 0 at root, 1 at root/d, ...
      return Promise.resolve(depth < 6 ? [dirEntry('d', true)] : [dirEntry('file', false)]);
    });
    const files = await walkRemoteFiles('h1', '/home/dev/dev/app');
    // Dirs exist through depth 6; the walk stops at depth 5 (MAX_DEPTH), so
    // the depth-6 file is never listed.
    expect(files).toEqual([]);
  });

  it('answers empty for an unsafe path and for an unreadable root', async () => {
    const { walkRemoteFiles } = await import('./remote-fs.js');
    expect(await walkRemoteFiles('h1', 'relative/path')).toEqual([]);
    sftp.entries.mockResolvedValue(null); // no such dir
    expect(await walkRemoteFiles('h1', '/home/dev/dev/app')).toEqual([]);
  });
});
