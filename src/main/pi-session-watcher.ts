import type { RegisterPendingOptions } from './pi-compatible-session-watcher';
import { createProviderSessionWatcher } from './provider-session-watcher';

/**
 * Pi has no hook system to report session IDs back to the host app.
 * Thin named wrapper over the shared provider watcher skeleton (see
 * provider-session-watcher.ts + pi-compatible-session-watcher.ts). Every
 * launch runs with its own `--session-dir`, so ownership is
 * process-scoped: the watcher adopts a transcript by its exclusive
 * directory (and, when the id is known up front, by exact id). Every
 * adopted session is handed to the merged transcript-sync module under
 * the 'pi' provider id.
 */
const watcher = createProviderSessionWatcher('pi');

export function startPiSessionWatcher(): void {
  watcher.start();
}

export function registerPendingPiSession(sessionId: string, projectPath: string, configDir: string | undefined, opts?: RegisterPendingOptions): void {
  watcher.registerPending(sessionId, projectPath, configDir, opts);
}

export function unregisterPiSession(sessionId: string): void {
  watcher.unregister(sessionId);
}

export function stopPiSessionWatcher(): void {
  watcher.stop();
}
