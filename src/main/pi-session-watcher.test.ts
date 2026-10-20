import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  readdirSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
  tmpdir: () => '/tmp',
}));

const electronMock = vi.hoisted(() => ({ windows: [] as { isDestroyed(): boolean }[] }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electronMock.windows },
}));

const { STATUS_DIR: MOCK_STATUS_DIR } = vi.hoisted(() => {
  const path = require('path');
  return { STATUS_DIR: path.join('/tmp', 'vibeyard') };
});

const mockRegisterTranscriptSync = vi.hoisted(() => vi.fn());

vi.mock('./hook-status', () => ({
  STATUS_DIR: MOCK_STATUS_DIR,
  writeCliSessionId: vi.fn(),
}));
vi.mock('./session-transcript-sync', () => ({
  registerTranscriptSync: mockRegisterTranscriptSync,
}));

import * as path from 'path';

import * as fs from 'fs';
import { writeCliSessionId } from './hook-status';
import {
  registerPendingPiSession,
  unregisterPiSession,
  startPiSessionWatcher,
  stopPiSessionWatcher,
} from './pi-session-watcher';

// The mock fs implements the subset the watcher uses; the real fs signatures
// are wider (PathLike, ArrayBufferView). Type the handles against that subset.
const mockReaddirSync = vi.mocked(fs.readdirSync as unknown as (p: string) => string[]);
const mockOpenSync = vi.mocked(fs.openSync as unknown as (p: string) => number);
const mockReadSync = vi.mocked(fs.readSync as unknown as (fd: number, target: Buffer) => number);
const mockCloseSync = vi.mocked(fs.closeSync as unknown as (fd: number) => boolean);
const mockWriteCliSessionId = vi.mocked(writeCliSessionId);
const mockWatch = vi.mocked(fs.watch);

/**
 * Every Pi launch gets an EXCLUSIVE per-launch session dir (see
 * launch-session-dir.ts); the mock fs models them as flat dirs —
 * transcripts appear directly inside. Paths are built with path.join so
 * the expectations hold on Windows as well as POSIX CI runners.
 */
const APP_DATA = path.join('/mock', 'app-data');
const DIR_UI1 = path.join(APP_DATA, 'pi-sessions', 'ui-1');
const DIR_UI2 = path.join(APP_DATA, 'pi-sessions', 'ui-2');
const DIR_PRO = path.join(APP_DATA, 'pi-sessions', 'ui-pro');
const DIR_EXT = path.join('/mock', 'default-tree'); // external CLI run — never watched

/**
 * Mock the launch dirs: readdirSync(dir) returns that dir's files.
 * Anything else throws ENOENT, as a real missing path would.
 */
function mockDirs(filesByDir: Record<string, string[]>): void {
  mockReaddirSync.mockImplementation((p: string) => {
    const files = filesByDir[p];
    if (!files) throw new Error('ENOENT');
    return files;
  });
}

/** Make openSync/readSync/closeSync serve `firstLine` for any file read. */
function mockFirstLine(firstLine: string | null): void {
  mockOpenSync.mockReturnValue(42);
  mockReadSync.mockImplementation((_fd, target: Buffer) => {
    if (firstLine === null) return 0;
    const buf = Buffer.from(firstLine);
    buf.copy(target);
    return buf.length;
  });
  mockCloseSync.mockReturnValue(true);
}

/**
 * Serve a DIFFERENT header line per file (keyed by basename), so a scan that
 * reads several transcripts at once sees each one's real id.
 */
function mockFilesByHeader(lineByBasename: Record<string, string>): void {
  let fdCounter = 100;
  const fdToLine = new Map<number, string>();
  mockOpenSync.mockImplementation((p: string) => {
    const line = lineByBasename[path.basename(p)];
    if (line === undefined) return -1;
    const fd = fdCounter++;
    fdToLine.set(fd, line);
    return fd;
  });
  mockReadSync.mockImplementation((fd: number, target: Buffer) => {
    const line = fdToLine.get(fd);
    if (line === undefined) return 0;
    const buf = Buffer.from(line);
    buf.copy(target);
    return buf.length;
  });
  mockCloseSync.mockReturnValue(true);
}

function header(piId: string, cwd: string): string {
  return JSON.stringify({ type: 'session', version: 3, id: piId, timestamp: 't', cwd });
}

function startWatcher(): fs.FSWatcher & { close: () => void } {
  // Fake native watcher — the fs.watch mock hands it to the implementation.
  // `on` is required: the implementation attaches an 'error' listener to every
  // FSWatcher (EMFILE/ENOSPC on a recursive watch throw out of the emitter),
  // so a fake without `on` crashes the watcher setup.
  const mockWatcher = { close: vi.fn(), on: vi.fn() } as unknown as fs.FSWatcher & { close: () => void };
  mockWatch.mockReturnValue(mockWatcher);
  startPiSessionWatcher();
  return mockWatcher;
}

/** The watch callback wired to a specific dir. */
function watchCallbackFor(dir: string): (...args: unknown[]) => void {
  const call = mockWatch.mock.calls.find((c) => c[0] === dir);
  if (!call) throw new Error(`no fs.watch registered for ${dir}`);
  return call[1] as (...args: unknown[]) => void;
}

function readdirCallsFor(dir: string): number {
  return mockReaddirSync.mock.calls.filter((c) => c[0] === dir).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  stopPiSessionWatcher();
  mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT'); });
  // A live main window is available for the per-tick window lookup
  electronMock.windows = [{ isDestroyed: () => false }];
});

afterEach(() => {
  stopPiSessionWatcher();
  vi.useRealTimers();
});

describe('registerPendingPiSession', () => {
  it('forces a fresh listing of the per-launch session dir', () => {
    mockDirs({ [DIR_UI1]: ['old.jsonl'] });

    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    // The registration snapshot is what excludes pre-existing files.
    expect(mockReaddirSync).toHaveBeenCalledWith(DIR_UI1);
  });

  it('scans the profile launch dir when a configDir is given', () => {
    mockDirs({ [DIR_PRO]: [] });

    registerPendingPiSession('ui-1', '/proj', '/profiles/work', { sessionDir: DIR_PRO });

    expect(mockReaddirSync).toHaveBeenCalledWith(DIR_PRO);
  });

  it('handles a missing launch dir gracefully', () => {
    // Default mock: every readdir throws ENOENT (dir not created yet).
    expect(() =>
      registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 })
    ).not.toThrow();
  });

  it('treats a registration without a sessionDir as a no-op', () => {
    startWatcher();
    registerPendingPiSession('ui-x', '/proj', undefined);
    vi.advanceTimersByTime(4_000);

    expect(mockReaddirSync).not.toHaveBeenCalled();
    expect(mockWatch).not.toHaveBeenCalled();
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });
});

describe('startPiSessionWatcher', () => {
  it('starts fs.watch on the launch dir when a session registers', () => {
    mockDirs({ [DIR_UI1]: [] });
    startWatcher();

    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    expect(mockWatch).toHaveBeenCalledWith(DIR_UI1, expect.any(Function));
  });

  it('watches each distinct launch dir exactly once', () => {
    startWatcher();
    mockDirs({ [DIR_UI1]: [], [DIR_UI2]: [] });

    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    registerPendingPiSession('ui-2', '/proj', undefined, { sessionDir: DIR_UI2 });
    // Re-spawn re-registering the same dir reuses its watcher.
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    expect(mockWatch.mock.calls.filter((c) => c[0] === DIR_UI1)).toHaveLength(1);
    expect(mockWatch.mock.calls.filter((c) => c[0] === DIR_UI2)).toHaveLength(1);
  });

  it('does not start a second polling fallback if already started', () => {
    startWatcher();
    startPiSessionWatcher(); // double start must be idempotent
    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    vi.advanceTimersByTime(2_000);

    // Exactly the registration snapshot + ONE poll tick (a second interval
    // would enumerate the launch dir twice per tick).
    expect(readdirCallsFor(DIR_UI1)).toBe(2);
  });

  it('falls back to polling when fs.watch fails (dir missing)', () => {
    mockWatch.mockImplementation(() => { throw new Error('ENOENT'); });

    expect(() => startPiSessionWatcher()).not.toThrow();

    // Polling still works: a new transcript is discovered on the 2s tick
    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-1', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-1');
  });
});

describe('session ID assignment', () => {
  it('assigns the pi session ID to a pending session on poll', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-session-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    // The transcript appears after registration — in THIS session's dir.
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-abc-123', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-session-1', 'pi-abc-123');
    expect(mockCloseSync).toHaveBeenCalledWith(42);
  });

  it('hands the adopted session to the transcript sync with its launch dir', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-sync', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockRegisterTranscriptSync).toHaveBeenCalledWith(
      'ui-1', 'pi', 'pi-sync', '/proj', undefined, { sessionDir: DIR_UI1 }
    );
  });

  it('assigns on a coalesced fs.watch event without waiting for the poll', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-watch', '/proj'));

    watchCallbackFor(DIR_UI1)('rename');
    // The event path is debounced, not synchronous; it still lands well
    // before the 2s polling fallback.
    vi.advanceTimersByTime(250);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-watch');
  });

  it('does not scan when there are no pending sessions', () => {
    startWatcher();

    vi.advanceTimersByTime(4_000);

    // Nothing is registered — no launch dir is ever listed or read.
    expect(mockReaddirSync).not.toHaveBeenCalled();
    expect(mockOpenSync).not.toHaveBeenCalled();
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('attributes each session to the transcript in its OWN launch dir, whatever the readdir order', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [], [DIR_UI2]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    registerPendingPiSession('ui-2', '/proj', undefined, { sessionDir: DIR_UI2 });

    // Ownership comes from the exclusive dir, not from pairing files to
    // sessions by order — each session only ever sees its own dir.
    mockDirs({ [DIR_UI1]: ['late.jsonl'], [DIR_UI2]: ['early.jsonl'] });
    mockFilesByHeader({
      'late.jsonl': header('pi-late', '/proj'),
      'early.jsonl': header('pi-early', '/proj'),
    });

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-late');
    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-2', 'pi-early');
  });

  it('does not scan when no window is available', () => {
    // The poll looks the window up per tick and skips the scan without one.
    electronMock.windows = [];
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-1', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockOpenSync).not.toHaveBeenCalled();
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('skips files that already existed at registration (knownFiles)', () => {
    startWatcher();

    // old.jsonl exists when the session registers — it must never be assigned
    mockDirs({ [DIR_UI1]: ['old.jsonl'] });
    mockFilesByHeader({ 'old.jsonl': header('pi-old', '/proj') });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    // Only the pre-existing file is present — nothing new to assign
    vi.advanceTimersByTime(2000);
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();

    // A genuinely new file appears — it is the only candidate
    mockDirs({ [DIR_UI1]: ['old.jsonl', 'new.jsonl'] });
    mockFilesByHeader({ 'new.jsonl': header('pi-new', '/proj') });
    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-new');
    expect(mockWriteCliSessionId).not.toHaveBeenCalledWith('ui-1', 'pi-old');
  });

  it('never adopts a file written outside the launch dir', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [], [DIR_EXT]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    // An external CLI run (same project) writes to the default tree —
    // ownership follows the exclusive dir, so this is never adopted.
    mockDirs({ [DIR_UI1]: [], [DIR_EXT]: ['new.jsonl'] });
    mockFirstLine(header('pi-external', '/proj'));

    vi.advanceTimersByTime(4_000);

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('skips non-session and malformed first lines', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['a.jsonl', 'b.jsonl'] });

    mockFirstLine(JSON.stringify({ type: 'message', id: 'pi-x', cwd: '/proj' }));
    vi.advanceTimersByTime(2000);
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();

    mockFirstLine('{not valid json');
    vi.advanceTimersByTime(2000);
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('skips unreadable files without throwing', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['gone.jsonl'] });
    mockOpenSync.mockImplementation(() => { throw new Error('ENOENT'); });

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('does not assign the same pi session ID twice', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [], [DIR_UI2]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'], [DIR_UI2]: [] });
    mockFirstLine(header('pi-dup', '/proj'));

    vi.advanceTimersByTime(2000);
    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);

    // A second session whose dir gains a file with the SAME id: the id is
    // already assigned, so it is never handed out again.
    registerPendingPiSession('ui-2', '/proj', undefined, { sessionDir: DIR_UI2 });
    mockDirs({ [DIR_UI1]: ['new.jsonl'], [DIR_UI2]: ['dup.jsonl'] });
    vi.advanceTimersByTime(2000);
    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);
  });

  it('adopts the exact file named by a known CLI id when the dir holds several', () => {
    startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    // Pi fresh launches pass a Vibeyard-generated id via --session-id.
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1, knownCliId: 'pi-first' });
    mockDirs({ [DIR_UI1]: ['other.jsonl', 'right.jsonl'] });
    mockFilesByHeader({
      'other.jsonl': header('pi-other', '/proj'),
      'right.jsonl': header('pi-first', '/proj'),
    });

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-first');
    expect(mockWriteCliSessionId).not.toHaveBeenCalledWith('ui-1', 'pi-other');
  });

  it('adopts a profiled launch from its profile launch dir', () => {
    startWatcher();

    mockDirs({ [DIR_PRO]: [] });
    registerPendingPiSession('ui-1', '/proj', '/profiles/work', { sessionDir: DIR_PRO });
    mockDirs({ [DIR_PRO]: ['new.jsonl'] });
    mockFirstLine(header('pi-profile', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'pi-profile');
  });
});

describe('unregisterPiSession', () => {
  it('removes a pending session so it is no longer assignable', () => {
    const mockWatcher = startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-gone', '/proj', undefined, { sessionDir: DIR_UI1 });
    unregisterPiSession('ui-gone');
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-orphan', '/proj'));

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
    // The unwatched dir's native watcher is released with its last session.
    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('is a no-op for unknown session ids', () => {
    expect(() => unregisterPiSession('never-registered')).not.toThrow();
  });
});

describe('stopPiSessionWatcher', () => {
  it('closes the watchers and clears pending state', () => {
    const mockWatcher = startWatcher();

    mockDirs({ [DIR_UI1]: [] });
    registerPendingPiSession('ui-1', '/proj', undefined, { sessionDir: DIR_UI1 });

    stopPiSessionWatcher();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('stops the polling fallback after stopping', () => {
    startWatcher();
    stopPiSessionWatcher();

    // A late registration must not be picked up — the interval is gone
    mockDirs({ [DIR_UI1]: ['new.jsonl'] });
    mockFirstLine(header('pi-late', '/proj'));
    registerPendingPiSession('ui-late', '/proj', undefined, { sessionDir: DIR_UI1 });

    vi.advanceTimersByTime(2000);

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });
});
