import { createCompatibleSessionWatcher } from './pi-compatible-session-watcher';
import type { RegisterPendingOptions } from './pi-compatible-session-watcher';
import { registerTranscriptSync } from './session-transcript-sync';

/**
 * Pi-Bolt (the AOT-compiled fork of Pi) has no hook system to report session
 * IDs back to the host app, and — being a Pi fork built from Pi v1.4.0 — it
 * writes the same transcript format into the same `~/.pi/agent` tree Pi uses.
 *
 * Thin wrapper over the shared Pi-compatible watcher (see
 * pi-compatible-session-watcher.ts), registered under the `pi-bolt` provider
 * id. Every launch runs with its own `--session-dir`, so ownership is
 * process-scoped: the watcher adopts a transcript by its exclusive directory
 * (and, when the id is known up front, by exact id) — the shared tree is safe
 * to watch because adoption is keyed by the launch dir, not the provider.
 * `registerTranscriptSync` mirrors BOTH title and status for Pi-Bolt: it
 * declares `selfTitles: true` and reads the CLI's `session_info` name (set
 * via `--name`, `/name`, or extensions calling `pi.setSessionName()`), so a
 * tab adopts the CLI session name and keeps it across a restart (the
 * restored-session title-only mirror, see docs/session-lifecycle.md).
 */
const watcher = createCompatibleSessionWatcher({
  onAdopted: (uiSessionId, cliSessionId, projectPath, configDir, sessionDir) =>
    registerTranscriptSync(uiSessionId, 'pi-bolt', cliSessionId, projectPath, configDir, { sessionDir }),
});

export function startPiBoltSessionWatcher(): void {
  watcher.start();
}

export function registerPendingPiBoltSession(sessionId: string, projectPath: string, configDir: string | undefined, opts?: RegisterPendingOptions): void {
  watcher.registerPending(sessionId, projectPath, configDir, opts);
}

export function unregisterPiBoltSession(sessionId: string): void {
  watcher.unregister(sessionId);
}

export function stopPiBoltSessionWatcher(): void {
  watcher.stop();
}
