import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { isWin } from './platform';

// Mirrors getStatusDir(): on POSIX the module suffixes the uid (shared
// world-writable /tmp); Windows keeps the bare name under per-user %TEMP%.
const STATUS_DIR = path.join('/tmp', !isWin && process.getuid ? `finevibe-${process.getuid()}` : 'finevibe');
const SCRIPT_DIR = path.join('/home/test', '.finevibe', 'run');
const STATUSLINE_SCRIPT = path.join(SCRIPT_DIR, isWin ? 'statusline.cmd' : 'statusline.sh');

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  rmSync: vi.fn(),
  watch: vi.fn(),
  promises: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock('os', () => ({
  tmpdir: () => '/tmp',
  homedir: () => '/home/test',
}));

vi.mock('electron', () => ({
  BrowserWindow: {},
}));

// The sftp seam the remote sidecar poll reads through.
vi.mock('./hosts/provider-fs', () => ({
  readProviderFileWindow: vi.fn(),
}));

import * as fs from 'fs';
import { readProviderFileWindow } from './hosts/provider-fs';
import {
  buildStatusLinePython,
  installStatusLineScript,
  startWatching,
  resyncAllSessions,
  restartAndResync,
  cleanupSessionStatus,
  cleanupAll,
  registerSession,
  registerRemoteStatus,
} from './hook-status';

let watchCallback: ((eventType: string, filename: string | null) => void) | null = null;
const mockClose = vi.fn();

// The 'error' handler the module registers on the fs.watch object; a test
// fires it to simulate the watcher dying (the PA-09 cadence switch).
let watchErrorHandler: ((err: unknown) => void) | null = null;
function killWatcher(): void {
  const handler = watchErrorHandler;
  watchErrorHandler = null;
  handler?.(new Error('EMFILE: too many open files'));
}

/** fs.watch stand-in: captures the change callback and the 'error' handler. */
function watchImpl(_path: unknown, cb: (t: string, f: string | null) => void): fs.FSWatcher {
  watchCallback = cb;
  return {
    close: mockClose,
    on: (event: string, handler: (err: unknown) => void) => {
      if (event === 'error') watchErrorHandler = handler;
    },
  } as unknown as fs.FSWatcher;
}

const mockSend = vi.fn();
function createMockWin(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: mockSend } } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.mkdirSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.writeFileSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.readFileSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.statSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
  vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT') as any);
  vi.mocked(fs.unlinkSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.rmdirSync).mockImplementation(vi.fn() as any);
  vi.mocked(fs.watch).mockImplementation(watchImpl as any);

  watchCallback = null;
  watchErrorHandler = null;
  mockClose.mockClear();
  mockSend.mockClear();

  // Reset module-level watcher state
  cleanupAll();

  // Clear call counts after cleanup
  vi.clearAllMocks();
  watchCallback = null;
  watchErrorHandler = null;

  vi.mocked(fs.watch).mockImplementation(watchImpl as any);
});

afterEach(() => {
  // Stop any polling intervals before restoring timers
  cleanupAll();
  vi.useRealTimers();
});

describe('hook-status', () => {
  describe('buildStatusLinePython', () => {
    // Tested directly rather than through installStatusLineScript so the body
    // used by the Windows branch is exercised on every platform's CI run.
    const body = () => buildStatusLinePython(STATUS_DIR);

    // Feeds the script to python3 on stdin. PYTHONIOENCODING is required:
    // Node writes `input` as UTF-8, but on Windows sys.stdin defaults to the
    // locale codepage, so a non-ascii path comes back mojibake'd (\u00fc ->
    // \u00c3\u00bc). Production is unaffected — the body is written to a .py file,
    // and Python reads source files as UTF-8 regardless of locale.
    const runPython = (code: string, input: string) => {
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const opts = { input, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };
      return spawnSync('python3', ['-c', code], opts);
    };
    // Memoised: three tests probe for python3, and each probe is a process launch.
    let pythonAvailable: boolean | undefined;
    const hasPython = () => {
      if (pythonAvailable === undefined) {
        const { spawnSync } = require('child_process') as typeof import('child_process');
        pythonAvailable = !spawnSync('python3', ['-c', 'pass']).error;
      }
      return pythonAvailable;
    };

    it('extracts cost, context_window, session_id and session_name', () => {
      const script = body();
      for (const field of ['cost', 'context_window', 'session_id', 'session_name']) {
        expect(script).toContain(field);
      }
    });

    it('reconfigures stdin to UTF-8 before the first json.load(sys.stdin)', () => {
      // Windows: Python <3.15 decodes sys.stdin with the ANSI code page, so
      // a non-ASCII payload raises UnicodeDecodeError inside the try/except
      // and the script exits at line ~5 — cost, context, title and session
      // id all die silently (see STDIN_UTF8_GUARD in shared/python.ts).
      const script = body();
      const guard = script.indexOf('sys.stdin.reconfigure(encoding="utf-8")');
      const read = script.indexOf('json.load(sys.stdin)');
      expect(guard, 'no UTF-8 guard in the statusline body').not.toBe(-1);
      expect(guard).toBeLessThan(read);
      expect(script.startsWith('import sys'), 'guard precedes the sys import').toBe(true);
    });

    it('builds every path with os.path.join off the status_dir literal', () => {
      const script = body();
      expect(script).toContain(`status_dir=${JSON.stringify(STATUS_DIR)}`);
      for (const ext of ['.cost', '.sessionid', '.name']) {
        expect(script).toContain(`sid+'${ext}'`);
      }
      expect(script).not.toContain('status_dir+');
    });

    it.each([
      ['posix', '/tmp/finevibe'],
      ['windows backslashes', 'C:\\Users\\dev\\Temp\\finevibe'],
      ['apostrophe in path', "C:\\Users\\O'Brien\\Temp\\finevibe"],
      ['double quote in path', '/tmp/we"ird/finevibe'],
      ['trailing separator', '/tmp/finevibe/'],
      ['non-ascii', '/tmp/\u00fcn\u00efcode/finevibe'],
    ])('embeds a %s status dir as a valid Python literal', (_label, dir) => {
      // A SyntaxError here is silent in production and kills cost, context,
      // sessionid and name at once. A raw literal breaks on an apostrophe.
      const script = buildStatusLinePython(dir);
      const literal = script.split('\n').find((l) => l.startsWith('status_dir='))!;
      expect(literal).toBe(`status_dir=${JSON.stringify(dir)}`);

      if (!hasPython()) return; // no python3 here

      const result = runPython(
        `import sys,json;ns={};exec(sys.stdin.read(),ns);print(json.dumps(ns["status_dir"]))`,
        literal,
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toBe(dir);
    });

    it('writes the name as ASCII-safe JSON', () => {
      // json.dumps defaults to ensure_ascii=True, so a CJK/emoji title never
      // hits Windows' locale codepage and raises UnicodeEncodeError — which
      // would abort the script and take the .cost write down with it. The
      // proxy is "no open() carries an encoding kwarg"; the UTF-8 stdin
      // guard's reconfigure(encoding="utf-8") is a deliberate, scoped
      // exception — it decodes INPUT, it never re-encodes these writes.
      expect(body()).toContain('json.dumps(');
      expect(body()).not.toMatch(/open\([^)]*encoding/);
    });

    it('writes .sessionid only when the id changed', () => {
      // The statusLine fires on every render. An unconditional write reaches the
      // renderer as an IPC that ends in a persist plus a full renderLayout(),
      // which used to re-append the terminal pane many times a second — blurring
      // the in-pane find bar and collapsing an in-progress selection.
      if (!hasPython()) return; // no python3 on this runner

      // Real fs, deliberately: `fs` is mocked in this suite, so the script's own
      // writes are observed from inside Python instead.
      const tmp = path.join(
        process.env.TMPDIR || process.env.TEMP || '/tmp',
        `finevibe-statusline-${process.pid}`,
      );
      const driver = `
import sys,os,io,json,builtins,shutil
src=sys.stdin.read()
d=${JSON.stringify(tmp)}
shutil.rmtree(d,ignore_errors=True)
os.makedirs(d)
writes=[]
real=builtins.open
def spy(file,mode='r',*a,**k):
    if str(file).endswith('.sessionid') and 'w' in mode:
        writes.append(str(file))
    return real(file,mode,*a,**k)
builtins.open=spy
os.environ['CLAUDE_IDE_SESSION_ID']='sess1'
def run(payload):
    sys.stdin=io.StringIO(payload)
    try:
        exec(compile(src,'statusline','exec'),{})
    except SystemExit:
        pass
run('{"session_id":"cli-a"}')
run('{"session_id":"cli-a"}')
after_repeat=len(writes)
run('{"session_id":"cli-b"}')
final=real(os.path.join(d,'sess1.sessionid')).read()
shutil.rmtree(d,ignore_errors=True)
sys.stdout.write(json.dumps({'afterRepeat':after_repeat,'total':len(writes),'final':final}))
`;
      // Built against the temp dir so the script's .cost/.name writes land there too.
      const result = runPython(driver, buildStatusLinePython(tmp));
      expect(result.status).toBe(0);

      const seen = JSON.parse(result.stdout.toString());
      expect(seen.afterRepeat).toBe(1); // the repeat wrote nothing
      expect(seen.total).toBe(2);       // the changed id did
      expect(seen.final).toBe('cli-b');
    });

    it('is syntactically valid Python', () => {
      // A syntax error here is silent in production: it kills cost, context,
      // sessionid and name at once, with the traceback going only to
      // statusline.log. Nothing else in this suite would catch it.
      if (!hasPython()) return; // no python3 on this runner

      const result = runPython('import sys;compile(sys.stdin.read(),"statusline","exec")', body());

      expect(result.stderr.toString()).toBe('');
      expect(result.status).toBe(0);
    });
  });

  describe('installStatusLineScript', () => {
    it('creates dir and writes script with mode 0o755', () => {
      installStatusLineScript();

      expect(fs.mkdirSync).toHaveBeenCalledWith(STATUS_DIR, { recursive: true, mode: 0o700 });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        STATUSLINE_SCRIPT,
        isWin ? expect.stringContaining('@echo off') : expect.stringContaining('#!/bin/sh'),
        { mode: 0o755 },
      );
    });

    it('installs the Python body as a file and invokes it by path', () => {
      // Never inlined into the shell command — see the module docstring in
      // hook-commands.ts for why inlining Python here is fragile.
      installStatusLineScript();

      const pyPath = path.join(SCRIPT_DIR, 'statusline.py');
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        pyPath,
        expect.stringContaining('session_name'),
        { mode: 0o755 },
      );

      const wrapper = vi.mocked(fs.writeFileSync).mock.calls
        .find(([target]) => target === STATUSLINE_SCRIPT)![1] as string;
      expect(wrapper).toContain(`"${pyPath}"`);
      expect(wrapper).not.toContain('-c');
    });

    it('invokes python with -X utf8 on Windows, plain elsewhere', () => {
      // UTF-8 stdin fix, invocation layer: paired with the body guard above.
      installStatusLineScript();
      const wrapper = vi.mocked(fs.writeFileSync).mock.calls
        .find(([target]) => target === STATUSLINE_SCRIPT)![1] as string;
      expect(wrapper.includes('-X utf8')).toBe(isWin);
    });
  });

  describe('startWatching', () => {
    it('creates dir and calls fs.watch', () => {
      const win = createMockWin();
      startWatching(win);

      expect(fs.mkdirSync).toHaveBeenCalledWith(STATUS_DIR, { recursive: true, mode: 0o700 });
      expect(fs.watch).toHaveBeenCalledWith(STATUS_DIR, expect.any(Function));
    });
  });

  describe('file change handling', () => {
    it('ignores file changes for unregistered sessions', () => {
      const win = createMockWin();
      startWatching(win);

      vi.mocked(fs.readFileSync).mockReturnValue('working');
      watchCallback!('change', 'unknown-session.status');

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('.status with valid content sends session:hookStatus (legacy format)', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue('working');
      watchCallback!('change', 'abc123.status');

      expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'abc123', 'working', '');
    });

    it('.status with hook name sends session:hookStatus with hook name', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue('PostToolUse:working');
      watchCallback!('change', 'abc123.status');

      expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'abc123', 'working', 'PostToolUse');
    });

    it('.status with invalid content does not send', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue('invalid-status');
      watchCallback!('change', 'abc123.status');

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('.subagents is hook-internal and never forwarded to the renderer', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      watchCallback!('change', 'abc123.subagents');

      expect(mockSend).not.toHaveBeenCalled();
      // Must not even read the counter file — it is purely a hook-side artifact.
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('.sessionid sends session:cliSessionId', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue('claude-session-xyz');
      watchCallback!('change', 'abc123.sessionid');

      expect(mockSend).toHaveBeenCalledWith('session:cliSessionId', 'abc123', 'claude-session-xyz');
    });

    it('.cost parses JSON and sends session:costData', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      const costData = { cost: { total: 1.5 }, context_window: { used: 100 } };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));
      watchCallback!('change', 'abc123.cost');

      expect(mockSend).toHaveBeenCalledWith('session:costData', 'abc123', costData);
    });

    it('.name parses JSON and sends session:sessionName with the CLI session id', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ name: 'Fix the flaky test', session_id: 'cli-1' }),
      );
      watchCallback!('change', 'abc123.name');

      expect(mockSend).toHaveBeenCalledWith('session:sessionName', 'abc123', 'Fix the flaky test', 'cli-1');
    });

    it('.name without a session_id sends an empty CLI session id', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'Untagged' }));
      watchCallback!('change', 'abc123.name');

      expect(mockSend).toHaveBeenCalledWith('session:sessionName', 'abc123', 'Untagged', '');
    });

    it('.name with malformed JSON does not send and does not throw', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      // A partially-flushed write looks exactly like this
      vi.mocked(fs.readFileSync).mockReturnValue('{"name": "Fix the fla');
      expect(() => watchCallback!('change', 'abc123.name')).not.toThrow();

      expect(mockSend).not.toHaveBeenCalledWith('session:sessionName', expect.anything(), expect.anything());
    });

    it('.name with an empty or non-string name does not send', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      for (const payload of ['{}', '{"name":""}', '{"name":123}']) {
        vi.mocked(fs.readFileSync).mockReturnValue(payload);
        watchCallback!('change', 'abc123.name');
      }

      expect(mockSend).not.toHaveBeenCalledWith('session:sessionName', expect.anything(), expect.anything());
    });

    it('.name is ignored for unregistered sessions', () => {
      const win = createMockWin();
      startWatching(win);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'Nope' }));
      watchCallback!('change', 'stranger.name');

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('.toolfailure parses JSON, sends session:toolFailure, and deletes file', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      const failureData = { tool_name: 'Bash', tool_input: { command: 'gh pr list' }, error: 'exit 127' };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(failureData));
      watchCallback!('change', 'abc123-xyzabc.toolfailure');

      expect(mockSend).toHaveBeenCalledWith('session:toolFailure', 'abc123', failureData);
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'abc123-xyzabc.toolfailure'));
    });

    it('.toolfailure extracts session ID from filename with random suffix', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('my-session-id');

      const failureData = { tool_name: 'Bash', tool_input: { command: 'jq .' }, error: 'exit 127' };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(failureData));
      watchCallback!('change', 'my-session-id-abcdef.toolfailure');

      expect(mockSend).toHaveBeenCalledWith('session:toolFailure', 'my-session-id', failureData);
    });

    it('.toolfailure cleans up file even when JSON parsing fails', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockReturnValue('invalid json');
      watchCallback!('change', 'abc123-xyzabc.toolfailure');

      expect(mockSend).not.toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'abc123-xyzabc.toolfailure'));
    });

    it('handles read errors gracefully', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => watchCallback!('change', 'abc123.status')).not.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('skips sending when window is destroyed', () => {
      const win = createMockWin();
      startWatching(win);

      // Now make the window appear destroyed for the handleFileChange check
      // We need a win whose isDestroyed flips, so create a mutable one
      const destroyableWin = { isDestroyed: vi.fn().mockReturnValue(false), webContents: { send: mockSend } } as any;
      // Re-start watching with the destroyable win
      startWatching(destroyableWin);

      registerSession('abc123');
      destroyableWin.isDestroyed.mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('working');
      watchCallback!('change', 'abc123.status');

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resyncs all sessions on null filename', () => {
      const win = createMockWin();
      startWatching(win);
      registerSession('abc123');

      vi.mocked(fs.readdirSync).mockReturnValue(['abc123.cost'] as any);
      const costData = { cost: { total: 1.0 }, context_window: {} };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));

      watchCallback!('change', null);

      expect(fs.readdirSync).toHaveBeenCalledWith(STATUS_DIR);
      expect(mockSend).toHaveBeenCalledWith('session:costData', 'abc123', costData);
    });
  });

  describe('resyncAllSessions', () => {
    it('processes all matching files in dir', () => {
      const win = createMockWin();
      registerSession('s1');
      registerSession('s2');
      registerSession('s3');
      vi.mocked(fs.readdirSync).mockReturnValue([
        's1.status',
        's2.sessionid',
        's3.cost',
        'unrelated.txt',
      ] as any);

      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce('waiting')         // s1.status
        .mockReturnValueOnce('claude-sess-1')   // s2.sessionid
        .mockReturnValueOnce(JSON.stringify({ cost: {} })); // s3.cost

      resyncAllSessions(win);

      expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 's1', 'waiting', '');
      expect(mockSend).toHaveBeenCalledWith('session:cliSessionId', 's2', 'claude-sess-1');
      expect(mockSend).toHaveBeenCalledWith('session:costData', 's3', { cost: {} });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('is a no-op on destroyed window', () => {
      const win = createMockWin(true);
      resyncAllSessions(win);

      expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it('handles missing directory gracefully', () => {
      const win = createMockWin();
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => resyncAllSessions(win)).not.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('restartAndResync', () => {
    it('calls both restartWatcher and resyncAllSessions', () => {
      const win = createMockWin();
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      restartAndResync(win);

      expect(fs.watch).toHaveBeenCalledWith(STATUS_DIR, expect.any(Function));
      expect(fs.readdirSync).toHaveBeenCalledWith(STATUS_DIR);
    });
  });

  describe('cleanupSessionStatus', () => {
    it('unlinks all 7 file types', () => {
      cleanupSessionStatus('sess-1');

      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.status'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.sessionid'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.cost'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.name'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.toolfailure'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.events'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'sess-1.subagents'));
      expect(fs.unlinkSync).toHaveBeenCalledTimes(7);
    });

    it('handles errors when files do not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => cleanupSessionStatus('sess-1')).not.toThrow();
    });

    // P2-20: the writer emits `sess-1-<6 random>.toolfailure`, not the plain
    // name; the plain-name loop alone left pending records behind.
    it('unlinks the suffixed toolfailure variants the writer emits', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        'sess-1.status',
        'sess-1-abc123.toolfailure',
        'sess-1-xyz789.toolfailure',
        'sess-1-other.json',
        'sess-1x-abc123.toolfailure',
      ] as any);

      cleanupSessionStatus('sess-1');

      const unlinked = vi.mocked(fs.unlinkSync).mock.calls.map((c) => String(c[0]));
      expect(unlinked).toContain(path.join(STATUS_DIR, 'sess-1-abc123.toolfailure'));
      expect(unlinked).toContain(path.join(STATUS_DIR, 'sess-1-xyz789.toolfailure'));
      expect(unlinked).not.toContain(path.join(STATUS_DIR, 'sess-1-other.json'));
      expect(unlinked).not.toContain(path.join(STATUS_DIR, 'sess-1x-abc123.toolfailure'));
    });
  });

  describe('polling fallback', () => {
    it('detects changed files on poll interval', async () => {
      const win = createMockWin();
      registerSession('s1');

      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);

      startWatching(win);

      // First poll processes the file, but readFileSync is not mocked to
      // valid JSON yet, so the read fails and nothing reaches the window.
      // The fs.watch is alive, so the poll runs at the 15 s watchdog cadence
      // (PA-09) — the interval is a backstop for dropped events, not the
      // delivery mechanism.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).not.toHaveBeenCalled();

      // Now file has changed mtime
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 2000 } as any);
      const costData = { cost: { total: 0.5 }, context_window: {} };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));

      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).toHaveBeenCalledWith('session:costData', 's1', costData);
    });

    it('skips files with unchanged mtime', async () => {
      const win = createMockWin();

      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);

      startWatching(win);

      // Seed mtimes
      await vi.advanceTimersByTimeAsync(15_000);

      // Same mtime — no change
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('processes a file that appears between polls', async () => {
      const win = createMockWin();
      registerSession('s1');

      // Seed an empty directory, then a file lands between two polls. The
      // discovering poll has prev === undefined for it: recording the mtime
      // alone swallowed the event — the file is never re-read, so the
      // status/cost/sessionid update was lost until the next change.
      vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
      startWatching(win);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).not.toHaveBeenCalled();

      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1500 } as any);
      const costData = { cost: { total: 0.25 }, context_window: {} };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));

      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).toHaveBeenCalledWith('session:costData', 's1', costData);
    });

    it('stops polling on cleanupAll', () => {
      const win = createMockWin();
      startWatching(win);
      cleanupAll();

      vi.mocked(fs.readdirSync).mockReturnValue(['s1.cost'] as any);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as any);

      vi.advanceTimersByTime(4000);
      expect(fs.statSync).not.toHaveBeenCalled();
    });

    it('does not touch the status dir while no session is registered (PA-09)', async () => {
      const win = createMockWin();
      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);

      startWatching(win);
      await vi.advanceTimersByTimeAsync(90_000); // six watchdog ticks

      // handleFileChange drops every file whose id is unknown, so the sweep
      // was pure waste: an idle app now issues zero status-dir reads.
      expect(fs.promises.readdir).not.toHaveBeenCalled();
      expect(fs.promises.stat).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('polls on the watchdog cadence while the watch lives, at 2s once it dies (PA-09)', async () => {
      const win = createMockWin();
      registerSession('s1');
      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);
      const costData = { cost: { total: 0.5 }, context_window: {} };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));

      startWatching(win);
      await vi.advanceTimersByTimeAsync(2_000);
      // fs.watch is alive and delivers these changes itself; the 2s sweep is
      // now the 15s watchdog, so this tick must not fire.
      expect(mockSend).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(13_000); // t=15s: the watchdog tick
      expect(mockSend).toHaveBeenCalledTimes(1);

      // The watch dies (EMFILE): the fast 2s fallback comes back.
      killWatcher();
      mockSend.mockClear();
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 2000 } as any);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockSend).toHaveBeenCalledWith('session:costData', 's1', costData);
    });

    it('forgets tracked mtimes for files that disappeared (PA-23)', async () => {
      const win = createMockWin();
      registerSession('s1');
      const costData = { cost: { total: 0.5 }, context_window: {} };
      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(costData));

      startWatching(win);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mockSend).toHaveBeenCalledTimes(1);
      mockSend.mockClear();

      // The file is unlinked (release / /clear retraction) and later recreated
      // with the SAME mtime — routine on a coarse-mtime filesystem.
      vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
      await vi.advanceTimersByTimeAsync(15_000); // the sweep drops the stale key
      expect(fs.promises.stat).toHaveBeenCalledTimes(1); // nothing statted for a gone file

      vi.mocked(fs.promises.readdir).mockResolvedValue(['s1.cost'] as any);
      vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 1000 } as any);
      await vi.advanceTimersByTimeAsync(15_000);
      // Pre-fix the stale key suppressed this delivery: prev === mtime.
      expect(mockSend).toHaveBeenCalledWith('session:costData', 's1', costData);
    });
  });

  describe('cleanupAll', () => {
    it('closes watcher, removes status files but keeps script dir', () => {
      const win = createMockWin();
      startWatching(win);
      vi.clearAllMocks();

      vi.mocked(fs.readdirSync).mockImplementation(((dir: string) => {
        if (dir === STATUS_DIR) {
          return ['a.status', 'b.sessionid', 'c.cost', 'other.log'];
        }
        return [];
      }) as any);

      cleanupAll();

      expect(mockClose).toHaveBeenCalled();
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'a.status'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'b.sessionid'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(STATUS_DIR, 'c.cost'));
      expect(fs.rmSync).toHaveBeenCalledWith(STATUS_DIR, { recursive: true });
      // SCRIPT_DIR should NOT be cleaned up — scripts persist across restarts
      expect(fs.rmSync).not.toHaveBeenCalledWith(SCRIPT_DIR, { recursive: true });
      // 3 runtime files; 'other.log' skipped
      expect(fs.unlinkSync).toHaveBeenCalledTimes(3);
    });

    it('handles missing directory gracefully', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => cleanupAll()).not.toThrow();
    });
  });
});

describe('getStatusDir (multi-user tmpdir)', () => {
  // POSIX /tmp is world-writable and shared: a fixed 'finevibe' name under
  // mode 0700 belongs to whoever created it first, and every other user's
  // hooks then fail to write their status files — silently. The uid suffix
  // gives each user a private directory; Windows %TEMP% is already per-user.
  it('suffixes the uid on POSIX and stays bare on Windows', async () => {
    const cases = [
      { win: false, uid: 1000, want: path.join('/tmp', 'finevibe-1000') },
      { win: true, uid: 1000, want: path.join('/tmp', 'finevibe') },
      { win: false, uid: undefined, want: path.join('/tmp', 'finevibe') },
    ] as const;
    for (const { win, uid, want } of cases) {
      vi.resetModules();
      vi.doMock('./platform', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./platform')>();
        return { ...actual, isWin: win };
      });
      const realGetuid = process.getuid;
      if (uid === undefined) delete (process as { getuid?: unknown }).getuid;
      else (process as { getuid?: unknown }).getuid = () => uid;
      try {
        const m = await import('./hook-status');
        expect(m.getStatusDir(), `isWin=${win} uid=${uid}`).toBe(want);
        // STATUS_DIR is the one constant every producer/consumer routes
        // through (watcher, mkdirs, cleanup, generated scripts).
        expect(m.STATUS_DIR).toBe(want);
      } finally {
        (process as { getuid?: unknown }).getuid = realGetuid;
        vi.doUnmock('./platform');
        vi.resetModules();
      }
    }
  });
});

describe('remote status sidecar poll (per-host providers T2)', () => {
  it('delivers host-side status changes as session:hookStatus, content-gated', async () => {
    const win = createMockWin();
    startWatching(win);
    registerRemoteStatus('sess-1', 'lab');
    vi.mocked(readProviderFileWindow).mockResolvedValue('Stop:completed');
    // Watcher is alive (watchImpl), so the poll runs at the watchdog cadence.
    await vi.advanceTimersByTimeAsync(15_000);
    // Windowed tail read (audit T2 #7): a fat sidecar is never slurped whole.
    expect(readProviderFileWindow).toHaveBeenCalledWith(
      'lab', '.finevibe/run/sess-1.status', 4096, { fromEnd: true },
    );
    expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'sess-1', 'completed', 'Stop');
    // Unchanged content on the next tick delivers nothing.
    mockSend.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSend).not.toHaveBeenCalled();
    // A change delivers once, with the hook name split out.
    vi.mocked(readProviderFileWindow).mockResolvedValue('UserPromptSubmit:working');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'sess-1', 'working', 'UserPromptSubmit');
  });

  it('drops out-of-set statuses with a log, delivers nothing', async () => {
    const win = createMockWin();
    startWatching(win);
    registerRemoteStatus('sess-2', 'lab');
    vi.mocked(readProviderFileWindow).mockResolvedValue('Stop:teleported');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('teleported'));
  });

  it('a failed read cools the host down for 30s: no reconnect storm, retries after', async () => {
    const win = createMockWin();
    startWatching(win);
    registerRemoteStatus('sess-3', 'lab');
    registerRemoteStatus('sess-3b', 'lab');
    vi.mocked(readProviderFileWindow).mockRejectedValue(new Error('connection closed'));
    await vi.advanceTimersByTimeAsync(15_000); // tick@15s: first failure cools the host, second entry skipped
    expect(readProviderFileWindow).toHaveBeenCalledTimes(1);
    readProviderFileWindow.mockClear();
    // Audit T2 #2: ticks inside the cooldown window (30 s from the failure,
    // i.e. until t=45 s) probe the host ZERO times (per session, per tick
    // each used to re-pay a ~11 s connect).
    await vi.advanceTimersByTimeAsync(15_000); // tick@30s: in-window
    expect(readProviderFileWindow).not.toHaveBeenCalled();
    // Past the cooldown the host is probed again and delivers.
    vi.mocked(readProviderFileWindow).mockResolvedValue('Stop:completed');
    await vi.advanceTimersByTimeAsync(15_000); // tick@45s: window expired → probe
    expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'sess-3', 'completed', 'Stop');
  });

  it('a cooling host never stalls the local sweep (audit T2 #2)', async () => {
    const win = createMockWin();
    let releaseRead: () => void = () => {};
    vi.mocked(readProviderFileWindow).mockReturnValue(
      new Promise<string>((resolve) => {
        releaseRead = () => resolve('Stop:completed');
      }),
    );
    // Local file the sweep should deliver while the remote read is in flight.
    vi.mocked(fs.promises.readdir).mockResolvedValue(['local-1.status'] as any);
    vi.mocked(fs.promises.stat).mockResolvedValue({ mtimeMs: 5 } as any);
    vi.mocked(fs.readFileSync).mockReturnValue('PostToolUse:working' as any);
    startWatching(win); // watcher alive → watchdog cadence (15 s)
    registerSession('local-1');
    registerRemoteStatus('sess-hang', 'slowhost');
    await vi.advanceTimersByTimeAsync(15_000); // tick fires; remote read hangs
    // The local sweep is NOT awaited behind the remote read: it delivered.
    expect(mockSend).toHaveBeenCalledWith('session:hookStatus', 'local-1', 'working', 'PostToolUse');
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cleanupSessionStatus stops polling the session', async () => {
    const win = createMockWin();
    startWatching(win);
    registerRemoteStatus('sess-4', 'lab');
    cleanupSessionStatus('sess-4');
    vi.mocked(readProviderFileWindow).mockResolvedValue('Stop:completed');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readProviderFileWindow).not.toHaveBeenCalled();
  });

  it('rejects unsafe session ids (the id becomes a sidecar path segment)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerRemoteStatus('../evil', 'lab');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unsafe session id'));
    // No entry was registered: a poll tick never touches the seam.
    registerSession('real-session'); // keep the poll loop alive (PA-09 gate)
    const win = createMockWin();
    startWatching(win);
    vi.mocked(readProviderFileWindow).mockResolvedValue('Stop:completed');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readProviderFileWindow).not.toHaveBeenCalled();
  });
});
