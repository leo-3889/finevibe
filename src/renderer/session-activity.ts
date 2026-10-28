import { STOP_INFLIGHT_TRUST_MS } from '../shared/constants';
import type { CliSessionStatus, InspectorEvent } from '../shared/types';
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'completed' | 'input';

/**
 * The typographic glyph shown for each status (replaces the colored dot).
 * Simple punctuation, not emoji: themeable via CSS color and identical across
 * platforms. `waiting` and `input` share "?" (both mean "your turn") and are
 * told apart by color, as the old dots were.
 */
export const STATUS_GLYPH: Record<SessionStatus, string> = {
  working: '…',
  waiting: '?',
  input: '?',
  completed: '✓',
  idle: '·',
};

type StatusChangeCallback = (sessionId: string, status: SessionStatus) => void;

interface SessionState {
  status: SessionStatus;
  interrupted: boolean;
}

const sessions = new Map<string, SessionState>();
const listeners: StatusChangeCallback[] = [];

// Backstop for the subagent-aware Stop hook (see stop_status_writer.py). When
// that hook judges work is still in flight it writes `Stop:working` instead of
// `Stop:completed`. If that in-flight signal is ever wrong the session would
// sit in 'working' forever and the real completion would never be notified.
//
// Both of the hook's branches can be wrong, in different ways:
//   - `background_tasks` (preferred): a subagent/teammate/workflow entry that
//     hangs around in the task registry holds the session indefinitely, and the
//     payload carries no per-task timestamp to age it out — so this backstop is
//     the *only* escape hatch on that path.
//   - the legacy <sid>.subagents counter (fallback, older CLIs): a lost
//     SubagentStop, a race between concurrent subagent hooks, or an
//     auto-compact SessionStart reset can leave the count too high.
//
// So: arm a fallback whenever a Stop resolves to 'working'; if the session then
// goes silent, complete it. Any later hook event counts as activity and cancels
// the pending fallback. The window matches the hook-side staleness guard
// (STOP_STALE_MS).
const STOP_FALLBACK_MS = STOP_INFLIGHT_TRUST_MS;
const stopFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearStopFallback(sessionId: string): void {
  const timer = stopFallbackTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    stopFallbackTimers.delete(sessionId);
  }
}

function armStopFallback(sessionId: string): void {
  stopFallbackTimers.set(sessionId, setTimeout(() => {
    stopFallbackTimers.delete(sessionId);
    const st = sessions.get(sessionId);
    if (st && st.status === 'working') {
      clearInFlight(sessionId);
      setStatus(sessionId, 'completed');
    }
  }, STOP_FALLBACK_MS));
}

/**
 * Children a session is still waiting on, keyed by `agent_id` (a repeated
 * SubagentStart for the same id is one child, not two). Fed from the inspector
 * event stream — the one signal every hook-based provider emits (Claude, Codex,
 * Copilot and Gemini all log SubagentStart/SubagentStop into `.events`).
 *
 * While the set is non-empty a `completed` is a lie: the model paused on its
 * children and will produce more output, so `completed` is held back (glyph
 * stays '…', and the Kanban auto-Done does not fire) and released when the last
 * child stops.
 *
 * Self-healing: a parent-side terminal event (`stop` / `stop_failure` /
 * `session_end`) clears the set — the hook-side Stop writer has already judged
 * nothing to be in flight, and a lost SubagentStop must not wedge the session
 * in 'working'; the same STOP_FALLBACK backstop covers a silent child.
 */
const inFlight = new Map<string, Set<string>>();
const pendingCompleted = new Set<string>();

function clearInFlight(sessionId: string): void {
  inFlight.delete(sessionId);
  pendingCompleted.delete(sessionId);
}

/** Feed the in-flight child set from a session's inspector events. */
export function noteInspectorEvents(sessionId: string, events: readonly InspectorEvent[]): void {
  const inflight = () => inFlight.get(sessionId)?.size ?? 0;
  for (const ev of events) {
    if (ev.type === 'subagent_start') {
      const set = inFlight.get(sessionId) ?? new Set<string>();
      // ponytail: id-less starts are a legacy-payload edge case; one key each.
      set.add(ev.agent_id || `#${set.size}`);
      inFlight.set(sessionId, set);
    } else if (ev.type === 'subagent_stop') {
      const set = inFlight.get(sessionId);
      if (!set) continue;
      set.delete(ev.agent_id || '');
      if (!set.size) inFlight.delete(sessionId);
    } else if (ev.type === 'stop' || ev.type === 'stop_failure'
      || ev.type === 'session_end' || ev.type === 'user_prompt') {
      clearInFlight(sessionId);
    }
  }
  if (inflight() || !pendingCompleted.has(sessionId)) return;
  pendingCompleted.delete(sessionId);
  const st = sessions.get(sessionId);
  if (st && st.status === 'working') setStatus(sessionId, 'completed');
}

function setStatus(sessionId: string, status: SessionStatus): void {
  const state = sessions.get(sessionId);
  if (!state || state.status === status) return;
  state.status = status;
  for (const cb of listeners) cb(sessionId, status);
}

/**
 * Called when a hook-based status event is received from the main process.
 */
export function setHookStatus(sessionId: string, status: CliSessionStatus, hookName?: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;  // Ignore events for sessions not managed by FineVibe

  // Any hook event is fresh activity — cancel a pending Stop fallback. It is
  // re-armed below only if this event is itself a Stop that resolved to 'working'.
  clearStopFallback(sessionId);

  // Don't let a hook Stop/StopFailure ('waiting') overwrite a just-set
  // 'completed' status. Completed is sticky until a new prompt ('working')
  // or PTY exit ('idle'). NOT applied to polled (Transcript) status: there
  // the transcript tail is authoritative, and a `waiting` after `completed`
  // is a real error the poller caught (the guard would otherwise mask it —
  // the poll can miss the intermediate `working` on a fast user→error).
  if (status === 'waiting' && state.status === 'completed' && hookName !== 'Transcript') return;

  // UserPromptSubmit is a deliberate new user action — always clears the interrupt flag.
  if (hookName === 'UserPromptSubmit') state.interrupted = false;

  // Ignore stale 'working' hooks that arrive after an interrupt (e.g. PostToolUse
  // firing after the user pressed Escape and we already transitioned to 'waiting').
  // NOT applied to polled (Transcript) status: pi/pi-bolt/omp have no
  // UserPromptSubmit hook to clear the flag, so a fresh polled 'working' IS the
  // evidence of the user's new prompt (the poller only re-emits on transcript
  // appends). Same rationale as the Transcript exemption above.
  if (status === 'working' && state.interrupted && hookName !== 'Transcript') return;

  // Any non-working hook clears the interrupt flag (CLI reached a definitive state).
  if (status !== 'working') state.interrupted = false;

  // A completion while children are still running is not a completion: show
  // 'working' and let the last subagent_stop (or the backstop below) release it.
  if (status === 'completed' && (inFlight.get(sessionId)?.size ?? 0) > 0) {
    pendingCompleted.add(sessionId);
    setStatus(sessionId, 'working');
    armStopFallback(sessionId);
    return;
  }
  pendingCompleted.delete(sessionId);

  setStatus(sessionId, status);

  // A Stop that resolved to 'working' means the subagent-aware hook is holding
  // the session open for in-flight subagents. Arm the backstop so a wrong
  // in-flight signal can't wedge the session in 'working' indefinitely.
  if (hookName === 'Stop' && status === 'working' && sessions.get(sessionId)?.status === 'working') {
    armStopFallback(sessionId);
  }
}

export function initSession(sessionId: string): void {
  clearInFlight(sessionId);
  sessions.set(sessionId, { status: 'waiting', interrupted: false });
  for (const cb of listeners) cb(sessionId, 'waiting');
}

export function notifyInterrupt(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state || state.status !== 'working') return;
  state.interrupted = true;
  setStatus(sessionId, 'waiting');
}

export function setIdle(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  clearStopFallback(sessionId);
  clearInFlight(sessionId);
  setStatus(sessionId, 'idle');
}

export function removeSession(sessionId: string): void {
  clearStopFallback(sessionId);
  clearInFlight(sessionId);
  sessions.delete(sessionId);
}

export function getStatus(sessionId: string): SessionStatus {
  return sessions.get(sessionId)?.status ?? 'idle';
}

export function onChange(callback: StatusChangeCallback): () => void {
  listeners.push(callback);
  return () => {
    const idx = listeners.indexOf(callback);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  for (const timer of stopFallbackTimers.values()) clearTimeout(timer);
  stopFallbackTimers.clear();
  inFlight.clear();
  pendingCompleted.clear();
  sessions.clear();
  listeners.length = 0;
}
