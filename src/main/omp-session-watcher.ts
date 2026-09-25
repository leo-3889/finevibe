import { ompSessionsRoot } from './providers/omp-transcripts';
import { createCompatibleSessionWatcher } from './pi-compatible-session-watcher';

/**
 * OMP has no hook system to report session IDs back to the host app.
 * Thin wrapper over the shared Pi-compatible watcher (see
 * pi-compatible-session-watcher.ts) parameterized with OMP's sessions root.
 */
const watcher = createCompatibleSessionWatcher(ompSessionsRoot);

export function startOmpSessionWatcher(): void {
  watcher.start();
}

export function registerPendingOmpSession(sessionId: string, projectPath: string, configDir?: string): void {
  watcher.registerPending(sessionId, projectPath, configDir);
}

export function unregisterOmpSession(sessionId: string): void {
  watcher.unregister(sessionId);
}

export function stopOmpSessionWatcher(): void {
  watcher.stop();
}
