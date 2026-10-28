import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { STOP_INFLIGHT_TRUST_MS } from '../shared/constants';

/**
 * Pi, Pi-Bolt and OMP run their children through the `pi-subagents` extension,
 * which keeps its async-run bookkeeping OUTSIDE the transcript, under
 * `<tmp>/pi-subagents-<scope>/async-subagent-runs/` (override:
 * `PI_SUBAGENTS_TEMP_ROOT`). While a run is queued or running it leaves a marker
 * in `.active-runs/<runId>`, and `<runId>/status.json` carries the PARENT
 * session's transcript path as `sessionId`, plus `state` and `lastUpdate`.
 *
 * The parent transcript records `stopReason: "stop"` the moment the model hands
 * off to a background run, so a transcript-only poll says `completed` — the ✓ —
 * while children are still running. This answers "is anything still in flight
 * for this transcript?" so the poll can hold `working` instead.
 *
 * Cost: called only when the transcript yields `completed`, and the poller
 * already gates reads on the transcript's (mtime,size) tuple, so an idle session
 * costs nothing and no cache is needed. Scope segments are derived (never a scan
 * of the whole temp dir), so a child spawned by a different user is simply not
 * seen — the status then stays exactly what the transcript says.
 *
 * A run whose `lastUpdate` is older than STOP_INFLIGHT_TRUST_MS — the same trust
 * window the Claude hook-side Stop writer uses — is not counted: a killed child
 * must not wedge the tab in `working`.
 */

const ACTIVE_INDEX_DIR = '.active-runs';
/** Sub-directory of the index holding tool-call aliases, not run markers. */
const TOOL_CALL_INDEX_DIR = 'tool-calls';
// ponytail: markers exist only for queued/running runs (concurrency is capped at
// single digits); the bound is a guard against a stale index, not a scaling knob.
const MAX_RUNS_SCANNED = 64;

/** Mirror of the extension's temp-scope segment (uid on POSIX, username elsewhere). */
function scopeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

function tempRootCandidates(): string[] {
  const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (override) return [path.resolve(override)];
  const roots: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined) roots.push(`uid-${uid}`);
  for (const key of ['USERNAME', 'USER', 'LOGNAME']) {
    const value = process.env[key];
    if (value) { roots.push(`user-${scopeSegment(value)}`); break; }
  }
  try { roots.push(`user-${scopeSegment(os.userInfo().username)}`); } catch { /* no user info */ }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? (() => { try { return os.homedir(); } catch { return ''; } })();
  if (home) roots.push(`home-${scopeSegment(home)}`);
  return [...new Set(roots)].map(seg => path.join(os.tmpdir(), `pi-subagents-${seg}`));
}

function normalizePath(value: string): string {
  const cleaned = path.normalize(value);
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

/** Whether one `.active-runs` marker belongs to `target` and is still fresh. */
function isLiveRun(runsDir: string, runId: string, target: string, now: number): boolean {
  let lastUpdate = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'status.json'), 'utf-8')) as
      { sessionId?: unknown; state?: unknown; lastUpdate?: unknown };
    if (raw.state !== 'queued' && raw.state !== 'running') return false;
    if (normalizePath(String(raw.sessionId ?? '')) !== target) return false;
    if (typeof raw.lastUpdate === 'number' && raw.lastUpdate > 0) lastUpdate = raw.lastUpdate;
  } catch {
    // status.json missing or mid-write: the marker's own mtime is all we have.
  }
  if (!lastUpdate) {
    try { lastUpdate = fs.statSync(path.join(runsDir, ACTIVE_INDEX_DIR, runId)).mtimeMs; } catch { return false; }
  }
  return now - lastUpdate < STOP_INFLIGHT_TRUST_MS;
}

/** True while a pi-subagents run is queued or running for this parent transcript. */
export function hasActiveSubagentRun(transcriptPath: string, now = Date.now()): boolean {
  const target = normalizePath(transcriptPath);
  if (!target) return false;
  for (const root of tempRootCandidates()) {
    const runsDir = path.join(root, 'async-subagent-runs');
    let markers: string[];
    try {
      markers = fs.readdirSync(path.join(runsDir, ACTIVE_INDEX_DIR));
    } catch {
      continue; // no extension state for this scope
    }
    for (const runId of markers.slice(0, MAX_RUNS_SCANNED)) {
      if (runId === TOOL_CALL_INDEX_DIR) continue;
      if (isLiveRun(runsDir, runId, target, now)) return true;
    }
  }
  return false;
}
