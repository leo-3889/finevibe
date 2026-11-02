import { createPiCompatibleProvider } from './pi-compatible-provider';
import { readTranscriptTitleWithSessionInfoSync } from './pi-compatible-transcripts';
import { piAgentDir, piSessionsRoot } from './pi-transcripts';
import { startPiBoltSessionWatcher, registerPendingPiBoltSession, unregisterPiBoltSession, stopPiBoltSessionWatcher } from '../pi-bolt-session-watcher';

/**
 * Pi-Bolt is the Pi coding agent compiled ahead of time to native code — a
 * fork of Pi (Pi v1.4.0) with the same commands, sessions, settings,
 * providers and extensions, and — critically — the SAME on-disk contract:
 * `~/.pi/agent` as its agent dir and Pi's transcript format. It is a
 * different *binary* (`pi-bolt`), not a different *agent*: a session it
 * writes is byte-compatible with a session Pi writes, in the same tree.
 *
 * So the only deltas from Pi are its name and its search corpus (row 27
 * collapsed the two 250-line clones onto providers/pi-compatible-provider.ts):
 *  - its own per-launch base `pi-bolt-sessions`, so FineVibe-launched Pi-Bolt
 *    sessions stay owned distinctly from Pi launches;
 *  - `discoverSharedRoots: false` — enumerating the shared `~/.pi/agent` tree
 *    here would double-list Pi's corpus (the Pi provider owns it), so
 *    Pi-Bolt's global-search corpus is ONLY the launches this app created,
 *    while a terminal Pi-Bolt run stays attributed to the Pi provider
 *    (docs/provider-contracts.md "Known limits").
 *  - Plan mode: permanent non-support, inherited from the Pi author's
 *    explicit non-goal verbatim (it is a Pi fork).
 */
export class PiBoltProvider extends createPiCompatibleProvider({
  id: 'pi-bolt',
  displayName: 'Pi-Bolt',
  binaryName: 'pi-bolt',
  watcher: {
    start: startPiBoltSessionWatcher,
    registerPending: registerPendingPiBoltSession,
    unregister: unregisterPiBoltSession,
    stop: stopPiBoltSessionWatcher,
  },
  sessionsRoot: piSessionsRoot,
  mcpConfigDir: piAgentDir,
  readTitle: readTranscriptTitleWithSessionInfoSync,
  pinsSessionId: true,
  resumeFlag: '--session',
  discoverSharedRoots: false,
}) {}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  PiBoltProvider.resetBinaryCache();
}
