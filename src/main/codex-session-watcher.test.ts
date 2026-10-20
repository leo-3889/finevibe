import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as zlib from 'zlib';
import type { BrowserWindow } from 'electron';

const SESSIONS_ROOT = path.join(path.sep + 'mock', 'home', '.codex', 'sessions');

// The cost claims (one meta parse per file per change, not per scan) are
// counted inside the fs mock: `zlib`'s ESM namespace cannot be spied.
const counters = vi.hoisted(() => ({ readFileSync: 0, openSync: 0 }));

// Virtual filesystem: 'set(vfs, dirPath, entries)' style helpers below.
// values: string = file content; object with mtimeMs = file with mtime.
type VfsFile = { content: string; mtimeMs: number };
type VfsDir = { mtimeMs: number; entries: Map<string, VfsFile | 'dir'> };
let vfs: Map<string, VfsDir>;

const NOW = 1_800_000_000_000; // fixed clock base

vi.mock('fs', () => ({
  statSync: (p: string) => {
    const dirs = vfs;
    const parent = dirs.get(path.dirname(p));
    const base = path.basename(p);
    if (parent && parent.entries.has(base)) {
      const v = parent.entries.get(base);
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (v === 'dir') {
        const d = dirs.get(p)!;
        return { mtimeMs: d.mtimeMs, size: 0, isDirectory: () => true };
      }
      return { mtimeMs: v.mtimeMs, size: v.content.length, isDirectory: () => false };
    }
    if (dirs.has(p)) return { mtimeMs: dirs.get(p)!.mtimeMs, size: 0, isDirectory: () => true };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
  readdirSync: (p: string) => {
    if (!vfs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return [...vfs.get(p)!.entries.keys()];
  },
  readFileSync: (p: string) => {
    counters.readFileSync++;
    const parent = vfs.get(path.dirname(p));
    const v = parent?.entries.get(path.basename(p));
    if (!v || v === 'dir') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // latin1: compressed .zst content is stored as a byte-per-char string.
    return Buffer.from(v.content, 'latin1');
  },
  openSync: (p: string) => { counters.openSync++; return p; },
  readSync: (_fd: string, buf: Buffer, _o: number, len: number, _pos: number) => {
    const parent = vfs.get(path.dirname(_fd));
    const base = path.basename(_fd);
    const v = parent?.entries.get(base);
    if (!v || v === 'dir') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // latin1 for .zst (compressed bytes stored byte-per-char), utf-8 for
    // plain rollouts: the meta path now reads a bounded prefix through
    // openSync/readSync, never a whole readFileSync.
    const bytes = Buffer.from(v.content, base.endsWith('.zst') ? 'latin1' : 'utf-8').subarray(0, len);
    bytes.copy(buf, 0);
    return bytes.length;
  },
  closeSync: () => {},
  mkdirSync: () => {},
  watch: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('os', () => ({ homedir: () => path.join(path.sep + 'mock', 'home') }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false }] },
}));
vi.mock('./hook-status', () => ({
  STATUS_DIR: path.join(path.sep + 'tmp', 'vibeyard'),
  writeCliSessionId: vi.fn(),
}));

import * as fs from 'fs';
import { writeCliSessionId } from './hook-status';
import {
  registerPendingCodexSession,
  unregisterCodexSession,
  startCodexSessionWatcher,
  stopCodexSessionWatcher,
} from './codex-session-watcher';

const mockWriteCliSessionId = vi.mocked(writeCliSessionId);
const mockWatch = vi.mocked(fs.watch);

// Structural stub: the watcher never touches the window (it writes .sessionid files).
const fakeWin = {} as unknown as BrowserWindow;

function mkDay(date: Date): string {
  // Local-time components: Codex names the tree from local time and the
  // watcher prunes it by local date, so a UTC-named fixture would be pruned
  // outright on machines east of UTC.
  const y = date.getFullYear().toString();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dayPath = path.join(SESSIONS_ROOT, y, m, d);
  for (const p of [path.join(SESSIONS_ROOT, y, m), dayPath]) {
    if (!vfs.has(p)) vfs.set(p, { mtimeMs: NOW, entries: new Map() });
  }
  const ym = path.join(SESSIONS_ROOT, y);
  if (!vfs.has(ym)) {
    vfs.set(ym, { mtimeMs: NOW, entries: new Map([[m, 'dir']]) });
    const root = vfs.get(SESSIONS_ROOT)!;
    if (!root.entries.has(y)) root.entries.set(y, 'dir');
  }
  vfs.get(path.join(SESSIONS_ROOT, y, m))!.entries.set(d, 'dir');
  return dayPath;
}

function addRollout(
  dayPath: string,
  id: string,
  opts: { cwd?: string | null; mtimeMs?: number; zst?: boolean; raw?: string } = {},
): string {
  const name = `rollout-2026-10-19T00-00-00-${id}.jsonl${opts.zst ? '.zst' : ''}`;
  const meta = opts.raw !== undefined
    ? opts.raw
    : opts.cwd === null
      ? 'not-json'
      : JSON.stringify({ type: 'session_meta', payload: { id, cwd: opts.cwd } });
  const content = opts.zst
    ? zlib.zstdCompressSync(Buffer.from(meta + '\n', 'utf-8')).toString('latin1')
    : meta + '\n';
  vfs.get(dayPath)!.entries.set(name, { content, mtimeMs: opts.mtimeMs ?? NOW });
  vfs.get(dayPath)!.mtimeMs = opts.mtimeMs ?? NOW;
  return path.join(dayPath, name);
}

function scanAll(): void {
  // Trigger the debounced scan path deterministically.
  vi.advanceTimersByTime(2100);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  counters.readFileSync = 0;
  counters.openSync = 0;
  vi.clearAllMocks();
  stopCodexSessionWatcher();
  vfs = new Map();
  vfs.set(SESSIONS_ROOT, { mtimeMs: NOW, entries: new Map() });
});

afterEach(() => {
  stopCodexSessionWatcher();
  vi.useRealTimers();
});

describe('codex rollout attribution (per-cwd FIFO)', () => {
  it('assigns a rollout whose session_meta cwd matches a pending tab', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: '/repo/alpha' });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'codex-1');
  });

  it('skips a rollout from a foreign cwd (external codex run)', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'external-1', { cwd: '/other/project' });

    scanAll();

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('lands a matching rollout on the right tab, not the oldest tab (hijack regression)', () => {
    // The global FIFO used to hand every new id to the oldest pending tab:
    // the beta rollout landed on alpha's tab.
    registerPendingCodexSession('ui-alpha', '/repo/alpha');
    registerPendingCodexSession('ui-beta', '/repo/beta');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-beta', { cwd: '/repo/beta' });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);
    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-beta', 'codex-beta');
  });

  it('assigns same-cwd rollouts oldest-pending-first', () => {
    registerPendingCodexSession('ui-old', '/repo/alpha');
    registerPendingCodexSession('ui-new', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: '/repo/alpha' });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);
    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-old', 'codex-1');
  });

  it('assigns an unreadable-meta rollout only with exactly one pending tab', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-x', { raw: '{"type":"session_meta"}' }); // no cwd in meta

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'codex-x');
  });

  it('stays hands-off on unreadable meta with multiple pending tabs', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    registerPendingCodexSession('ui-2', '/repo/beta');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-x', { raw: '{"type":"session_meta"}' });

    scanAll();

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('reads session_meta from compressed .jsonl.zst rollouts', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-z', { cwd: '/repo/alpha', zst: true });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'codex-z');
  });

  it('ignores rollouts older than every pending registration', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    // Outside the clock-skew window: a run that predates the tab.
    addRollout(day, 'codex-old', { cwd: '/repo/alpha', mtimeMs: NOW - 10 * 60_000 });

    scanAll();

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('stops assigning once unregistered', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    unregisterCodexSession('ui-1');
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: '/repo/alpha' });

    scanAll();

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('assigns each codex id at most once across scans', () => {
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: '/repo/alpha' });

    scanAll();
    registerPendingCodexSession('ui-2', '/repo/alpha');
    scanAll(); // same rollout, already-assigned id must not be handed out again

    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);
  });

  it('normalizes cwd for comparison (trailing sep + Windows case)', () => {
    // normCwd resolves paths against the process cwd; use absolute POSIX-style
    // paths so resolve() is identity on the test platform.
    registerPendingCodexSession('ui-1', path.resolve('/repo/alpha') + path.sep);
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: path.resolve('/repo/alpha') });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledWith('ui-1', 'codex-1');
  });

  it('keeps the tab pending when the id write fails, and retries it next scan', () => {
    // The write runs inside the poll interval and the watch-debounce timer and
    // src/main has no uncaughtException handler: an EMFILE/ENOSPC/EACCES that
    // escaped here killed the main process and every live PTY with it.
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-1', { cwd: '/repo/alpha' });
    mockWriteCliSessionId.mockImplementationOnce(() => {
      throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' });
    });

    expect(() => scanAll()).not.toThrow();
    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(1);

    // Nothing was claimed, so the next scan retries the same tab/rollout pair.
    scanAll();
    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(2);
    expect(mockWriteCliSessionId).toHaveBeenLastCalledWith('ui-1', 'codex-1');
  });

  it('pairs the oldest pending tab with the oldest same-cwd rollout', () => {
    // Two Codex tabs in one repo, both rollouts created inside one scan
    // window. Files are visited oldest-first so the FIFO the docstring
    // promises actually holds; descending order swapped the transcripts.
    registerPendingCodexSession('ui-old', '/repo/alpha');
    registerPendingCodexSession('ui-new', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    // Codex names files `rollout-<ts>-<id>`, so name order == creation order.
    addRollout(day, 'aaa-first', { cwd: '/repo/alpha' });
    addRollout(day, 'zzz-second', { cwd: '/repo/alpha' });

    scanAll();

    expect(mockWriteCliSessionId).toHaveBeenCalledTimes(2);
    expect(mockWriteCliSessionId).toHaveBeenNthCalledWith(1, 'ui-old', 'aaa-first');
    expect(mockWriteCliSessionId).toHaveBeenNthCalledWith(2, 'ui-new', 'zzz-second');
  });

  it('prunes day directories older than the oldest registration by name', () => {
    // A stale day directory whose mtimes look brand new (a restore, a tool
    // touching it, a clock change): the mtime gate alone would re-enter it and
    // hand its rollout to a tab that never ran it. The date-name gate skips it.
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const staleDay = mkDay(new Date(NOW - 40 * 24 * 3600 * 1000));
    addRollout(staleDay, 'codex-stale', { cwd: '/repo/alpha', mtimeMs: NOW });
    vfs.get(staleDay)!.mtimeMs = NOW;

    scanAll();

    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });

  it('parses a rollout meta once per change, not once per scan', () => {
    // An unmatched (foreign-cwd) rollout is revisited every scan for the whole
    // life of a pending tab. Without the meta cache each scan re-read it - and
    // for `.jsonl.zst` decompressed it whole, allocating ~10x the compressed
    // size (P1-3) - up to twice a second. The meta read is now a bounded
    // prefix through openSync/readSync, cached by (path, mtime, size).
    registerPendingCodexSession('ui-1', '/repo/alpha');
    startCodexSessionWatcher(fakeWin);
    const day = mkDay(new Date(NOW));
    addRollout(day, 'codex-foreign', { cwd: '/other/project', zst: true });

    scanAll();
    // One bounded prefix read per file version; the whole file is never
    // readFileSync'ed for meta again (P1-3).
    expect(counters.openSync).toBe(1);
    expect(counters.readFileSync).toBe(0);

    scanAll();
    scanAll();
    // Two more scans, zero extra reads: the parsed meta is cached by
    // (path, mtime, size), so the decompression cost is paid once per change.
    expect(counters.openSync).toBe(1);
    expect(counters.readFileSync).toBe(0);
    expect(mockWriteCliSessionId).not.toHaveBeenCalled();
  });
});
describe('startCodexSessionWatcher()', () => {
  it('watches the sessions dir recursively and polls as fallback', () => {
    startCodexSessionWatcher(fakeWin);
    expect(mockWatch).toHaveBeenCalledWith(SESSIONS_ROOT, { recursive: true }, expect.any(Function));
    startCodexSessionWatcher(fakeWin);
    expect(mockWatch).toHaveBeenCalledTimes(1);
  });
});

// P1-11: fs.watch with no 'error' listener. A real FSWatcher emits 'error'
// (EMFILE, watched dir removed), and an EventEmitter with no 'error'
// listener THROWS from emit() — that is the uncaught main-process
// exception that takes down every live PTY. The fake watcher returned by
// the fs.watch mock is a REAL EventEmitter and the module wires its
// handler onto this exact object, so the emit has real Node semantics.
describe('watcher error resilience (P1-11)', () => {
  it('survives an FSWatcher error: logs once, releases the watcher, keeps polling', () => {
    const created: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = [];
    mockWatch.mockImplementation(() => {
      const w = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
      w.close = vi.fn();
      created.push(w);
      return w as unknown as fs.FSWatcher;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      startCodexSessionWatcher(fakeWin);
      const w = created[0];
      expect(w).toBeDefined();

      // Pre-fix: no 'error' listener is attached, so the first emit throws.
      expect(() => w.emit('error', new Error('EMFILE: too many open files'))).not.toThrow();
      expect(() => w.emit('error', new Error('EMFILE again'))).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1); // logged once per watcher
      expect(w.close).toHaveBeenCalled(); // watcher released
      expect(w.listenerCount('error')).toBe(1);

      // The released slot is re-watchable: stop + start creates a fresh watcher.
      stopCodexSessionWatcher();
      startCodexSessionWatcher(fakeWin);
      expect(created.length).toBe(2);
    } finally {
      warn.mockRestore();
      mockWatch.mockReset(); // restores the vi.fn(() => ({ close: vi.fn() })) factory
    }
  });
});
