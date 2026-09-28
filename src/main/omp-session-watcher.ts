import { ompSessionsRoot } from './providers/omp-transcripts';
import { createCompatibleSessionWatcher } from './pi-compatible-session-watcher';
import { registerTranscriptSync } from './session-transcript-sync';

/**
 * OMP has no hook system to report session IDs back to the host app.
 * Thin wrapper over the shared Pi-compatible watcher (see
 * pi-compatible-session-watcher.ts) parameterized with OMP's sessions root.
 * OMP self-titles and has no status hooks, so every adopted session is
 * handed to the merged transcript-sync module, which mirrors the CLI's
 * title into the `.name` channel and the derived status into the `.status`
 * channel the tab adopts.
 */
const watcher = createCompatibleSessionWatcher(ompSessionsRoot, {
  onAdopted: (uiSessionId, cliSessionId, projectPath, configDir) => {
    registerTranscriptSync(uiSessionId, 'omp', cliSessionId, projectPath, configDir);
  },
});

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
