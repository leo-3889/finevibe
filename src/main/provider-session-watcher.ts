import type { ProviderId } from '../shared/types';
import { createCompatibleSessionWatcher } from './pi-compatible-session-watcher';
import type { CompatibleSessionWatcher } from './pi-compatible-session-watcher';
import { registerTranscriptSync } from './session-transcript-sync';

/**
 * Shared wrapper skeleton for the per-provider Pi-compatible session
 * watchers (see pi-session-watcher.ts / omp-session-watcher.ts — thin
 * named wrappers over one implementation, mirroring the
 * providers/pi-compatible-transcripts.ts idiom).
 *
 * The only thing a provider-specific watcher adds on top of the shared
 * compatible watcher is the post-adoption wiring: every adopted session
 * is handed to the merged transcript-sync module under the provider's id,
 * which mirrors the CLI's title into the `.name` channel and the derived
 * status into the `.status` channel the tab adopts.
 */
export function createProviderSessionWatcher(providerId: ProviderId): CompatibleSessionWatcher {
  return createCompatibleSessionWatcher({
    onAdopted: (uiSessionId, cliSessionId, projectPath, configDir, sessionDir) => {
      registerTranscriptSync(uiSessionId, providerId, cliSessionId, projectPath, configDir, { sessionDir });
    },
  });
}
