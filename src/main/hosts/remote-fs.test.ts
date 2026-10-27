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
  isRemotePathInKnownProject,
  listRemoteDir,
  listRemoteDirs,
  normalizeRemotePath,
  readRemoteFile,
  statRemotePath,
} from './remote-fs';

vi.mock('./host-registry', () => ({ getHost: vi.fn() }));

const enrolled: HostRecord = {
  id: 'h1', name: 'strix', user: 'dev', host: '192.168.2.242', port: 22,
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
  store.projects = [{ path: '/home/dev/dev/app', hostId: 'h1' }];
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
    await expect(listRemoteDirs('h1', '~')).resolves.toEqual({ ok: true, dirs: [] });
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
  it('lists dirs only, hides dot-names, sorts, prefix-filters, joins', async () => {
    sftp.entries.mockResolvedValue([
      dirEntry('zeta', true), dirEntry('Beta', true), dirEntry('.git', true),
      dirEntry('README.md', false),
    ]);
    const res = await listRemoteDirs('h1', '~/projects');
    expect(res).toEqual({ ok: true, dirs: ['~/projects/Beta', '~/projects/zeta'] });
    const prefixed = await listRemoteDirs('h1', '~/projects', 'z');
    expect(prefixed.dirs).toEqual(['~/projects/zeta']);
    // The root keeps its single slash.
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
    expect(sftp.stat).toHaveBeenCalledWith(enrolled, '~/dev', { timeoutMs: 10000 });
  });
});

describe('ensureRemoteDir', () => {
  it('mkdir -p over the exec lane and answers the echoed canonical path', async () => {
    vi.mocked(exec).mockResolvedValue('/home/dev/projects/demo');
    const res = await ensureRemoteDir('h1', '~/projects/demo');
    expect(res).toEqual({ ok: true, path: '/home/dev/projects/demo' });
    const cmd = vi.mocked(exec).mock.calls[0][1] as string;
    expect(cmd).toBe(`mkdir -p "$HOME/projects/demo" && printf '%s' "$HOME/projects/demo"`);
  });

  it('expands a bare ~ to the home dir, never a literal "~" directory', async () => {
    vi.mocked(exec).mockResolvedValue('/home/dev');
    await expect(ensureRemoteDir('h1', '~')).resolves.toEqual({ ok: true, path: '/home/dev' });
    const cmd = vi.mocked(exec).mock.calls[0][1] as string;
    expect(cmd).toContain('"$HOME/"');
    expect(cmd).not.toContain('"~"');
  });

  it('refuses a reply that is not an absolute path', async () => {
    vi.mocked(exec).mockResolvedValue('relative/spelling');
    await expect(ensureRemoteDir('h1', '~/x')).resolves.toMatchObject({ ok: false });
  });

  it('reports an exec failure as an error (mkdir on an existing file)', async () => {
    vi.mocked(exec).mockRejectedValue(new Error('ssh exec exit 1: mkdir'));
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
    vi.mocked(exec).mockResolvedValue('');
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/projects/r'))
      .resolves.toEqual({ ok: true });
    const cmd = vi.mocked(exec).mock.calls[0][1] as string;
    expect(cmd).toBe(`git clone -- "https://github.com/o/r" "$HOME/projects/r"`);
  });

  it('refuses a non-empty / non-directory destination (the local pre-check)', async () => {
    sftp.stat.mockResolvedValue({ size: 0, mtimeMs: 0, isDirectory: false });
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/r'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('not a directory') });

    sftp.stat.mockResolvedValue({ size: 4096, mtimeMs: 0, isDirectory: true });
    sftp.entries.mockResolvedValue([dirEntry('x', true)]);
    await expect(cloneRemoteRepo('h1', 'https://github.com/o/r', '~/r'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('not empty') });
    expect(exec).not.toHaveBeenCalled();
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
});

describe('listRemoteDir (fs:listDir rail)', () => {
  it('lists files and dirs with joined paths', async () => {
    sftp.entries.mockResolvedValue([dirEntry('src', true), dirEntry('README.md', false)]);
    const res = await listRemoteDir('h1', '/home/dev/dev/app');
    expect(res).toEqual({
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
});

describe('readRemoteFile (fs:readFile rail)', () => {
  it('reads a text file after the head sniff', async () => {
    sftp.stat.mockResolvedValue({ isDirectory: false, size: 12, mtimeMs: 0 });
    sftp.readRange.mockResolvedValue(Buffer.from('hello world\n'));
    sftp.read.mockResolvedValue('hello world\n');
    await expect(readRemoteFile('h1', '/home/dev/dev/app/x.txt'))
      .resolves.toEqual({ ok: true, content: 'hello world\n' });
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
