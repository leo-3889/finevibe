import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { Readable } from 'stream';
import type { Stats, ReadStream } from 'fs';

/**
 * Pi-Bolt global-search corpus (F13), modeled on pi-provider.search.test.ts
 * and scoped to pi-bolt reality: Pi-Bolt shares Pi's `~/.pi/agent` tree, so
 * its discoverTranscripts() enumerates ONLY its own flat per-launch base
 * (`pi-bolt-sessions`) — never Pi's legacy roots. Sidecar `.finevibe.json`
 * carries each dir's configDir for profile attribution; the listing is gated
 * by the retention window; a transient per-dir readdir failure marks the
 * pass incomplete (P2-70 semantics via TranscriptDiscoveryScan).
 */

const profiles = vi.hoisted(() => ({ list: [] as Array<{ id: string; providerId: string; configDir: string }> }));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  lstatSync: vi.fn(() => ({ isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() })),
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  createReadStream: vi.fn(),
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
    open: vi.fn(),
    stat: vi.fn(),
    // listLaunchSessionDirs() (PA-19: async) lstats entries (a symlink in
    // the search path is never followed). Fresh mtime = inside the window.
    lstat: vi.fn(async () => ({ isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() })),
  },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home', tmpdir: () => '/tmp' }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  // launchSessionBaseDir() derives the per-launch session dirs from userData.
  app: { getPath: () => '/mock/app-path' },
}));
vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true, validateBinaryExistsAsync: async () => true }));
// profileIdForConfigDir() maps the sidecar configDir through the profile
// store; the suite drives the profile list per test.
vi.mock('../store', () => ({
  loadState: () => ({ profiles: profiles.list }),
}));

import * as fs from 'fs';
import { PiBoltProvider } from './pi-bolt-provider';

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
const mockLstat = vi.mocked(fs.promises.lstat);

const SID = '01b007b0-07e5-7eb4-b41b-438d945f89f3';
const header = (id: string, cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-08-15T23:09:32.005Z', cwd });
const FILE_NAME = `2026-08-15T23-09-32-005Z_${SID}.jsonl`;
/** Pi-Bolt's single flat launch base (userData-scoped; never Pi's tree). */
const BASE = path.join('/mock/app-path', 'pi-bolt-sessions');

beforeEach(() => {
  vi.clearAllMocks();
  profiles.list = [];
  // PA-19: the per-launch base listing goes through fs.promises.readdir;
  // default = no dirs. Tests that scan one prepend a chain entry.
  mockReaddir.mockResolvedValue([] as any);
  mockLstat.mockImplementation(async () => ({ isDirectory: () => true, isFile: () => true, mtimeMs: Date.now() }) as any);
});

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

describe('PiBoltProvider.getTranscriptPath()', () => {
  it('resolves the launch dir first (flat layout, authoritative cwd)', () => {
    const sessionDir = path.join(BASE, 'ui-pb1');
    mockReaddirSync.mockReturnValueOnce([FILE_NAME, 'notes.txt'] as any);
    mockSyncHeader(header(SID, 'C:\\Users\\me'));

    const p = new PiBoltProvider().getTranscriptPath(SID, 'C:\\Users\\me', undefined, sessionDir);
    expect(p).toBe(path.join(sessionDir, FILE_NAME));
    // The exclusive dir answered: the shared Pi tree was never walked.
    expect(mockReaddirSync).toHaveBeenCalledTimes(1);
  });

  it('a cwd-mismatched flat-dir file resolves to null, never the shared tree by accident', () => {
    const sessionDir = path.join(BASE, 'ui-pb2');
    mockReaddirSync
      .mockReturnValueOnce([FILE_NAME] as any) // flat launch dir
      .mockReturnValueOnce([] as any); // shared ~/.pi/agent/sessions: no project dirs
    mockSyncHeader(header(SID, 'C:\\Users\\elsewhere'));

    expect(new PiBoltProvider().getTranscriptPath(SID, 'C:\\Users\\me', undefined, sessionDir)).toBeNull();
  });

  it('falls back to the shared Pi tree when the launch dir misses (Pi-Bolt shares ~/.pi/agent)', () => {
    const sessionDir = path.join(BASE, 'ui-pb3');
    mockExistsSync.mockReturnValueOnce(false); // launch dir absent
    mockReaddirSync
      .mockReturnValueOnce(['--C--Users-me--'] as any) // shared sessions/
      .mockReturnValueOnce([FILE_NAME] as any); // project dir
    mockSyncHeader(header(SID, 'C:\\Users\\me'));

    const p = new PiBoltProvider().getTranscriptPath(SID, 'C:\\Users\\me', undefined, sessionDir);
    expect(p).not.toBeNull();
    expect(p).toContain(FILE_NAME);
    expect(p).not.toContain('pi-bolt-sessions');
  });
});

describe('PiBoltProvider.discoverTranscripts()', () => {
  it('scans ONLY its own flat pi-bolt-sessions base and attributes the sidecar profile', async () => {
    profiles.list = [{ id: 'work', providerId: 'pi-bolt', configDir: '/profiles/work' }];
    const sessionDir = path.join(BASE, 'sess-pb1');
    mockReadFile.mockResolvedValue(JSON.stringify({
      providerId: 'pi-bolt', cwd: 'C:\\Users\\me', configDir: '/profiles/work',
      createdAt: '2026-08-15T23:09:32.005Z',
    }) as any);
    mockReaddir
      .mockResolvedValueOnce(['sess-pb1'] as any) // per-launch base listing
      .mockResolvedValueOnce([FILE_NAME, 'notes.txt'] as any); // per-launch dir (flat layout)
    mockAsyncHeader(header(SID, 'C:\\Users\\me'));

    const { descriptors: out, complete, incompleteRoots } = await new PiBoltProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(incompleteRoots).toEqual([]);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(SID);
    expect(out[0].projectCwd).toBe('C:\\Users\\me');
    expect(out[0].transcriptPath).toBe(path.join(sessionDir, FILE_NAME));
    // Sidecar configDir → profile id, so resume reopens against the right login.
    expect(out[0].profileId).toBe('work');
    // Pi-Bolt's corpus is the one launch base — Pi's shared tree is NOT
    // enumerated here (the Pi provider already surfaces it; no double-list).
    expect(mockReaddir).toHaveBeenCalledWith(BASE);
    expect(mockReaddir.mock.calls.map((c) => c[0])).not.toContain(path.join('/mock/home', '.pi', 'agent', 'sessions'));
  });

  it('reports a complete empty pass when the launch base is missing', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await new PiBoltProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('gates the listing on the retention window: a dead dir is not scanned', async () => {
    // Dir mtime past the 30-day window and no transcript inside: the
    // listing filter drops it, so search never pays a header read for it
    // (listLaunchSessionDirs mirrors the prune predicate).
    mockLstat.mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false, mtimeMs: Date.now() - 31 * 24 * 60 * 60 * 1000 } as any);
    mockReaddir
      .mockResolvedValueOnce(['sess-pb-stale'] as any) // base listing
    expect(await new PiBoltProvider().discoverTranscripts()).toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
    // The dropped dir is never SCANned: the gate's one mtime probe is its
    // only touch, and the header reader (the scan's syscall) stays untouched.
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockReaddir).toHaveBeenCalledTimes(2); // base listing + the gate's own transcript check
  });

  it('marks the pass incomplete when a per-launch dir readdir fails transiently (P2-70)', async () => {
    const sessionDir = path.join(BASE, 'sess-pb3');
    mockReadFile.mockResolvedValue(JSON.stringify({
      providerId: 'pi-bolt', cwd: 'C:\\Users\\me', createdAt: '2026-08-15T23:09:32.005Z',
    }) as any);
    mockReaddir
      .mockResolvedValueOnce(['sess-pb3'] as any)
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' })); // flat dir listing

    const { descriptors, complete, incompleteRoots } = await new PiBoltProvider().discoverTranscripts();
    expect(descriptors).toEqual([]);
    expect(complete).toBe(false);
    expect(incompleteRoots).toEqual([sessionDir]);
  });

  it('a missing sidecar degrades to the default profile, never a guess', async () => {
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockReaddir
      .mockResolvedValueOnce(['sess-pb4'] as any)
      .mockResolvedValueOnce([FILE_NAME] as any);
    mockAsyncHeader(header(SID, 'C:\\Users\\me'));

    const { descriptors: out, complete } = await new PiBoltProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].profileId).toBeUndefined();
  });
});

describe('PiBoltProvider.indexTranscript()', () => {
  it('extracts user-typed text only, joining text blocks under the char budget', async () => {
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

    const r = await new PiBoltProvider().indexTranscript('/p');
    expect(r.text).toContain('hi');
    expect(r.text).toContain('plain follow-up');
    expect(r.text).not.toContain('never indexed');
    expect(r.cwd).toBe('C:\\Users\\me');
  });

  it('returns empty on read failure', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValueOnce(new Error('ENOENT'));
    expect(await new PiBoltProvider().indexTranscript('/p')).toEqual({ text: '', cwd: '' });
  });
});
