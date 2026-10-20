import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { Readable } from 'stream';
import type { Stats, ReadStream } from 'fs';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  // listLaunchSessionDirs() lstats entries (a symlink in the search path is
  // never followed); a default missing from this factory makes the listing
  // throw into its own catch and silently report no dirs.
  lstatSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() })),
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  createReadStream: vi.fn(),
  promises: { readFile: vi.fn(), readdir: vi.fn(), open: vi.fn(), stat: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home', tmpdir: () => '/tmp' }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  // launchSessionBaseDir() derives the per-launch session dirs from userData.
  app: { getPath: () => '/mock/app-path' },
}));
vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true }));

import * as fs from 'fs';
import { PiProvider } from './pi-provider';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockOpenSync = vi.mocked(fs.openSync);
// Mock fs implements the read subset the search uses; type against it, not the
// full PathLike/ArrayBufferView signatures.
const mockReadSync = vi.mocked(fs.readSync as unknown as (fd: number, target: Buffer) => number);
const mockCloseSync = vi.mocked(fs.closeSync as unknown as (fd: number) => boolean);
const mockReadFile = vi.mocked(fs.promises.readFile);
const mockReaddir = vi.mocked(fs.promises.readdir);
const mockOpen = vi.mocked(fs.promises.open);

const SID = '01a007b0-07e5-7eb4-b41b-438d945f89f3';
const header = (id: string, cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-15T23:09:32.005Z', cwd });
const FILE_NAME = `2026-08-15T23-09-32-005Z_${SID}.jsonl`;

beforeEach(() => { vi.clearAllMocks(); });

/** Make the bounded sync header reader (openSync/readSync/closeSync) serve `firstLine`. */
function mockSyncHeader(firstLine: string): void {
  mockOpenSync.mockReturnValue(42);
  mockReadSync.mockImplementation((_fd: number, target: Buffer) => {
    const buf = Buffer.from(firstLine);
    buf.copy(target);
    return buf.length;
  });
  mockCloseSync.mockReturnValue(true);
}

/** Make the bounded async header reader (promises.open) serve `firstLine`. */
function mockAsyncHeader(firstLine: string): void {
  mockOpen.mockResolvedValue({
    read: vi.fn(async (buf: Buffer) => {
      const b = Buffer.from(firstLine);
      b.copy(buf);
      return { bytesRead: b.length };
    }),
    close: vi.fn(async () => {}),
  } as any);
}

describe('PiProvider.getTranscriptPath()', () => {
  it('matches the session header id and prefers an exact cwd', () => {
    mockReaddirSync
      .mockReturnValueOnce(['--C--Users-me--'] as any) // sessions/
      .mockReturnValueOnce([FILE_NAME] as any); // project dir
    mockSyncHeader(header(SID, 'C:\\Users\\me'));

    const p = new PiProvider().getTranscriptPath(SID, 'C:\\Users\\me');
    expect(p).not.toBeNull();
    expect(p).toContain(FILE_NAME);
  });

  // S2: the old code fell back to a header match when the requested cwd did
  // not match, which handed back a transcript from a DIFFERENT project and
  // then cached that path for the session's whole life. The cwd match is now
  // authoritative — a mismatch resolves to null, never to a near miss.
  it('does not fall back to a header match when the cwd differs', () => {
    mockReaddirSync
      .mockReturnValueOnce(['--C--Users-me--'] as any)
      .mockReturnValueOnce([FILE_NAME] as any);
    mockSyncHeader(header(SID, 'C:\\Users\\elsewhere'));

    expect(new PiProvider().getTranscriptPath(SID, 'C:\\Users\\me')).toBeNull();
  });

  it('skips files whose header id does not match', () => {
    mockReaddirSync
      .mockReturnValueOnce(['--C--Users-me--'] as any)
      .mockReturnValueOnce([FILE_NAME] as any);
    mockSyncHeader(header('other-id', 'C:\\Users\\me'));

    expect(new PiProvider().getTranscriptPath(SID, 'C:\\Users\\me')).toBeNull();
  });

  it('returns null when the sessions root is missing', () => {
    mockExistsSync.mockReturnValueOnce(false);
    expect(new PiProvider().getTranscriptPath(SID, 'C:\\Users\\me')).toBeNull();
  });

  it('honors a configDir override for the agent dir', () => {
    mockReaddirSync
      .mockReturnValueOnce(['--C--Users-me--'] as any)
      .mockReturnValueOnce([FILE_NAME] as any);
    mockSyncHeader(header(SID, 'C:\\Users\\me'));

    const p = new PiProvider().getTranscriptPath(SID, 'C:\\Users\\me', '/profiles/work');
    expect(p).not.toBeNull();
    // The walk started under the overridden agent dir, not ~/.pi/agent
    expect(mockReaddirSync).toHaveBeenCalledWith(path.join('/profiles/work', 'sessions'));
  });
});

describe('PiProvider.discoverTranscripts()', () => {
  it('emits a descriptor per .jsonl from the session header', async () => {
    mockReaddirSync.mockReturnValue([] as any); // no per-launch dirs under userData
    mockReaddir
      .mockResolvedValueOnce(['--C--Users-me--'] as any) // sessions/
      .mockResolvedValueOnce([FILE_NAME, 'notes.txt'] as any); // project dir
    mockAsyncHeader(header(SID, 'C:\\Users\\me'));

    const { descriptors: out, complete } = await new PiProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(SID);
    expect(out[0].projectCwd).toBe('C:\\Users\\me');
    expect(out[0].transcriptPath).toContain(FILE_NAME);
  });

  it('reports a complete empty pass when the sessions root is missing', async () => {
    mockReaddirSync.mockReturnValue([] as any); // no per-launch dirs under userData
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await new PiProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('marks the pass incomplete when the sessions root readdir fails transiently (P2-70)', async () => {
    mockReaddirSync.mockReturnValue([] as any); // no per-launch dirs under userData
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    const { descriptors: out, complete, incompleteRoots } = await new PiProvider().discoverTranscripts();
    expect(out).toEqual([]);
    expect(complete).toBe(false);
    expect(incompleteRoots).toHaveLength(1);
  });

  it('skips unreadable files', async () => {
    mockReaddirSync.mockReturnValue([] as any); // no per-launch dirs under userData
    mockReaddir
      .mockResolvedValueOnce(['--C--Users-me--'] as any)
      .mockResolvedValueOnce([FILE_NAME] as any);
    mockOpen.mockRejectedValueOnce(new Error('EIO'));
    // A per-file read failure is per-file tolerance, not a scan-root failure.
    expect(await new PiProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('scans the per-launch session dirs under userData', async () => {
    const base = path.join('/mock/app-path', 'pi-sessions');
    mockReaddirSync.mockImplementation(((p: string) => (String(p) === base ? ['sess-1'] : [])) as any);
    // A dir with activity inside the retention window: retention-filtered dirs
    // are not scanned by global search (see launch-session-dir.test.ts).
    vi.mocked(fs.lstatSync).mockReturnValue(
      { isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() } as any,
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      providerId: 'pi', cwd: 'C:\\Users\\me', createdAt: '2026-08-15T23:09:32.005Z',
    }) as any);
    mockReaddir
      .mockResolvedValueOnce([] as any) // legacy default root — empty
      .mockResolvedValueOnce([FILE_NAME, 'notes.txt'] as any); // per-launch dir (flat layout)
    mockAsyncHeader(header(SID, 'C:\\Users\\me'));

    const { descriptors: out, complete } = await new PiProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(SID);
    expect(out[0].projectCwd).toBe('C:\\Users\\me');
    expect(out[0].transcriptPath).toBe(path.join(base, 'sess-1', FILE_NAME));
    expect(out[0].profileId).toBeUndefined();
  });
});

describe('PiProvider.indexTranscript()', () => {
  it('extracts user-typed text only, joining text blocks and capping at the char budget', async () => {
    const jsonl = [
      header(SID, 'C:\\Users\\me'),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'never indexed' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'plain follow-up' } }),
    ].join('\n');
    // The indexer streams the head window (createReadStream) after a size
    // guard (promises.stat), so both must be served.
    vi.mocked(fs.promises.stat).mockResolvedValueOnce(
      { size: jsonl.length } as unknown as Stats
    );
    vi.mocked(fs.createReadStream).mockReturnValueOnce(
      Readable.from([jsonl]) as unknown as ReadStream
    );

    const r = await new PiProvider().indexTranscript('/p');
    expect(r.text).toContain('hi');
    expect(r.text).toContain('plain follow-up');
    expect(r.text).not.toContain('never indexed');
    expect(r.cwd).toBe('C:\\Users\\me');
  });

  it('returns empty on read failure', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await new PiProvider().indexTranscript('/p')).toEqual({ text: '', cwd: '' });
  });
});
