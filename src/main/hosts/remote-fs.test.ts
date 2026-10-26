// Remote open/add folder (per-host providers T5, plan §6, UR-6): the path
// gate, the host gate, and the exec/sftp shapes. ssh-client is a scripted
// fake (the enrollment.test.ts idiom); host-registry answers from a stub.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types';

const sftp = vi.hoisted(() => ({
  entries: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('./ssh-client', () => ({
  sftpListDirEntries: (record: unknown, dir: string, opts?: unknown) => sftp.entries(record, dir, opts),
  sftpStat: (record: unknown, p: string, opts?: unknown) => sftp.stat(record, p, opts),
  exec: vi.fn(),
}));

import { exec } from './ssh-client';
import { getHost } from './host-registry';
import {
  cloneRemoteRepo,
  ensureRemoteDir,
  listRemoteDirs,
  normalizeRemotePath,
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
  vi.mocked(exec).mockReset();
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
