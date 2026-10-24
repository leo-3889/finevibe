// PTY-output SSH detection (P2 of todos/ssh-session-name-prefix-plan.md).
//
// A user who types `ssh <host>` inside a session's terminal is invisible to
// the app until this scanner sees it: every PTY data chunk (pty-manager's
// onData, before the ipc-handlers coalescing send) is fed through
// `observePtyOutput`, which recognizes the command echo and the OSC title an
// SSH-connected shell sets, and publishes the session's live host via the
// `.ssh` sidecar (hook-status.writeSshStatus → `session:sshStatus`).
//
// The chunk bytes are attacker-influenced (anything the terminal emits), so
// every candidate host passes `parseSshHost` before it can be published —
// the same gate the explicit setting and the ssh argv use.
//
// Honest limits (plan §4-R2): the command-echo heuristic shows the typed
// token, not the resolved host — `~/.ssh/config` aliases, `mosh`, and
// jump-host chains (`-J`) all surface whatever was typed; a remote shell
// that never sets an OSC title still connects on the echo alone.

import { parseSshHost } from '../shared/ssh-host';
import { writeSshStatus } from './hook-status';

/** Cap on tracked sessions; oldest is evicted FIFO (the fs-utils.ts idiom). */
export const MAX_SSH_SCAN_SESSIONS = 256;
/** A detected connection older than this is dropped when new output arrives. */
export const DETECTED_SSH_TTL_MS = 60 * 60_000;
/** Window in which an OSC title corroborates (or contradicts) a fresh echo. */
const ECHO_CORROBORATION_MS = 10_000;
/** Cap for the unterminated-line buffer (binary bursts must not grow it). */
const MAX_PARTIAL_BYTES = 8192;

interface ScanState {
  /** Unterminated tail of the last chunk, prepended to the next one. */
  partial: string;
  /** Host currently published for this session, null = not connected. */
  host: string | null;
  /** Timestamp of the last accepted evidence for `host`. */
  since: number;
}

const states = new Map<string, ScanState>();
// Insertion order drives FIFO eviction; Map keeps it, but the eviction is
// applied on insert so an evicted session's row is the oldest ever touched.
const insertOrder: string[] = [];

/**
 * The command echo: `ssh [flags] [user@]host` at line start (the line the
 * shell echoes when Enter is pressed). The flag group consumes `-p 2221`
 * as a pair so the port is never mistaken for the host; a port suffix
 * (`host:22`) never matches — the character class excludes `:` and the
 * trailing boundary demands whitespace or EOL — mirroring parseSshHost's
 * port rejection.
 */
const SSH_COMMAND_RE = /^ssh\s+(?:-(?:p\s+\d+|\S+)\s+)*([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+)(?:\s|$)/;
/**
 * The same command after a shell prompt on the echoed line
 * (`/path/to/project $ ssh host`): the prompt's `$ ` / `# ` / `% ` is the
 * "fresh prompt" the plan's heuristic requires.
 */
const SSH_AFTER_PROMPT_RE = /[#$]\s+ssh\s+(?:-(?:p\s+\d+|\S+)\s+)*([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]+)(?:\s|$)/;
/** OSC 0/2 title set: `ESC ] 0|2 ; text BEL` or `... ESC \`. */
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** A `user@host` prefix inside an OSC title. */
const TITLE_USER_HOST_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/;
/** ANSI CSI sequences and single-char escapes, stripped before line matching. */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[=>7Mc])/g;

function evictIfNeeded(): void {
  while (insertOrder.length > MAX_SSH_SCAN_SESSIONS) {
    const oldest = insertOrder.shift();
    if (oldest !== undefined) states.delete(oldest);
  }
}

/** The `user@host` (or bare host) a command line names, or null. */
function commandHost(line: string, re: RegExp): string | null {
  const m = re.exec(line);
  if (!m) return null;
  const raw = m[1] ? `${m[1]}${m[2]}` : m[2];
  return parseSshHost(raw)?.host ?? null;
}

/** The `user@host` an OSC title advertises, or null (e.g. a plain dir title). */
function titleHost(title: string): string | null {
  const m = TITLE_USER_HOST_RE.exec(title);
  if (!m) return null;
  return parseSshHost(`${m[1]}@${m[2]}`)?.host ?? null;
}

function oscTitles(chunk: string): string[] {
  const titles: string[] = [];
  OSC_TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC_TITLE_RE.exec(chunk)) !== null) titles.push(m[1]);
  return titles;
}

/**
 * Feed one PTY data chunk. Returns the new published state when it changed
 * (writing the `.ssh` sidecar), or null when the state stands.
 */
export function observePtyOutput(sessionId: string, chunk: string, now = Date.now()): { host: string | null } | null {
  let state = states.get(sessionId);
  if (!state) {
    state = { partial: '', host: null, since: 0 };
    states.set(sessionId, state);
    insertOrder.push(sessionId);
    evictIfNeeded();
  }

  const titles = oscTitles(chunk);
  const plain = chunk.replace(ANSI_RE, '');
  const buf = state.partial + plain;
  const lines = buf.split(/\r\n|\n|\r/);
  // The last element is the unterminated tail (or '' when the chunk ended
  // on a newline); cap it so a newline-less binary burst can't grow forever.
  const tail = lines.pop() ?? '';
  state.partial = tail.length > MAX_PARTIAL_BYTES ? tail.slice(-MAX_PARTIAL_BYTES) : tail;

  let change: { host: string | null } | null = null;

  // 1. command echo on a complete line (fresh prompt or prompt-prefixed)
  for (const line of lines) {
    const echoed = commandHost(line, SSH_COMMAND_RE) ?? commandHost(line, SSH_AFTER_PROMPT_RE);
    if (echoed === null) continue;
    state.since = now;
    if (echoed !== state.host) {
      // connect, or nested `ssh otherhost` — last host wins
      change = { host: echoed };
      break;
    }
  }

  // 2. OSC title: corroborates a fresh echo, disconnects when the remote
  //    shell exits and the local title (no `user@host` or a different one)
  //    comes back after the corroboration window.
  if (!change && titles.length > 0 && state.host) {
    const last = titleHost(titles[titles.length - 1]);
    if (last === state.host) {
      state.since = now;
    } else if (now - state.since > ECHO_CORROBORATION_MS) {
      change = { host: null };
    }
  }

  // 3. TTL: an old connection with no recent evidence is dropped on the
  //    next chunk (a silent remote that never exits).
  if (!change && state.host && now - state.since > DETECTED_SSH_TTL_MS) {
    change = { host: null };
  }

  if (!change) return null;
  state.host = change.host;
  if (change.host) state.since = now;
  writeSshStatus(sessionId, change.host, 'detected');
  return change;
}

/** @internal Test-only: reset all scanner state. */
export function _resetSshDetectForTesting(): void {
  states.clear();
  insertOrder.length = 0;
}
