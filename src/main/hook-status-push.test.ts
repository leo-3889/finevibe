/**
 * Row 18: the STATUS_DIR lane is push-first.
 *
 * The mirror of `hook-status.test.ts`: that file mocks `fs` and proves the
 * status MAPPING; this one runs the REAL filesystem in a temp dir (fake timers
 * and a fake chokidar, so "the watch delivered this" is provable without
 * waiting on inotify) and proves the LANE:
 *
 *   - a write is forwarded inside the coalescing window, i.e. WITHOUT advancing
 *     to the next safety-net tick — only the push path can have delivered it;
 *   - the safety-net sweep still catches a write the watcher never reported;
 *   - quit tears the lane down: nothing flushes afterwards.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as path from 'path';
import { isWin } from './platform';

// Real temp root the suite writes into; os.tmpdir() is repointed BEFORE
// hook-status evaluates, so its module-level STATUS_DIR lands inside it.
const TMP_ROOT = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return nodeFs.mkdtempSync(`${base}/fv-push-${process.pid}-`);
});

vi.mock('os', () => ({ tmpdir: () => TMP_ROOT, homedir: () => '/home/test' }));
vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('./hosts/provider-fs', () => ({ readProviderFileWindow: vi.fn() }));

const chokidarFake = vi.hoisted(() => {
  const state = {
    addCalls: [] as string[],
    closeCalls: 0,
    all: null as null | ((event: string, changedPath: string) => void),
    error: null as null | ((err: unknown) => void),
  };
  class FakeFSWatcher {
    on(event: string, handler: (...args: never[]) => void): this {
      if (event === 'all') state.all = handler as (event: string, p: string) => void;
      if (event === 'error') state.error = handler as (err: unknown) => void;
      return this;
    }
    add(dir: string): this { state.addCalls.push(dir); return this; }
    close(): Promise<void> { state.closeCalls++; return Promise.resolve(); }
  }
  return { state, FakeFSWatcher };
});
vi.mock('chokidar', () => ({ FSWatcher: chokidarFake.FakeFSWatcher }));

import * as fs from 'fs';
import {
  PUSH_DEBOUNCE_MS,
  SAFETY_NET_POLL_MS,
  WATCHER_DOWN_POLL_MS,
  STATUS_DIR,
  startWatching,
  registerSession,
  cleanupAll,
} from './hook-status';

const chokidarState = chokidarFake.state;
const statusFile = (name: string): string => path.join(STATUS_DIR, name);
const sid = 'push-sess-1';

const sent: Array<[string, unknown[]]> = [];
const win = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, ...args: unknown[]) => { sent.push([channel, args]); } },
} as never;

function write(name: string, content: string): void {
  fs.writeFileSync(statusFile(name), content);
}

/** Emit one watch event the way chokidar does: a full path. */
function emit(name: string): void {
  chokidarState.all?.('change', statusFile(name));
}

/** Run the coalescing window to its end — and nothing else. */
function flushPushWindow(): void {
  vi.advanceTimersByTime(PUSH_DEBOUNCE_MS);
}

/**
 * Run the safety-net sweep. It is async (`fs.promises` readdir, then the
 * bounded stat batch), so a delivery lands several microtasks after the tick —
 * hence the trailing 0 ms pumps. The push lane is fully synchronous, so
 * `flushPushWindow` needs no pump at all: that asymmetry is the proof the push
 * tests are built on.
 */
async function runSweep(ms: number): Promise<void> {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(i === 0 ? ms : 0);
}

function sendsFor(channel: string): unknown[][] {
  return sent.filter(([c]) => c === channel).map(([, args]) => args);
}

beforeEach(() => {
  // Timers are fake (the coalescing window and the sweeps must be
  // deterministic); the microtask/nextTick queues are deliberately NOT faked,
  // because the safety-net sweep reads the real filesystem through
  // `fs.promises` and those callbacks have to reach the event loop.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  sent.length = 0;
  chokidarState.addCalls = [];
  chokidarState.closeCalls = 0;
  chokidarState.all = null;
  chokidarState.error = null;
  cleanupAll();
  fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  cleanupAll();
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('hook-status push lane (row 18)', () => {
  it('pins the documented cadences: 150 ms window, 30 s safety net, 2 s watcher-down', () => {
    // HOOKS.md "Delivery timing (contract)" states these numbers; the
    // arithmetic (push window << safety net << the renderer's 10 min
    // STOP_FALLBACK_MS backstop) only holds at these values.
    expect(PUSH_DEBOUNCE_MS).toBe(150);
    expect(SAFETY_NET_POLL_MS).toBe(30_000);
    expect(WATCHER_DOWN_POLL_MS).toBe(2_000);
  });

  it('watches STATUS_DIR through chokidar', () => {
    startWatching(win);
    registerSession(sid);

    expect(chokidarState.addCalls).toContain(STATUS_DIR);
  });

  it('forwards a write inside the coalescing window — no safety-net tick elapsed', () => {
    startWatching(win);
    registerSession(sid);

    write(`${sid}.status`, 'PostToolUse:working');
    emit(`${sid}.status`);
    flushPushWindow();

    // The whole test advanced PUSH_DEBOUNCE_MS; the sweep first runs at 30 s,
    // so this delivery can only have come from the push lane.
    expect(sendsFor('session:hookStatus')).toEqual([[sid, 'working', 'PostToolUse']]);
  });

  it('coalesces a burst on one file into a single delivery of the final content', () => {
    startWatching(win);
    registerSession(sid);

    write(`${sid}.status`, 'PostToolUse:working');
    emit(`${sid}.status`);
    vi.advanceTimersByTime(40); // same window: the tmp+mv / truncate+write pair
    write(`${sid}.status`, 'Stop:completed');
    emit(`${sid}.status`);
    flushPushWindow();

    expect(sendsFor('session:hookStatus')).toEqual([[sid, 'completed', 'Stop']]);
  });

  it('ignores the atomic-write temp name (.status.tmp) entirely', () => {
    startWatching(win);
    registerSession(sid);

    write(`${sid}.status.tmp`, 'Stop:completed');
    emit(`${sid}.status.tmp`);
    flushPushWindow();

    expect(sent).toEqual([]);
  });

  it('keeps the .subagents suppression on the push lane (real bytes, never forwarded)', () => {
    startWatching(win);
    registerSession(sid);

    write(`${sid}.subagents`, JSON.stringify({ n: 2, t: Date.now() }));
    emit(`${sid}.subagents`);
    flushPushWindow();

    expect(sent).toEqual([]);
  });

  it('delivers a .toolfailure once and unlinks it for real', () => {
    startWatching(win);
    registerSession(sid);

    const name = `${sid}-abc123.toolfailure`;
    write(name, JSON.stringify({ tool_name: 'Bash', tool_input: {}, error: 'exit 127' }));
    emit(name);
    flushPushWindow();

    expect(sendsFor('session:toolFailure')).toEqual([[sid, { tool_name: 'Bash', tool_input: {}, error: 'exit 127' }]]);
    expect(fs.existsSync(statusFile(name))).toBe(false);
  });

  it('reads an append-only .events burst in one pass with no lost records', () => {
    startWatching(win);
    registerSession(sid);

    const name = `${sid}.events`;
    write(name, `${JSON.stringify({ type: 'pre_tool_use', tool: 'Bash' })}\n`);
    emit(name);
    vi.advanceTimersByTime(30);
    fs.appendFileSync(statusFile(name), `${JSON.stringify({ type: 'post_tool_use', tool: 'Bash' })}\n`);
    emit(name);
    flushPushWindow();

    const events = sendsFor('session:inspectorEvents').flatMap(([, list]) => list as unknown[]);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['pre_tool_use', 'post_tool_use']);
  });

  it('safety net: a write the watcher never reported is delivered on the sweep', async () => {
    startWatching(win);
    registerSession(sid);

    // Synthetic dropped event: the bytes land, no watch event is emitted.
    write(`${sid}.status`, 'Stop:completed');
    flushPushWindow();
    expect(sent).toEqual([]);

    await runSweep(SAFETY_NET_POLL_MS);
    expect(sendsFor('session:hookStatus')).toEqual([[sid, 'completed', 'Stop']]);
  });

  it('teardown on quit: watcher closed, queued push dropped, nothing fires later', async () => {
    startWatching(win);
    registerSession(sid);

    write(`${sid}.status`, 'PostToolUse:working');
    emit(`${sid}.status`); // queued, window not elapsed
    cleanupAll();

    expect(chokidarState.closeCalls).toBeGreaterThan(0);

    await runSweep(SAFETY_NET_POLL_MS * 2);
    expect(sent).toEqual([]);
  });

  it('a dead watcher falls back to the fast sweep and re-arms (PA-09)', async () => {
    startWatching(win);
    registerSession(sid);

    chokidarState.error?.(new Error('EMFILE: too many open files'));
    write(`${sid}.status`, 'Stop:completed');

    // No push lane: the 150 ms window delivers nothing…
    flushPushWindow();
    expect(sent).toEqual([]);
    // …the 2 s sweep does, and the watch is re-armed five seconds later.
    await runSweep(WATCHER_DOWN_POLL_MS);
    expect(sendsFor('session:hookStatus')).toEqual([[sid, 'completed', 'Stop']]);

    await runSweep(5_000);
    expect(chokidarState.all).not.toBeNull();
  });

  it('ignores writes for sessions that are not registered', () => {
    startWatching(win);

    write(`${sid}.status`, 'PostToolUse:working');
    emit(`${sid}.status`);
    flushPushWindow();

    expect(sent).toEqual([]);
  });
});

describe('getStatusDir on the repointed tmpdir', () => {
  it('keeps the uid suffix inside the suite tmp root', () => {
    const uid = !isWin && typeof process.getuid === 'function' ? process.getuid() : undefined;
    expect(STATUS_DIR).toBe(path.join(TMP_ROOT, uid === undefined ? 'finevibe' : `finevibe-${uid}`));
  });
});
