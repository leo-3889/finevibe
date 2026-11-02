import { createPiCompatibleProvider } from './pi-compatible-provider';
import { readTranscriptTitleWithSessionInfoSync } from './pi-compatible-transcripts';
import { piAgentDir, piSessionsRoot } from './pi-transcripts';
import { startPiSessionWatcher, registerPendingPiSession, unregisterPiSession, stopPiSessionWatcher } from '../pi-session-watcher';

/**
 * Pi (pi-mono). The shared Pi-compatible launch/transcript behavior lives in
 * providers/pi-compatible-provider.ts; this names Pi's own deltas:
 *
 *  - Binary `pi`, agent dir `~/.pi/agent` (relocated via PI_CODING_AGENT_DIR),
 *    transcripts in `<agentDir>/sessions`, config surface `mcp.json`.
 *  - Fresh launches pin a FineVibe-generated id with `--session-id`; resumes
 *    use `--session <path|id>`.
 *  - Global search enumerates the shared `~/.pi/agent` corpus — Pi owns it,
 *    including sessions a terminal `pi-bolt` run writes into the same tree.
 *  - Plan mode: permanent non-support. The Pi author states it as an explicit
 *    non-goal (pi-mono blog + README): "pi does not and will not have a
 *    built-in plan mode", so `planModeArg` stays unset and the UI shows a
 *    disabled checkbox with a tooltip.
 */
export class PiProvider extends createPiCompatibleProvider({
  id: 'pi',
  displayName: 'Pi',
  binaryName: 'pi',
  watcher: {
    start: startPiSessionWatcher,
    registerPending: registerPendingPiSession,
    unregister: unregisterPiSession,
    stop: stopPiSessionWatcher,
  },
  sessionsRoot: piSessionsRoot,
  mcpConfigDir: piAgentDir,
  readTitle: readTranscriptTitleWithSessionInfoSync,
  pinsSessionId: true,
  resumeFlag: '--session',
  discoverSharedRoots: true,
}) {}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  PiProvider.resetBinaryCache();
}
