// Transient per-session SSH connection registry (renderer side of the
// `session:sshStatus` channel; plan: todos/ssh-session-name-prefix-plan.md §2.3,
// modeled on session-activity.ts). Live state only — never persisted: the
// SessionRecord.sshHost *setting* persists, the connection state does not
// (C5R-01 precedent: nothing transient survives hydrate).
//
// Producers:
//   - 'explicit': the user set/cleared the session's ssh host (session menu);
//   - 'spawned':  main launched the session through `ssh -tt <host>` (P3);
//   - 'detected': main's PTY output scanner saw `ssh <host>` typed in the
//     session's terminal (P2), forwarded via session:sshStatus.
// Precedence: a weaker source never overwrites a stronger one (rank below);
// equal sources overwrite (host change / disconnect). A disconnect (null)
// always applies. The tab chrome renders `ssh <host> - ` from this registry —
// never from session.name.

import type { SshSource } from '../shared/ssh-host.js';

export type { SshSource };

export interface SshState {
  host: string;
  source: SshSource;
}

type SshChangeCallback = (sessionId: string, state: SshState | null) => void;

const RANK: Record<SshSource, number> = { detected: 0, spawned: 1, explicit: 2 };

const sessions = new Map<string, SshState>();

/** Plain-text `ssh <host> - ` prefix (panels/notifications; tabs use the HTML form). */
export function sshPrefixText(state: SshState | null): string {
  return state ? `ssh ${state.host} - ` : '';
}

const listeners: SshChangeCallback[] = [];

/**
 * Publish the live SSH state of a session; `null` = disconnected.
 * A `detected` state is ignored while an `explicit`/`spawned` state is active
 * (the user's setting or the actual launch beats a terminal-scanner guess);
 * `explicit` overwrites `spawned` (the user just re-pointed the session).
 */
export function setSshStatus(sessionId: string, state: SshState | null): void {
  const current = sessions.get(sessionId);
  if (state) {
    if (current && RANK[state.source] < RANK[current.source]) return;
    if (current && current.source === state.source && current.host === state.host) return;
    sessions.set(sessionId, state);
  } else {
    if (!current) return;
    sessions.delete(sessionId);
  }
  for (const cb of listeners) cb(sessionId, state);
}

export function getSshStatus(sessionId: string): SshState | null {
  return sessions.get(sessionId) ?? null;
}

/** Drop the session's live entry (PTY exit / session removal). */
export function removeSshSession(sessionId: string): void {
  setSshStatus(sessionId, null);
}

export function onSshChange(callback: SshChangeCallback): () => void {
  listeners.push(callback);
  return () => {
    const i = listeners.indexOf(callback);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** @internal Test-only: reset all module state */
export function _resetSshForTesting(): void {
  sessions.clear();
  listeners.length = 0;
}
