import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  sessionHeaderFromWindow,
  transcriptTitleFromWindow,
  sessionInfoNameFromWindow,
  readTranscriptTitleWithSessionInfoSync,
  transcriptStatusFromTail,
  readTranscriptStatusSync,
  sessionExitReasonFromTail,
  readSessionExitReasonSync,
  findTranscriptPathSync,
  TAIL_READ_BYTES,
  HEADER_READ_BYTES,
} from './pi-compatible-transcripts';

const header = (id: string, cwd: string, title?: string) =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: 't',
    cwd,
    ...(title === undefined ? {} : { title, titleSource: 'auto' }),
  });

const titleEntry = (title: string) =>
  JSON.stringify({ type: 'title', v: 1, title, source: 'auto', updatedAt: 't' });

describe('findTranscriptPathSync configDir threading', () => {
  it('scans the overridden tree for a configDir override', () => {
    // A pinned profile's configDir relocates the whole agent tree: the scan
    // must start under sessionsRootOf(configDir), not the provider default.
    // (P2-113 gates the renderer-supplied configDir at the IPC boundary;
    // this scan trusts what its main-process caller threads through.)
    const sessionsRootOf = vi.fn(() => '/definitely/not/a/root');
    expect(findTranscriptPathSync(sessionsRootOf, 'cli-1', '/proj', '/profiles/work')).toBeNull();
    expect(sessionsRootOf).toHaveBeenCalledWith('/profiles/work');
  });

  it('scans the default tree for an undefined config dir', () => {
    const sessionsRootOf = vi.fn(() => path.join(os.tmpdir(), 'finevibe-compat-missing-root'));
    expect(findTranscriptPathSync(sessionsRootOf, 'cli-1', '/proj')).toBeNull();
    expect(sessionsRootOf).toHaveBeenCalledWith(undefined);
  });
});

describe('sessionHeaderFromWindow', () => {
  it('finds the header on line 1 (Pi layout, no title line)', () => {
    const h = sessionHeaderFromWindow(header('pi-1', '/proj'));
    expect(h?.id).toBe('pi-1');
    expect(h?.cwd).toBe('/proj');
  });

  it('finds the header when a title line precedes it (OMP layout)', () => {
    const window = [titleEntry('Some title'), header('omp-1', '/proj')].join('\n');
    const h = sessionHeaderFromWindow(window);
    expect(h?.id).toBe('omp-1');
    expect(h?.cwd).toBe('/proj');
  });

  it('returns null for a null or non-JSON window', () => {
    expect(sessionHeaderFromWindow(null)).toBeNull();
    expect(sessionHeaderFromWindow('not json at all')).toBeNull();
  });

  it('ignores non-session entries before the header', () => {
    const window = ['{"type":"model_change","id":"m1"}', header('omp-2', '/proj')].join('\n');
    expect(sessionHeaderFromWindow(window)?.id).toBe('omp-2');
  });
});

describe('transcriptTitleFromWindow', () => {
  it('reads the title from the type:"title" entry', () => {
    const window = [titleEntry('Per-Provider Default Profile Migration'), header('omp-1', '/proj')].join('\n');
    expect(transcriptTitleFromWindow(window)).toBe('Per-Provider Default Profile Migration');
  });

  it('prefers the title entry over the header title field', () => {
    const window = [titleEntry('Entry title'), header('omp-1', '/proj', 'Header title')].join('\n');
    expect(transcriptTitleFromWindow(window)).toBe('Entry title');
  });

  it('falls back to the header title field when no title entry exists', () => {
    expect(transcriptTitleFromWindow(header('omp-1', '/proj', 'Header title'))).toBe('Header title');
  });

  it('returns null for transcripts without any title (Pi)', () => {
    expect(transcriptTitleFromWindow(header('pi-1', '/proj'))).toBeNull();
  });

  it('returns null for a blank title', () => {
    expect(transcriptTitleFromWindow([titleEntry('   '), header('omp-1', '/proj')].join('\n'))).toBeNull();
  });

  it('trims surrounding whitespace from the title', () => {
    expect(transcriptTitleFromWindow(titleEntry('  Padded title  '))).toBe('Padded title');
  });
});

const sessionInfo = (name: string) =>
  JSON.stringify({ type: 'session_info', id: 'si', parentId: null, timestamp: 't', name });
/** Padding entry: fills window bytes so entries land out of the head/tail windows. */
const pad = (bytes: number) => JSON.stringify({ type: 'model_change', id: 'p', provider: 'x'.repeat(bytes) });

describe('sessionInfoNameFromWindow', () => {
  it('returns the LAST session_info name (append-only file order)', () => {
    const window = [header('pi-1', '/proj'), sessionInfo('First name'), sessionInfo('Latest name')].join('\n');
    expect(sessionInfoNameFromWindow(window)).toBe('Latest name');
  });

  it('ignores blank names and non-session_info entries', () => {
    const window = [header('pi-1', '/proj'), sessionInfo('   '), sessionInfo(''), pad(10)].join('\n');
    expect(sessionInfoNameFromWindow(window)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sessionInfoNameFromWindow(sessionInfo('  Padded name  '))).toBe('Padded name');
  });

  it('skips a partial leading line (tail windows start mid-line)', () => {
    const full = sessionInfo('Real name');
    const partial = full.slice(20); // tail window cut mid-entry
    expect(sessionInfoNameFromWindow(`${partial}\n${full}`)).toBe('Real name');
  });

  it('returns null for a null window, non-JSON lines, and Pi transcripts without names', () => {
    expect(sessionInfoNameFromWindow(null)).toBeNull();
    expect(sessionInfoNameFromWindow('not json')).toBeNull();
    expect(sessionInfoNameFromWindow(header('pi-1', '/proj'))).toBeNull();
  });
});

describe('readTranscriptTitleWithSessionInfoSync', () => {
  const write = (dir: string, lines: string[]) => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  };

  it('reads a name set at launch from a short transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [header('pi-1', '/proj'), sessionInfo('Refactor auth module')]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBe('Refactor auth module');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a recent /name that has already left the head window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [
        header('pi-1', '/proj'),
        pad(HEADER_READ_BYTES), // pushes everything after it out of the 8 KiB head
        sessionInfo('Renamed mid-session'),
      ]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBe('Renamed mid-session');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the newer tail name over the launch name in the head', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [
        header('pi-1', '/proj'),
        sessionInfo('Launch name'),
        pad(HEADER_READ_BYTES + TAIL_READ_BYTES), // pushes 'Launch name' out of the tail window
        sessionInfo('Mid name'),
        pad(HEADER_READ_BYTES), // keeps 'Mid name' out of the head; tail ends at 'Latest name'
        sessionInfo('Latest name'),
      ]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBe('Latest name');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a name buried beyond both windows (documented bounded-read limit)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [
        header('pi-1', '/proj'),
        pad(HEADER_READ_BYTES),
        sessionInfo('Buried name'),
        pad(TAIL_READ_BYTES), // last window covers only padding — the name is out of reach
      ]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers an OMP transcript (in-place title line, no session_info) from the head', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [titleEntry('OMP title'), header('omp-1', '/proj', 'Header title'), pad(1024)]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBe('OMP title');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a plain Pi transcript with no name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-title-'));
    try {
      const file = write(dir, [header('pi-1', '/proj'), pad(1024)]);
      expect(readTranscriptTitleWithSessionInfoSync(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const assistant = (stopReason: string) =>
  JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason } });
const userMsg = () => JSON.stringify({ type: 'message', message: { role: 'user' } });
const toolResult = () => JSON.stringify({ type: 'message', message: { role: 'toolResult' } });
const toolStart = () => JSON.stringify({ type: 'custom', customType: 'tool_execution_start' });
const sessionExit = () => JSON.stringify({ type: 'custom', customType: 'session_exit' });

describe('transcriptStatusFromTail', () => {
  it('maps a clean assistant finish (stop) to completed', () => {
    expect(transcriptStatusFromTail(assistant('stop'))).toBe('completed');
  });

  it('maps an assistant turn stopped on a tool call to working', () => {
    expect(transcriptStatusFromTail(assistant('toolUse'))).toBe('working');
  });

  it('maps an assistant turn that errored to waiting (back at prompt)', () => {
    expect(transcriptStatusFromTail(assistant('error'))).toBe('waiting');
  });

  it('maps a user message to working (CLI processing)', () => {
    expect(transcriptStatusFromTail(userMsg())).toBe('working');
  });

  it('maps a toolResult to working (assistant continues)', () => {
    expect(transcriptStatusFromTail(toolResult())).toBe('working');
  });

  it('maps a tool_execution_start marker to working', () => {
    expect(transcriptStatusFromTail(toolStart())).toBe('working');
  });

  it('maps session_exit to null (session removed on PTY exit)', () => {
    expect(transcriptStatusFromTail(sessionExit())).toBeNull();
    expect(transcriptStatusFromTail([assistant('toolUse'), sessionExit()].join('\n'))).toBeNull();
  });

  it('skips non-event lines and uses the last meaningful entry', () => {
    const tail = [
      assistant('stop'),
      titleEntry('A title'),
      '{"type":"model_change","id":"m"}',
    ].join('\n');
    expect(transcriptStatusFromTail(tail)).toBe('completed');
  });

  it('skips a mid-write tail line and keeps scanning backwards', () => {
    const tail = [assistant('toolUse'), '{"type":"message","message":{"role":"assistant","st'].join('\n');
    expect(transcriptStatusFromTail(tail)).toBe('working');
  });

  it('skips a bare null / scalar line and keeps scanning backwards', () => {
    // JSON.parse('null') succeeds and yields null, so an unguarded `.type`
    // read threw a TypeError out of the status poller on every poll of a
    // transcript containing such a line.
    expect(transcriptStatusFromTail(['null', assistant('stop')].join('\n'))).toBe('completed');
    expect(transcriptStatusFromTail(['42', '"a string"', 'true'].join('\n'))).toBeNull();
  });

  it('returns null for a null or non-JSON tail', () => {
    expect(transcriptStatusFromTail(null)).toBeNull();
    expect(transcriptStatusFromTail('not json at all')).toBeNull();
  });

  it('returns null when only non-event entries are present', () => {
    const tail = [titleEntry('t'), '{"type":"model_change","id":"m"}'].join('\n');
    expect(transcriptStatusFromTail(tail)).toBeNull();
  });
});

describe('readTranscriptStatusSync huge-entry fallback', () => {
  it('captures the status of a final entry larger than the tail window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tail-'));
    try {
      const file = path.join(dir, 't.jsonl');
      const big = 'x'.repeat(TAIL_READ_BYTES + 4096);
      const hugeEntry = JSON.stringify({
        type: 'message',
        message: { role: 'assistant', stopReason: 'stop', content: big },
      });
      expect(hugeEntry.length).toBeGreaterThan(TAIL_READ_BYTES);
      const content = `${[
        header('s1', '/proj'),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'go' } }),
        hugeEntry,
      ].join('\n')}\n`;
      fs.writeFileSync(file, content);
      // The 16KB window lands entirely inside the huge final entry (no
      // complete line); the bounded fallback read must still surface its
      // status instead of leaving the poller on a stale value.
      expect(readTranscriptStatusSync(file)).toBe('completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces the status of a final entry larger than the old 1 MiB fallback bound', () => {
    // OMP search turns end with a final message embedding the whole search
    // dump. At the old 1 MiB bound such an entry yielded no status, the
    // poller wrote nothing, and the tab stayed frozen on its last status.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tail-'));
    try {
      const file = path.join(dir, 't.jsonl');
      const dump = 'x'.repeat(1.2 * 1024 * 1024);
      const finalEntry = JSON.stringify({
        type: 'message',
        message: { role: 'assistant', stopReason: 'stop', content: dump },
      });
      const content = `${[
        header('s1', '/proj'),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'search again' } }),
        JSON.stringify({ type: 'custom', customType: 'tool_execution_start', data: { toolName: 'grep' } }),
        JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'grep', content: dump } }),
        finalEntry,
      ].join('\n')}\n`;
      fs.writeFileSync(file, content);
      // The entry exceeds 1 MiB and fills both the 16KB window and (at the
      // old bound) the fallback read; the widened window must parse it.
      expect(finalEntry.length).toBeGreaterThan(1024 * 1024);
      expect(readTranscriptStatusSync(file)).toBe('completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transcriptStatusFromTail cancellation (PO-04)', () => {
  it('maps a cancelled assistant turn (aborted) to waiting, not working', () => {
    expect(transcriptStatusFromTail(assistant('aborted'))).toBe('waiting');
    expect(transcriptStatusFromTail([userMsg(), assistant('aborted')].join('\n'))).toBe('waiting');
  });

  it('resumes normally on the next turn: working, then completed on its clean stop', () => {
    const cancelled = [userMsg(), assistant('aborted')].join('\n');
    expect(transcriptStatusFromTail(cancelled)).toBe('waiting');
    const nextTurn = [userMsg(), assistant('aborted'), userMsg()].join('\n');
    expect(transcriptStatusFromTail(nextTurn)).toBe('working');
    const nextTurnDone = [userMsg(), assistant('aborted'), userMsg(), assistant('stop')].join('\n');
    expect(transcriptStatusFromTail(nextTurnDone)).toBe('completed');
  });
});

const sessionExitWith = (data: Record<string, unknown>) =>
  JSON.stringify({ type: 'custom', customType: 'session_exit', data });

describe('sessionExitReasonFromTail', () => {
  it('preserves the exit marker timestamp for launch-time correlation', () => {
    const marker = JSON.stringify({ type: 'custom', customType: 'session_exit', timestamp: '2026-10-03T10:00:00.000Z', data: { reason: 'sighup', kind: 'signal' } });
    expect(sessionExitReasonFromTail(marker)).toEqual({ reason: 'sighup', kind: 'signal', timestamp: '2026-10-03T10:00:00.000Z' });
  });
  it('extracts reason and kind from a trailing session_exit', () => {
    const tail = [
      assistant('toolUse'),
      sessionExitWith({
        reason: 'unhandled_rejection',
        kind: 'fatal',
        pendingToolCalls: [{ tool: 'bash', callId: 'c1' }],
      }),
    ].join('\n');
    expect(sessionExitReasonFromTail(tail)).toEqual({ reason: 'unhandled_rejection', kind: 'fatal' });
  });

  it('falls back to unknown when the session_exit has no data', () => {
    expect(sessionExitReasonFromTail(sessionExit())).toEqual({ reason: 'unknown' });
  });

  it('falls back to unknown for a missing reason and omits an absent kind', () => {
    expect(sessionExitReasonFromTail(sessionExitWith({ kind: 'fatal' }))).toEqual({ reason: 'unknown', kind: 'fatal' });
    expect(sessionExitReasonFromTail(sessionExitWith({ reason: 'oom' }))).toEqual({ reason: 'oom' });
  });

  it('returns null when the last parseable line is not a session_exit', () => {
    const tail = [sessionExit(), assistant('stop')].join('\n');
    expect(sessionExitReasonFromTail(tail)).toBeNull();
  });

  it('reports the reason across crash-flush appends written after the marker', () => {
    // Live OMP transcripts append the pending tool-call flush AFTER the
    // marker (an isError "Operation aborted" toolResult and a
    // tool_execution_start), so the marker is not the last line.
    const tail = [
      sessionExitWith({ reason: 'unhandled_rejection', kind: 'fatal' }),
      JSON.stringify({
        type: 'custom',
        customType: 'tool_execution_start',
        data: { toolCallId: 'c1', toolName: 'wait' },
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'toolResult', toolName: 'wait', content: [{ type: 'text', text: 'Operation aborted' }], isError: true },
      }),
    ].join('\n');
    expect(sessionExitReasonFromTail(tail)).toEqual({ reason: 'unhandled_rejection', kind: 'fatal' });
  });

  it('stops scanning at a bounded flush run', () => {
    const flushes = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ type: 'custom', customType: 'tool_execution_start', data: { toolCallId: `c${i}` } }),
    );
    const tail = [sessionExit(), ...flushes].join('\n');
    expect(sessionExitReasonFromTail(tail)).toBeNull();
  });

  it('returns null when there is no session_exit at all', () => {
    expect(sessionExitReasonFromTail(assistant('stop'))).toBeNull();
    expect(sessionExitReasonFromTail(null)).toBeNull();
    expect(sessionExitReasonFromTail('not json at all')).toBeNull();
  });

  it('skips a mid-write tail line and uses the last complete line', () => {
    const tail = [sessionExitWith({ reason: 'oom' }), '{"type":"custom","customType":"sess'].join('\n');
    expect(sessionExitReasonFromTail(tail)).toEqual({ reason: 'oom' });
  });
});

describe('readSessionExitReasonSync', () => {
  it('reads the reason from a transcript ending in session_exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-exit-'));
    try {
      const file = path.join(dir, 't.jsonl');
      const content = `${[
        header('s1', '/proj'),
        assistant('stop'),
        sessionExitWith({ reason: 'unhandled_rejection', kind: 'fatal' }),
      ].join('\n')}\n`;
      fs.writeFileSync(file, content);
      expect(readSessionExitReasonSync(file)).toEqual({ reason: 'unhandled_rejection', kind: 'fatal' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file and for a transcript without session_exit', () => {
    expect(readSessionExitReasonSync(path.join(os.tmpdir(), 'vb-no-such-transcript.jsonl'))).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-exit-'));
    try {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, `${[header('s1', '/proj'), assistant('stop')].join('\n')}\n`);
      expect(readSessionExitReasonSync(file)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures a session_exit whose final line is larger than the tail window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-exit-'));
    try {
      const file = path.join(dir, 't.jsonl');
      const hugeExit = JSON.stringify({
        type: 'custom',
        customType: 'session_exit',
        data: {
          reason: 'unhandled_rejection',
          kind: 'fatal',
          pendingToolCalls: 'x'.repeat(TAIL_READ_BYTES + 4096),
        },
      });
      expect(hugeExit.length).toBeGreaterThan(TAIL_READ_BYTES);
      const content = `${[header('s1', '/proj'), assistant('stop'), hugeExit].join('\n')}\n`;
      fs.writeFileSync(file, content);
      // The 16KB window lands entirely inside the huge final line (no
      // complete line to parse); the bounded fallback read must still
      // surface the reason.
      expect(readSessionExitReasonSync(file)).toEqual({ reason: 'unhandled_rejection', kind: 'fatal' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
