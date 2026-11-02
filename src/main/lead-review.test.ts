import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LEAD_CHARTER_MAX_BYTES } from '../shared/types';
import type { ChildProcess } from 'child_process';

// The launch lane, the git lane, the state store and the window push are all
// seams this suite drives directly: no CLI, no git, no Electron window.
const mockExecFile = vi.hoisted(() => vi.fn());
const mockResolveLaunchSpec = vi.hoisted(() => vi.fn());
const mockGetGitFiles = vi.hoisted(() => vi.fn());
const mockLoadState = vi.hoisted(() => vi.fn());
const mockSend = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn());
const mockGetProvider = vi.hoisted(() => vi.fn());
const mockFs = vi.hoisted(() => ({
  openSync: vi.fn(() => 7),
  fstatSync: vi.fn(() => ({ size: 0 })),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: mockExecFile }));
vi.mock('fs', () => mockFs);
vi.mock('./pty-manager', () => ({ resolveLaunchSpec: mockResolveLaunchSpec }));
vi.mock('./git-status', () => ({ getGitFiles: mockGetGitFiles }));
vi.mock('./store', () => ({ loadState: mockLoadState, saveState: mockSaveState }));
vi.mock('./main-window', () => ({ sendToMainWindow: mockSend }));
vi.mock('./providers/registry', () => ({ getProvider: mockGetProvider }));
vi.mock('./launch-session-dir', () => ({ launchSessionDir: vi.fn(() => '/tmp/review-dir'), ensureLaunchSessionDir: vi.fn() }));

import {
  LEAD_REVIEW_DIGEST_MAX_BYTES,
  LEAD_REVIEW_OUTPUT_MAX_BYTES,
  LEAD_REVIEW_TIMEOUT_MS,
  _resetLeadReviewForTesting,
  composeLeadDigest,
  isSwarmMemberSession,
  parseLeadVerdict,
  requestLeadReview,
  resolveLeadReviewTarget,
} from './lead-review';
import type { LoadedState } from './store';
import type { LeadReviewNote, ProjectRecord, SessionRecord } from '../shared/types';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/repo/app';

const REF = {
  providerId: 'claude' as const,
  cliSessionId: 'cli-1',
  cwd: PROJECT_PATH,
  configDir: '/home/u/.finevibe/profiles/p1',
  sessionDir: '/tmp/sessions/lead',
};

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    name: 'S',
    cliSessionId: 'cli-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeProject(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'proj-1',
    name: 'App',
    path: PROJECT_PATH,
    sessions: [makeSession()],
    activeSessionId: SESSION_ID,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
    lead: { name: 'Tech Lead', charter: 'Own the quality bar.', enabled: true, reviewMode: 'on-complete' },
    ...over,
  };
}

function makeState(over: Partial<LoadedState> = {}): LoadedState {
  return {
    version: 1,
    projects: [makeProject()],
    activeProjectId: 'proj-1',
    preferences: {
      soundOnSessionWaiting: false,
      notificationsDesktop: false,
      debugMode: false,
      sessionHistoryEnabled: false,
      insightsEnabled: false,
      autoTitleEnabled: false,
      confirmCloseWorkingSession: true,
    },
    hosts: [],
    ...over,
  } as LoadedState;
}

/** Resolve every queued execFile callback the run scheduled. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function execCallback(): (err: unknown, stdout: string, stderr: string) => void {
  return mockExecFile.mock.calls[0][3] as (err: unknown, stdout: string, stderr: string) => void;
}

function execOptions(): Record<string, unknown> {
  return mockExecFile.mock.calls[0][2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLeadReviewForTesting();
  mockLoadState.mockReturnValue(makeState());
  mockGetGitFiles.mockResolvedValue([{ path: 'src/a.ts', status: 'modified', area: 'working' }]);
  mockResolveLaunchSpec.mockReturnValue({
    executable: '/usr/bin/claude',
    argv: ['--append-system-prompt', 'charter', 'review?'],
    env: { PATH: '/usr/bin' },
    providerId: 'claude',
    configDir: REF.configDir,
    storageMode: 'default',
  });
  // A ChildProcess stand-in: the run ends its stdin, so `.stdin.end` must exist.
  mockExecFile.mockReturnValue({ stdin: { end: vi.fn() } } as unknown as ChildProcess);
  mockGetProvider.mockReturnValue({
    getTranscriptPath: vi.fn(() => '/tmp/transcript.jsonl'),
    meta: { capabilities: { systemPromptInjection: true, planModeArg: '--plan-x' } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseLeadVerdict', () => {
  it('reads the two verdicts, with the summary on the same line', () => {
    expect(parseLeadVerdict('VERDICT: APPROVED Tests green, no stray edits.')).toEqual({
      verdict: 'approved',
      summary: 'Tests green, no stray edits.',
    });
    expect(parseLeadVerdict('VERDICT: FLAGGED Left the TODO in auth.ts')).toEqual({
      verdict: 'flagged',
      summary: 'Left the TODO in auth.ts',
    });
  });

  it('takes the summary from the next non-empty line when the verdict line has none', () => {
    expect(parseLeadVerdict('noise\nVERDICT: APPROVED\n\n  Ship it.  \nmore')).toEqual({
      verdict: 'approved',
      summary: 'Ship it.',
    });
  });

  it('tolerates case drift and leading whitespace', () => {
    expect(parseLeadVerdict('  verdict: flagged — needs tests')).toEqual({
      verdict: 'flagged',
      summary: '— needs tests',
    });
  });

  it('prefers the newest verdict line over an echoed prompt', () => {
    const echoed =
      'Review the session per the charter. Reply with exactly one line: VERDICT: APPROVED or VERDICT: FLAGGED, then a one-line summary.\n' +
      'VERDICT: FLAGGED Two files touched, no tests';
    expect(parseLeadVerdict(echoed)).toEqual({ verdict: 'flagged', summary: 'Two files touched, no tests' });
  });

  it('drops prose, an empty summary is still a verdict, and an empty output is nothing', () => {
    expect(parseLeadVerdict('I reviewed the diff and it looks fine.')).toBeNull();
    expect(parseLeadVerdict('VERDICT: APPROVED')).toEqual({ verdict: 'approved', summary: '' });
    expect(parseLeadVerdict('')).toBeNull();
  });

  it('does not match a verdict buried mid-line', () => {
    expect(parseLeadVerdict('the answer is VERDICT: APPROVED')).toBeNull();
  });
});

describe('composeLeadDigest', () => {
  it('carries the files-touched list and the transcript tail', () => {
    const digest = composeLeadDigest(['src/a.ts', 'src/b.ts'], 'user: fix the bug\nassistant: done');
    expect(digest).toContain('Files touched:\nsrc/a.ts\nsrc/b.ts');
    expect(digest).toContain('Transcript tail:\nuser: fix the bug\nassistant: done');
  });

  it('says (none) when the worktree is clean', () => {
    expect(composeLeadDigest([], 'tail')).toContain('Files touched:\n(none)');
  });

  it('stays under LEAD_REVIEW_DIGEST_MAX_BYTES with a huge transcript tail, keeping the newest bytes', () => {
    const tail = `${'x'.repeat(LEAD_REVIEW_DIGEST_MAX_BYTES * 2)}NEWEST`;
    const digest = composeLeadDigest(['src/a.ts'], tail);
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(LEAD_REVIEW_DIGEST_MAX_BYTES);
    expect(digest.endsWith('NEWEST')).toBe(true);
    expect(digest).toContain('src/a.ts');
  });

  it('stays under the cap with a huge files list, dropping whole lines only', () => {
    const files = Array.from({ length: 5_000 }, (_, i) => `src/generated/file-${i}.ts`);
    const digest = composeLeadDigest(files, 'tail text');
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(LEAD_REVIEW_DIGEST_MAX_BYTES);
    expect(digest).toContain(files[0]);
    expect(digest).toContain('…');
    expect(digest).not.toContain('file-4999');
    // Whole lines: no path is cut in half, so every listed path is a real one.
    const listed = digest.slice('Files touched:\n'.length).split('\n\nTranscript tail:\n')[0].split('\n');
    expect(listed.every((l) => l === '…' || files.includes(l))).toBe(true);
  });

  it('never splits a multi-byte character at the cut', () => {
    const digest = composeLeadDigest([], '🎉'.repeat(LEAD_REVIEW_DIGEST_MAX_BYTES));
    expect(digest).not.toContain('\uFFFD');
  });
});

describe('resolveLeadReviewTarget gates', () => {
  const targetOf = (state: LoadedState) => resolveLeadReviewTarget(state, SESSION_ID);

  it('passes for a local session in a lead-enabled on-complete project', () => {
    const { target, skip } = targetOf(makeState());
    expect(skip).toBeNull();
    expect(target?.project.id).toBe('proj-1');
    expect(target?.lead.reviewMode).toBe('on-complete');
  });

  it('skips when the kill-switch pref is off', () => {
    const state = makeState();
    state.preferences.leadReviewsEnabled = false;
    expect(targetOf(state).target).toBeNull();
    expect(targetOf(state).skip).toBe('kill-switch pref');
  });

  it('treats an absent pref as ON (the default)', () => {
    expect(targetOf(makeState()).target).not.toBeNull();
  });

  it('skips a project with no lead, a disabled lead, or reviewMode off', () => {
    const noLead = makeState();
    delete noLead.projects[0].lead;
    expect(targetOf(noLead).skip).toBe('lead review off for project');

    const disabled = makeState();
    disabled.projects[0].lead = { name: 'L', charter: 'c', enabled: false, reviewMode: 'on-complete' };
    expect(targetOf(disabled).target).toBeNull();

    const modeOff = makeState();
    modeOff.projects[0].lead = { name: 'L', charter: 'c', enabled: true, reviewMode: 'off' };
    expect(targetOf(modeOff).target).toBeNull();

    const noMode = makeState();
    noMode.projects[0].lead = { name: 'L', charter: 'c', enabled: true };
    expect(targetOf(noMode).target).toBeNull();
  });

  it('skips a remote session (v1 reviews local sessions only)', () => {
    const state = makeState();
    state.projects[0].sessions[0].hostId = 'host-1';
    expect(targetOf(state).skip).toBe('remote session');
  });

  it('skips a session with no CLI id (no transcript to digest)', () => {
    const state = makeState();
    state.projects[0].sessions[0].cliSessionId = null;
    expect(targetOf(state).skip).toBe('no cli session id');
  });

  it('skips an unknown session', () => {
    expect(resolveLeadReviewTarget(makeState(), 'nope').skip).toBe('unknown session');
  });
});

describe('swarm exclusion', () => {
  it('a team-member session is never reviewed', () => {
    const state = makeState();
    state.projects[0].sessions[0].teamMemberId = 'member-1';
    expect(resolveLeadReviewTarget(state, SESSION_ID).skip).toBe('swarm member');
    expect(isSwarmMemberSession(state.projects[0], state.projects[0].sessions[0])).toBe(true);
  });

  it('a pane of a swarm-layout project is never reviewed', () => {
    const project = makeProject({
      layout: { mode: 'swarm', splitPanes: [SESSION_ID], splitDirection: 'vertical' },
    });
    expect(isSwarmMemberSession(project, project.sessions[0])).toBe(true);
  });

  it('a tabs-layout session is not a swarm member', () => {
    const project = makeProject();
    expect(isSwarmMemberSession(project, project.sessions[0])).toBe(false);
  });
});

describe('requestLeadReview', () => {
  it('spawns the hidden review on the provider launch lane and pushes the verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush();

    expect(mockResolveLaunchSpec).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      cliSessionId: null,
      isResume: false,
      extraArgs: '',
      providerId: 'claude',
      initialPrompt: expect.stringContaining('VERDICT: APPROVED or VERDICT: FLAGGED'),
      systemPrompt: expect.stringContaining('Own the quality bar.'),
      envVars: '',
      configDir: REF.configDir,
    });
    expect(mockResolveLaunchSpec.mock.calls[0][0].systemPrompt).toContain('Files touched:\nsrc/a.ts');
    const [executable, argv] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(executable).toBe('/usr/bin/claude');
    expect(argv).toEqual(['--append-system-prompt', 'charter', 'review?', '--plan-x']);
    expect(execOptions()).toMatchObject({
      cwd: PROJECT_PATH,
      env: { PATH: '/usr/bin' },
      timeout: LEAD_REVIEW_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: LEAD_REVIEW_OUTPUT_MAX_BYTES,
    });
    // EOF on stdin: a TUI-shaped CLI must not sit reading a pipe until the kill.
    expect((mockExecFile.mock.results[0].value as ChildProcess).stdin?.end).toHaveBeenCalled();

    execCallback()(null, 'VERDICT: APPROVED Clean change', '');
    const note = mockSend.mock.calls[0][1] as LeadReviewNote;
    expect(mockSend.mock.calls[0][0]).toBe('lead:review');
    expect(note).toMatchObject({ v: 1, sessionId: SESSION_ID, verdict: 'approved', summary: 'Clean change' });
    expect(mockSend.mock.calls[0][2]).toBe('proj-1');
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('runs at most ONE review per session, however many completions arrive', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush();
    requestLeadReview(SESSION_ID, REF);
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('never spawns for a gated session, and claims nothing', async () => {
    const state = makeState();
    state.preferences.leadReviewsEnabled = false;
    mockLoadState.mockReturnValue(state);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    // The kill switch is silent by design: it is the pref saying "no reviews".
    expect(log).not.toHaveBeenCalled();
  });

  it('kills the run on timeout and lands no verdict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush();
    execCallback()(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }), '', '');
    expect(mockSend).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('drops unparseable output with one log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush();
    execCallback()(null, 'I looked at the diff. It is fine.', '');
    expect(mockSend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no verdict'));
  });

  it('keeps a verdict printed on a non-zero exit', async () => {
    requestLeadReview(SESSION_ID, REF);
    await flush();
    execCallback()(Object.assign(new Error('exit 1'), { killed: false }), 'VERDICT: FLAGGED Missing tests', '');
    expect(mockSend).toHaveBeenCalledWith('lead:review', expect.objectContaining({ verdict: 'flagged' }), 'proj-1');
  });

  it('refuses to spawn when the launch lane refuses, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolveLaunchSpec.mockImplementation(() => {
      throw new Error('Unsupported launch options');
    });
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spawn refused'));
  });

  it('survives a throwing state read (the status pipeline must not break)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadState.mockImplementation(() => {
      throw new Error('state.json is unreadable');
    });
    expect(() => requestLeadReview(SESSION_ID, REF)).not.toThrow();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gate threw'));
  });

  it('never spawns for a provider with no system-prompt lane (Copilot, Gemini)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetProvider.mockReturnValue({
      getTranscriptPath: vi.fn(() => '/t.jsonl'),
      meta: { capabilities: { systemPromptInjection: false, planModeArg: '--plan-x' } },
    });
    requestLeadReview(SESSION_ID, { ...REF, providerId: 'copilot' });
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no system-prompt lane'));
  });

  it('digests an unreadable transcript as no tail and still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFs.openSync.mockImplementationOnce(() => {
      throw new Error('ENOENT');
    });
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockResolveLaunchSpec.mock.calls[0][0].systemPrompt).toContain('Transcript tail:\n');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('transcript tail unreadable'));
  });

  it('reads the transcript tail from the provider-resolved path', async () => {
    const getTranscriptPath = vi.fn(() => '/tmp/transcript.jsonl');
    mockGetProvider.mockReturnValue({
      getTranscriptPath,
      meta: { capabilities: { systemPromptInjection: true, planModeArg: '--plan-x' } },
    });
    const payload = Buffer.from('the newest turn', 'utf8');
    mockFs.fstatSync.mockReturnValueOnce({ size: payload.length });
    mockFs.readSync.mockImplementationOnce((_fd: number, buffer: Buffer, _o: number, len: number, position: number) => {
      payload.copy(buffer, 0, 0, len);
      expect(position).toBe(0);
      return len;
    });
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(getTranscriptPath).toHaveBeenCalledWith('cli-1', REF.cwd, REF.configDir, REF.sessionDir);
    expect(mockFs.closeSync).toHaveBeenCalledWith(7);
    expect(mockResolveLaunchSpec.mock.calls[0][0].systemPrompt).toContain('the newest turn');
  });
});

describe('review fixes (7c3238b9)', () => {
  it('skips providers WITHOUT a read-only plan-mode grant (no default-tool agent)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetProvider.mockReturnValue({
      getTranscriptPath: vi.fn(() => '/tmp/t.jsonl'),
      meta: { capabilities: { systemPromptInjection: true } },
    });
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no read-only plan-mode grant'));
  });

  it('caps concurrency: a second completion while one runs skips with a log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestLeadReview(SESSION_ID, REF);
    await flush(); // the spawn is async past getGitFiles; let it reach execFile
    requestLeadReview('other-session', { ...REF });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('concurrency cap'));
  });

  it('claims the review on the SESSION RECORD and persists it (survives restart)', async () => {
    const state = mockLoadState();
    requestLeadReview(SESSION_ID, REF);
    await flush();
    const session = state.projects[0].sessions.find((x) => x.id === SESSION_ID);
    expect(typeof session.leadReviewedAt).toBe('number');
    expect(mockSaveState).toHaveBeenCalled();
    _resetLeadReviewForTesting();
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('skips a session under a REMOTE project (registry-host cwd is not a local path)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = mockLoadState();
    state.projects[0].hostId = 'host-1';
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('remote project'));
  });

  it('skips an over-cap charter hand-edited into state.json (the cap is not renderer-only)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = mockLoadState();
    state.projects[0].lead!.charter = 'x'.repeat(LEAD_CHARTER_MAX_BYTES + 1);
    requestLeadReview(SESSION_ID, REF);
    await flush();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cap'));
  });

  it('parses markdown-wrapped verdicts', () => {
    expect(parseLeadVerdict('notes\n**VERDICT: APPROVED** — ship it')).toEqual({
      verdict: 'approved',
      summary: '— ship it',
    });
    expect(parseLeadVerdict('**VERDICT: FLAGGED**')).toEqual({ verdict: 'flagged', summary: '' });
  });
});
