import type { RegisterPendingOptions } from './pi-compatible-session-watcher';
import { createProviderSessionWatcher } from './provider-session-watcher';

/**
 * OMP has no hook system to report session IDs back to the host app.
 * Thin named wrapper over the shared provider watcher skeleton (see
 * provider-session-watcher.ts + pi-compatible-session-watcher.ts). Every
 * launch runs with its own `--session-dir`, so ownership is
 * process-scoped: the watcher adopts a transcript by its exclusive
 * directory (and, when the id is known up front, by exact id). OMP
 * self-titles and has no status hooks, so every adopted session is handed
 * to the merged transcript-sync module under the 'omp' provider id.
 */
const watcher = createProviderSessionWatcher('omp');

export function startOmpSessionWatcher(): void {
  watcher.start();
}

export function registerPendingOmpSession(sessionId: string, projectPath: string, configDir: string | undefined, opts?: RegisterPendingOptions): void {
  watcher.registerPending(sessionId, projectPath, configDir, opts);
}

export function unregisterOmpSession(sessionId: string): void {
  watcher.unregister(sessionId);
}

export function stopOmpSessionWatcher(): void {
  watcher.stop();
}
