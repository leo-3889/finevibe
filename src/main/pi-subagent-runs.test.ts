import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { hasActiveSubagentRun } from './pi-subagent-runs';

const PARENT = path.join(os.tmpdir(), 'vb-parent', 'session.jsonl');
const OTHER = path.join(os.tmpdir(), 'vb-parent', 'other.jsonl');

interface FakeRun {
  state?: string;
  sessionId?: string;
  lastUpdate?: number;
  /** Write no status.json at all — only the `.active-runs` marker. */
  markerOnly?: boolean;
  /** Age the marker file (mtime) to this ms timestamp. */
  markerMtimeMs?: number;
}

/** Build a `<root>/async-subagent-runs` tree shaped like the extension's. */
function makeRoot(runs: Record<string, FakeRun>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-pisub-'));
  const runsDir = path.join(root, 'async-subagent-runs');
  fs.mkdirSync(path.join(runsDir, '.active-runs'), { recursive: true });
  for (const [runId, run] of Object.entries(runs)) {
    const marker = path.join(runsDir, '.active-runs', runId);
    fs.writeFileSync(marker, '');
    if (run.markerMtimeMs !== undefined) fs.utimesSync(marker, new Date(), new Date(run.markerMtimeMs));
    if (run.markerOnly) continue;
    fs.mkdirSync(path.join(runsDir, runId), { recursive: true });
    fs.writeFileSync(path.join(runsDir, runId, 'status.json'), JSON.stringify({
      runId,
      sessionId: run.sessionId ?? PARENT,
      state: run.state ?? 'running',
      lastUpdate: run.lastUpdate ?? Date.now(),
    }));
  }
  return root;
}

let root: string | null = null;
let savedOverride: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
  if (savedOverride === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  else process.env.PI_SUBAGENTS_TEMP_ROOT = savedOverride;
});

function check(runs: Record<string, FakeRun>, target = PARENT, now = Date.now()): boolean {
  root = makeRoot(runs);
  savedOverride = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  return hasActiveSubagentRun(target, now);
}

describe('hasActiveSubagentRun', () => {
  it('counts a running child of this transcript', () => {
    expect(check({ r1: { state: 'running' } })).toBe(true);
    expect(check({ r1: { state: 'queued' } })).toBe(true);
  });

  it('ignores terminal runs and other sessions', () => {
    expect(check({ r1: { state: 'complete' } })).toBe(false);
    expect(check({ r1: { state: 'failed' } })).toBe(false);
    expect(check({ r1: { sessionId: OTHER } })).toBe(false);
  });

  it('ages out a run whose status stopped updating (a killed child)', () => {
    const stale = Date.now() - 11 * 60 * 1000;
    expect(check({ r1: { lastUpdate: stale } })).toBe(false);
    expect(check({ r1: { lastUpdate: stale } }, PARENT, stale + 60_000)).toBe(true);
  });

  it('falls back to the marker mtime when status.json is missing', () => {
    expect(check({ r1: { markerOnly: true } })).toBe(true);
    expect(check({ r1: { markerOnly: true, markerMtimeMs: Date.now() - 11 * 60 * 1000 } })).toBe(false);
  });

  it('skips the tool-call alias directory', () => {
    expect(check({ 'tool-calls': { state: 'running' }, r2: { state: 'complete' } })).toBe(false);
  });

  it('is false when the extension has written no state at all', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-pisub-'));
    savedOverride = process.env.PI_SUBAGENTS_TEMP_ROOT;
    process.env.PI_SUBAGENTS_TEMP_ROOT = root;
    expect(hasActiveSubagentRun(PARENT)).toBe(false);
    expect(hasActiveSubagentRun('')).toBe(false);
  });
});

// The provider poll is where this matters: a finished parent turn + a running
// child must not surface as the completed tick.
describe('readTranscriptStatusSync holds completed for in-flight children', () => {
  it('reports working while a child runs and completes the moment it ends', async () => {
    const { readTranscriptStatusSync, _resetStatusTailCacheForTesting } = await import(
      './providers/pi-compatible-transcripts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-tail-'));
    try {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, `${[
        JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: dir }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: 'go' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } }),
      ].join('\n')}\n`);
      _resetStatusTailCacheForTesting();

      root = makeRoot({ r1: { state: 'running', sessionId: file } });
      savedOverride = process.env.PI_SUBAGENTS_TEMP_ROOT;
      process.env.PI_SUBAGENTS_TEMP_ROOT = root;

      expect(readTranscriptStatusSync(file)).toBe('working');
      // The child finishes: the marker goes away, the transcript is untouched —
      // the cached transcript status must surface as completed immediately.
      fs.rmSync(path.join(root, 'async-subagent-runs', '.active-runs', 'r1'));
      expect(readTranscriptStatusSync(file)).toBe('completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
