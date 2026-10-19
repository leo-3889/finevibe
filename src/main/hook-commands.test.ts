import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stopStatusCmd, installHookScripts, STOP_STALE_MS } from './hook-commands';
import { pythonBin, isWin } from './platform';

// `fs` is mocked module-wide above; the executed-script suite below needs the
// real thing to stage a temp dir and read back what the hook wrote.
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

// Resolved at collection time so describe.runIf can see it — a CI image without
// a usable python should skip these, not fail them.
const pythonAvailable = spawnSync(pythonBin, ['-c', 'pass']).status === 0;

const HOOK_MARKER = '# vibeyard-hook';

describe('statusCmd interpreter pinning', () => {
  // Regression: the Windows branch used to emit bare `python`, the Store
  // stub on many machines — every event:status hook died silently while
  // Stop/cost hooks (which use pythonBin) kept working.
  it('invokes the pinned pythonBin, never bare python, on Windows', async () => {
    vi.resetModules();
    vi.doMock('./platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./platform')>();
      return { ...actual, isWin: true, pythonBin: 'py -3' };
    });
    try {
      const { statusCmd } = await import('./hook-commands');
      const cmd = statusCmd('UserPromptSubmit', 'working', 'SID', HOOK_MARKER);
      expect(cmd.startsWith('py -3 "')).toBe(true);
      expect(cmd.startsWith('python ')).toBe(false);
    } finally {
      vi.doUnmock('./platform');
      vi.resetModules();
    }
  });

  it('quotes event, status, session var and marker in positional order on Windows', async () => {
    vi.resetModules();
    vi.doMock('./platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./platform')>();
      return { ...actual, isWin: true, pythonBin: 'py -3' };
    });
    try {
      const { statusCmd } = await import('./hook-commands');
      const cmd = statusCmd('UserPromptSubmit', 'working', 'SID', HOOK_MARKER);
      // status_writer.py parses argv positionally with every field quoted; a
      // shape drift silently kills every event:status hook.
      const m = cmd.match(/^py -3 "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)" "([^"]+)" "([^"]*)"$/);
      expect(m, `unparsable command shape: ${cmd}`).not.toBeNull();
      expect(m![1].endsWith('/status_writer.py')).toBe(true);
      expect(m![2]).toBe('UserPromptSubmit');
      expect(m![3]).toBe('working');
      expect(m![4]).toBe('SID');
      expect(m![5]).toContain('vibeyard');
      expect(m![6]).toBe(HOOK_MARKER);
    } finally {
      vi.doUnmock('./platform');
      vi.resetModules();
    }
  });

  it('emits the sh -c mkdir/echo pipeline on the POSIX branch', async () => {
    vi.resetModules();
    vi.doMock('./platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./platform')>();
      return { ...actual, isWin: false };
    });
    try {
      const { statusCmd } = await import('./hook-commands');
      const cmd = statusCmd('Stop', 'completed', 'SID', HOOK_MARKER);
      // No python on this branch — it must not mention an interpreter at all.
      expect(cmd.startsWith(`sh -c 'mkdir -p `)).toBe(true);
      expect(cmd).toContain('&& echo Stop:completed > ');
      // `$SID` — the CLI expands the session-var name at hook runtime.
      expect(cmd).toContain('$SID.status');
      expect(cmd.trimEnd().endsWith(`${HOOK_MARKER}'`)).toBe(true);
      expect(cmd).not.toContain('python');
    } finally {
      vi.doUnmock('./platform');
      vi.resetModules();
    }
  });
});

describe('statusCmd POSIX atomic write', () => {
  // hook-status.ts re-reads a .status file only when its mtime CHANGES and
  // validates the content against a 4-value allowlist. `echo > file` truncates
  // the target first, so on a coarse-mtime filesystem (1 s tmpfs, HFS+) the
  // truncate and the final write share one mtime tick: a poll that samples the
  // file mid-write records the truncate's mtime, rejects the empty content,
  // and never re-reads the finished value — the status transition is dropped
  // forever. The generator must therefore write a temp name and rename.
  async function posixStatusCmd(event: string, status: string): Promise<string> {
    vi.resetModules();
    vi.doMock('./platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./platform')>();
      return { ...actual, isWin: false };
    });
    try {
      const { statusCmd } = await import('./hook-commands');
      return statusCmd(event, status, 'SID', HOOK_MARKER);
    } finally {
      vi.doUnmock('./platform');
      vi.resetModules();
    }
  }

  it('redirects into a .status.tmp name, never the watched file', async () => {
    const cmd = await posixStatusCmd('UserPromptSubmit', 'working');
    const redirects = cmd.match(/>\s*[^&']+/g) ?? [];
    expect(redirects.length).toBe(1);
    expect(redirects[0].trim().endsWith('$SID.status.tmp')).toBe(true);
  });

  it('renames the temp file into place inside the same directory', async () => {
    const cmd = await posixStatusCmd('UserPromptSubmit', 'working');
    expect(cmd).toContain('&& mv ');
    const mv = cmd.match(/mv (\S+) (\S+)/);
    expect(mv, `no mv in: ${cmd}`).not.toBeNull();
    expect(mv![1].endsWith('$SID.status.tmp')).toBe(true);
    expect(mv![2].endsWith('$SID.status')).toBe(true);
    // Same directory: a cross-directory mv is not atomic.
    expect(mv![1].replace(/\.tmp$/, '')).toBe(mv![2]);
  });

  it.runIf(!isWin)('leaves exactly one watched file with the allowlisted value', async () => {
    const cmd = await posixStatusCmd('Stop', 'completed');
    const body = cmd.slice(`sh -c '`.length, -1);
    const sid = `vibeyard-atomic-${process.pid}`;
    // Paths straight out of the generated command, so the test follows the
    // generator's own STATUS_DIR rather than duplicating it.
    const target = cmd.match(/mv \S+ (\S+)/)![1].replace('$SID', sid);
    const tmpName = `${target}.tmp`;
    realFs.rmSync(target, { force: true });
    realFs.rmSync(tmpName, { force: true });
    try {
      const res = spawnSync('sh', ['-c', body], {
        env: { ...process.env, SID: sid },
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      // The consumer trims and splits on the first colon, then allowlists the
      // status; anything else is silently dropped.
      expect(realFs.readFileSync(target, 'utf8').trim()).toBe('Stop:completed');
      expect(realFs.existsSync(tmpName)).toBe(false);
    } finally {
      realFs.rmSync(target, { force: true });
      realFs.rmSync(tmpName, { force: true });
    }
  });
});

/**
 * Source of a script that installHookScripts() wrote, by filename.
 *
 * installHookScripts() is guarded by a module-level `scriptsInstalled` flag, so
 * only the first call actually writes. That's fine because the fs mock's call
 * list accumulates for the lifetime of the module — but it does mean this
 * helper would break if a global `clearMocks` were ever turned on in
 * vitest.config.ts.
 */
function installedScript(name: string): string {
  installHookScripts();
  const writes = vi.mocked(fs.writeFileSync).mock.calls.map(([p, code]) => [String(p), String(code)] as const);
  const hit = writes.find(([p]) => p.endsWith(name));
  expect(hit, `${name} was not installed`).toBeDefined();
  return hit![1];
}

describe('stopStatusCmd', () => {
  it('builds a python command invoking stop_status_writer.py with the expected argv', () => {
    const cmd = stopStatusCmd('CLAUDE_IDE_SESSION_ID', HOOK_MARKER);

    expect(cmd).toContain('stop_status_writer.py');
    expect(cmd).toContain('CLAUDE_IDE_SESSION_ID');
    expect(cmd).toContain('vibeyard'); // STATUS_DIR path segment
    expect(cmd).toContain(String(STOP_STALE_MS));
    // Marker is passed as the last quoted argv so isIdeHook recognizes it.
    expect(cmd.trimEnd().endsWith(`"${HOOK_MARKER}"`)).toBe(true);
  });

  it('defaults the staleness window to 10 minutes', () => {
    expect(STOP_STALE_MS).toBe(600000);
  });

  // The pythonAvailable gate above (and the behaviour suite below) only skips
  // EXECUTING the script. These construction assertions run on every machine:
  // the interpreter-pinning/quoting/argv-order contract is what the statusCmd
  // bug class violated, so it must never be environment-optional.
  it('invokes exactly the pinned pythonBin binding, never bare python', () => {
    const cmd = stopStatusCmd('CLAUDE_IDE_SESSION_ID', HOOK_MARKER);
    // Hooks must spawn the LIVE pythonBin binding — whatever
    // prerequisites.checkPythonAvailable() repointed to on this machine.
    expect(cmd.startsWith(`${pythonBin} "`)).toBe(true);
    if (pythonBin !== 'python') expect(cmd.startsWith('python ')).toBe(false);
  });

  it('quotes every argv field in the positional order the writer parses', () => {
    const cmd = stopStatusCmd('CLAUDE_IDE_SESSION_ID', HOOK_MARKER);
    const esc = pythonBin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The generator quotes EVERY field, including the numeric one — the
    // writer reads argv[3] as a string and int()s it, so shell-quoting the
    // digits is required for the "every field quoted" contract. The anchored
    // ^...$ pins argv to exactly five quoted fields (script, sid var, dir,
    // stale ms, marker) in the writer's parse order; a sixth token fails.
    const m = cmd.match(new RegExp(`^${esc} "([^"]+)" "([^"]+)" "([^"]+)" "(\\d+)" "([^"]*)"$`));
    expect(m, `unparsable command shape: ${cmd}`).not.toBeNull();
    // Script resolved under SCRIPT_DIR, slashes normalized for sh/python.
    expect(m![1].endsWith('/stop_status_writer.py')).toBe(true);
    expect(m![2]).toBe('CLAUDE_IDE_SESSION_ID');
    expect(m![3]).toBe(m![3].replace(/\\/g, '/')); // status dir normalized
    expect(m![3]).toContain('vibeyard');
    expect(m![4]).toBe(String(STOP_STALE_MS));
    expect(m![5]).toBe(HOOK_MARKER);
  });
});

describe('installHookScripts', () => {
  it('installs a background-task-aware stop_status_writer.py', () => {
    const body = installedScript('stop_status_writer.py');

    // Prefers the Stop payload's own in-flight report...
    expect(body).toContain('background_tasks');
    expect(body).toContain('isinstance(bt,list)');
    // ...and keeps the legacy counter as the absent-key fallback.
    expect(body).toContain('.subagents');
    expect(body).toContain("'Stop:'+status");
    // Belt-and-suspenders against a mislabeled subagent stop.
    expect(body).toContain("hook_event_name')=='SubagentStop'");
    // A /loop session always has a pending cron; consulting it would mean the
    // session never reports completed.
    expect(body).not.toContain('session_crons');
  });

  it('skips a user-abort failure in tool_failure_capture.py', () => {
    const body = installedScript('tool_failure_capture.py');

    expect(body).toContain("not d.get('is_interrupt')");
    // An empty error can never match either detector, so don't write the file.
    expect(body).toContain('and err and');
  });
});

// The Stop writer's decision table is the load-bearing part of completion
// detection, and asserting on its source text can't tell a correct branch from
// a typo'd one. Run the real script the way Claude Code does: payload on stdin,
// assert the .status file it leaves behind.
describe.runIf(pythonAvailable)('stop_status_writer.py behaviour', () => {
  const SID = 'vibeyard-test-session';
  let dir: string;
  let script: string;

  // Staged in beforeAll, not the describe body: Vitest executes the body even
  // for a skipped suite, but not its hooks — so building the temp dir inline
  // would leak one directory per run on a CI image without python.
  beforeAll(() => {
    dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'vibeyard-stop-'));
    script = path.join(dir, 'stop_status_writer.py');
    realFs.writeFileSync(script, installedScript('stop_status_writer.py'));
  });

  afterAll(() => {
    if (dir) realFs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the writer with `payload` on stdin and return the status it wrote. */
  function run(payload: unknown, counter?: { n: number; t: number }): string {
    const counterPath = path.join(dir, `${SID}.subagents`);
    realFs.rmSync(counterPath, { force: true });
    if (counter) realFs.writeFileSync(counterPath, JSON.stringify(counter));

    const statusPath = path.join(dir, `${SID}.status`);
    realFs.rmSync(statusPath, { force: true });

    const res = spawnSync(pythonBin, [script, 'CLAUDE_IDE_SESSION_ID', dir, String(STOP_STALE_MS)], {
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_IDE_SESSION_ID: SID },
      encoding: 'utf8',
    });
    expect(res.status, res.stderr).toBe(0);
    return realFs.readFileSync(statusPath, 'utf8');
  }

  const base = { hook_event_name: 'Stop', session_id: 'abc' };
  const fresh = () => ({ n: 1, t: Date.now() });

  it('completes when the payload and the counter both report nothing in flight', () => {
    expect(run({ ...base, background_tasks: [], session_crons: [] })).toBe('Stop:completed');
  });

  it('holds working while a subagent is in flight', () => {
    const bt = [{ id: '1', type: 'subagent', status: 'running', agent_type: 'Explore' }];
    expect(run({ ...base, background_tasks: bt })).toBe('Stop:working');
  });

  it('holds working for teammate and workflow tasks too', () => {
    for (const type of ['teammate', 'workflow']) {
      expect(run({ ...base, background_tasks: [{ id: '1', type, status: 'running' }] })).toBe('Stop:working');
    }
  });

  it('completes despite a backgrounded shell — the turn is over', () => {
    const bt = [{ id: '1', type: 'shell', status: 'running', command: 'tail -f log' }];
    expect(run({ ...base, background_tasks: bt })).toBe('Stop:completed');
  });

  it('ignores a subagent already in a terminal state', () => {
    const bt = [{ id: '1', type: 'subagent', status: 'completed' }];
    expect(run({ ...base, background_tasks: bt })).toBe('Stop:completed');
  });

  it('completes with a pending cron so a /loop session is not wedged', () => {
    const crons = [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'check' }];
    expect(run({ ...base, background_tasks: [], session_crons: crons })).toBe('Stop:completed');
  });

  // An empty array means "nothing in flight"; an absent key means the CLI is
  // too old (or the registry is unreachable) and the counter must decide.
  it('falls back to the counter when background_tasks is absent', () => {
    expect(run(base, fresh())).toBe('Stop:working');
    expect(run(base, { n: 0, t: Date.now() })).toBe('Stop:completed');
    // A stale count must not wedge the session forever.
    expect(run(base, { n: 1, t: Date.now() - STOP_STALE_MS - 1000 })).toBe('Stop:completed');
  });

  // An empty array is NOT proof of an idle session: the CLI filters the list on
  // an isBackgrounded flag that freshly-dispatched foreground subagents don't
  // carry yet, so a spurious Stop can report [] with subagents still running.
  // Falling back to the counter costs at most a late notification (bounded by
  // the renderer backstop); trusting [] fires a completion mid-orchestration.
  it('does not treat an empty background_tasks as proof the session is idle', () => {
    expect(run({ ...base, background_tasks: [] }, fresh())).toBe('Stop:working');
  });

  it('still completes on an empty background_tasks once the counter agrees', () => {
    expect(run({ ...base, background_tasks: [] }, { n: 0, t: Date.now() })).toBe('Stop:completed');
  });

  it('never completes the parent for a Stop fired inside a subagent', () => {
    expect(run({ ...base, background_tasks: [], agent_id: 'a1', agent_type: 'Explore' })).toBe('Stop:working');
    expect(run({ ...base, hook_event_name: 'SubagentStop', background_tasks: [] })).toBe('Stop:working');
  });

  // agent_type is also set on the MAIN thread of a `--claude --agent x` session
  // (agent_id is not), so keying on it would wedge such a session in 'working'
  // until the 10-minute renderer backstop fired.
  it('completes a --agent session, where agent_type is set without agent_id', () => {
    expect(run({ ...base, background_tasks: [], agent_type: 'reviewer' })).toBe('Stop:completed');
  });

  it('completes on a malformed payload rather than hanging', () => {
    const statusPath = path.join(dir, `${SID}.status`);
    realFs.rmSync(statusPath, { force: true });
    realFs.rmSync(path.join(dir, `${SID}.subagents`), { force: true });
    const res = spawnSync(pythonBin, [script, 'CLAUDE_IDE_SESSION_ID', dir, String(STOP_STALE_MS)], {
      input: 'not json at all',
      env: { ...process.env, CLAUDE_IDE_SESSION_ID: SID },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(realFs.readFileSync(statusPath, 'utf8')).toBe('Stop:completed');
  });
});
