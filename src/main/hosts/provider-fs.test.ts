import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// homedir is swapped via module mock (ESM namespaces are not spy-able).
const HOME = vi.hoisted(() => ({ value: '/home/fake' }));
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => HOME.value,
}));

// The seam's remote lane is faked at the ssh-client boundary (the same mock
// point ssh-client.test uses one level down); the local lane runs against a
// real tmpdir.
const sftp = vi.hoisted(() => ({
  read: vi.fn(),
  statSize: vi.fn(),
  readRange: vi.fn(),
  listDir: vi.fn(),
  write: vi.fn(),
}));
vi.mock('./ssh-client', () => ({
  sftpRead: sftp.read,
  sftpStatSize: sftp.statSize,
  sftpReadRange: sftp.readRange,
  sftpListDir: sftp.listDir,
  sftpWrite: sftp.write,
}));
const record = { id: 'lab' } as never;
vi.mock('./host-registry', () => ({
  getHost: (id: string) => (id === 'lab' ? record : null),
}));

import {
  MAX_WINDOW_BYTES,
  listProviderDir,
  normalizeProviderPath,
  readProviderFile,
  readProviderFileWindow,
  statProviderFileSize,
  writeProviderFile,
} from './provider-fs';

describe('normalizeProviderPath', () => {
  it.each([
    ['../etc/passwd', null],
    ['a/../../b', null],
    ['~/.claude/settings.json', '.claude/settings.json'],
    ['~', null],
    ['~/', null],
    ['/home/dev/.pi/agent/mcp.json', '/home/dev/.pi/agent/mcp.json'],
    ['a//b', 'a/b'],
    ['', null],
    ['.', null],
    ['/', null],
    ['a\\b\\c', 'a/b/c'],
  ])('%s → %s', (input, want) => {
    expect(normalizeProviderPath(input)).toBe(want);
  });

  it('unsafe paths throw at every entry point before any I/O', async () => {
    sftp.read.mockClear();
    await expect(readProviderFile('lab', '../x')).rejects.toThrow(/Unsafe/);
    await expect(statProviderFileSize('lab', '../x')).rejects.toThrow(/Unsafe/);
    await expect(readProviderFileWindow('lab', '../x', 10)).rejects.toThrow(/Unsafe/);
    await expect(listProviderDir('lab', '../x')).rejects.toThrow(/Unsafe/);
    await expect(writeProviderFile('lab', '../x', '')).rejects.toThrow(/Unsafe/);
    expect(sftp.read).not.toHaveBeenCalled();
  });

  it('unknown host ids throw, never fall back to local', async () => {
    await expect(readProviderFile('ghost', 'a.json')).rejects.toThrow(/Unknown host/);
  });
});

describe('local lane (tmpdir)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-fs-'));
    HOME.value = home;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('read: home-relative resolves under homedir; missing → null', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"x"}');
    expect(await readProviderFile(undefined, '~/.claude/settings.json')).toBe('{"model":"x"}');
    expect(await readProviderFile('local', '.claude/settings.json')).toBe('{"model":"x"}');
    expect(await readProviderFile(undefined, '~/.claude/nope.json')).toBeNull();
  });

  it('window reads: head, tail (fromEnd), and clamp boundaries', async () => {
    const file = path.join(home, 't.jsonl');
    fs.writeFileSync(file, 'A'.repeat(100));
    expect(await readProviderFileWindow(undefined, 't.jsonl', 10)).toBe('A'.repeat(10));
    const tail = await readProviderFileWindow(undefined, 't.jsonl', 30, { fromEnd: true });
    expect(tail).toBe('A'.repeat(30));
    // Window larger than the file: whole content, no padding.
    expect(await readProviderFileWindow(undefined, 't.jsonl', 500, { fromEnd: true })).toBe('A'.repeat(100));
    // Zero-length window → empty.
    expect(await readProviderFileWindow(undefined, 't.jsonl', 0)).toBe('');
    // Missing file → null.
    expect(await readProviderFileWindow(undefined, 'nope.jsonl', 10, { fromEnd: true })).toBeNull();
  });

  it('window length is capped at MAX_WINDOW_BYTES', async () => {
    const file = path.join(home, 'big.jsonl');
    fs.writeFileSync(file, 'B'.repeat(MAX_WINDOW_BYTES + 10));
    const w = await readProviderFileWindow(undefined, 'big.jsonl', MAX_WINDOW_BYTES + 10, { fromEnd: true });
    expect(w).toBe('B'.repeat(MAX_WINDOW_BYTES));
  });

  it('stat/list/write round-trip; list of a missing dir → null', async () => {
    await writeProviderFile(undefined, 'sub/dir/x.json', '{"a":1}').catch(() => {}); // parent missing → throws
    fs.mkdirSync(path.join(home, 'sub', 'dir'), { recursive: true });
    await writeProviderFile(undefined, 'sub/dir/x.json', '{"a":1}');
    expect(await statProviderFileSize(undefined, 'sub/dir/x.json')).toBe(7);
    expect(await statProviderFileSize(undefined, 'sub/dir/nope')).toBeNull();
    expect(await listProviderDir(undefined, 'sub/dir')).toEqual(['x.json']);
    expect(await listProviderDir(undefined, 'sub/none')).toBeNull();
  });
});

describe('remote lane (faked sftp)', () => {
  beforeEach(() => {
    for (const f of Object.values(sftp)) f.mockReset();
  });

  it('home-relative paths reach sftp as ~/<path>; absolute posix paths pass through', async () => {
    sftp.read.mockResolvedValue('v');
    expect(await readProviderFile('lab', '~/.claude/settings.json')).toBe('v');
    expect(sftp.read).toHaveBeenCalledWith(record, '~/.claude/settings.json', undefined);
    await readProviderFile('lab', '/home/dev/.pi/agent/mcp.json');
    expect(sftp.read).toHaveBeenLastCalledWith(record, '/home/dev/.pi/agent/mcp.json', undefined);
  });

  it('missing (sftp null) propagates as null; other errors propagate', async () => {
    sftp.read.mockResolvedValueOnce(null);
    expect(await readProviderFile('lab', 'a.json')).toBeNull();
    sftp.read.mockRejectedValueOnce(new Error('connection closed'));
    await expect(readProviderFile('lab', 'a.json')).rejects.toThrow('connection closed');
  });

  it('fromEnd window: stat sizes the tail, range reads size-length at the offset', async () => {
    sftp.statSize.mockResolvedValue(1000);
    sftp.readRange.mockResolvedValue(Buffer.from('tail'));
    const w = await readProviderFileWindow('lab', 's.jsonl', 256, { fromEnd: true });
    expect(w).toBe('tail');
    // The seam's fromEnd selector never rides down the sftp lane (nit #11).
    expect(sftp.statSize).toHaveBeenCalledWith(record, '~/s.jsonl', undefined);
    expect(sftp.readRange).toHaveBeenCalledWith(record, '~/s.jsonl', 744, 256, undefined);
    // Gone file: stat null → no range read.
    sftp.statSize.mockResolvedValueOnce(null);
    expect(await readProviderFileWindow('lab', 's.jsonl', 256, { fromEnd: true })).toBeNull();
    // Small file: offset clamps at 0.
    sftp.statSize.mockResolvedValue(10);
    await readProviderFileWindow('lab', 's.jsonl', 256, { fromEnd: true });
    expect(sftp.readRange).toHaveBeenLastCalledWith(record, '~/s.jsonl', 0, 256, undefined);
  });

  it('head window needs no stat', async () => {
    sftp.readRange.mockResolvedValue(Buffer.from('head'));
    expect(await readProviderFileWindow('lab', 's.jsonl', 64)).toBe('head');
    expect(sftp.statSize).not.toHaveBeenCalled();
    expect(sftp.readRange).toHaveBeenCalledWith(record, '~/s.jsonl', 0, 64, undefined);
  });

  it('list and write route through the seam', async () => {
    sftp.listDir.mockResolvedValue(['a.jsonl']);
    expect(await listProviderDir('lab', '.finevibe/run')).toEqual(['a.jsonl']);
    expect(sftp.listDir).toHaveBeenCalledWith(record, '~/.finevibe/run', undefined);
    await writeProviderFile('lab', '.claude/settings.json', '{}');
    expect(sftp.write).toHaveBeenCalledWith(record, '~/.claude/settings.json', '{}', undefined);
  });
});
