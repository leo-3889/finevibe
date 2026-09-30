import { piSessionsRoot } from './providers/pi-transcripts';
import { createCompatibleSessionWatcher } from './pi-compatible-session-watcher';
import { registerTranscriptSync } from './session-transcript-sync';

/**
 * Pi has no hook system to report session IDs back to the host app.
 * Thin wrapper over the shared Pi-compatible watcher (see
 * pi-compatible-session-watcher.ts) parameterized with Pi's sessions root.
 */
const watcher = createCompatibleSessionWatcher(piSessionsRoot, {
  onAdopted: (uiSessionId, cliSessionId, projectPath, configDir) =>
    registerTranscriptSync(uiSessionId, 'pi', cliSessionId, projectPath, configDir),
});

export function startPiSessionWatcher(): void {
  watcher.start();
}

export function registerPendingPiSession(sessionId: string, projectPath: string, configDir?: string): void {
  watcher.registerPending(sessionId, projectPath, configDir);
}

export function unregisterPiSession(sessionId: string): void {
  watcher.unregister(sessionId);
}

export function stopPiSessionWatcher(): void {
  watcher.stop();
}
