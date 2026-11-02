import { createPiCompatibleProvider } from './pi-compatible-provider';
import { ompSessionsRoot, readTranscriptTitleSync } from './omp-transcripts';
import { startOmpSessionWatcher, registerPendingOmpSession, unregisterOmpSession, stopOmpSessionWatcher } from '../omp-session-watcher';

/**
 * OMP (Oh my Pi) — a Pi fork that is Pi-compatible on disk, so the shared
 * launch/transcript behavior lives in providers/pi-compatible-provider.ts.
 * This names OMP's own deltas:
 *
 *  - Binary `omp`, agent tree `~/.omp/agent` (it honors Pi's
 *    PI_CODING_AGENT_DIR), transcripts in `<agentDir>/sessions`, and its own
 *    `OMP_PROFILE` selector on top of Pi's (`extraEnvKeysToRemove`).
 *  - No `--session-id` flag: the CLI generates the id, so a fresh launch is
 *    owned by its exclusive `--session-dir` alone and the watcher adopts the
 *    first transcript that appears there. Resumes use `--resume <path|id>`.
 *  - Config is `config.yml` (YAML): nothing the ProviderConfig shape can
 *    surface without a parser, so `mcpConfigDir` stays unset, which also
 *    clears the `configReading` capability.
 *  - Title lives in the transcript head (`type:"title"`, mirrored into the
 *    session header), not in Pi's `session_info` entries.
 */
export class OmpProvider extends createPiCompatibleProvider({
  id: 'omp',
  displayName: 'Oh my Pi',
  binaryName: 'omp',
  watcher: {
    start: startOmpSessionWatcher,
    registerPending: registerPendingOmpSession,
    unregister: unregisterOmpSession,
    stop: stopOmpSessionWatcher,
  },
  sessionsRoot: ompSessionsRoot,
  mcpConfigDir: undefined,
  readTitle: readTranscriptTitleSync,
  pinsSessionId: false,
  resumeFlag: '--resume',
  discoverSharedRoots: true,
  extraEnvKeysToRemove: ['OMP_PROFILE'],
  // Verified live on omp/18.12.3 (2026-10-21): `omp --help` advertises
  // `--plan-yolo` as "Force read-only plan mode at start", and a real spawn
  // enforced it — a write-tool attempt was refused ("Plan mode is active…
  // the write tool is restricted to local:// planning artifacts") with no file
  // created. omp exits on unknown flags, so the flag's acceptance is proof it
  // exists. Caveats: --plan-yolo auto-approves the plan on the model's first
  // resolve call, then hands off to `--plan-yolo-into` (default the `@smol`
  // role), which must have auth at startup — the spawn fails at startup
  // otherwise ("No API key for …"). `--plan <model>` is the plan-role model
  // selector, NOT plan mode; `--config` takes an overlay FILE path (no inline
  // key=value); `plan.defaultOnStartup` is the verified config key behind the
  // config-dir fallback route (omp config get → false).
  planModeArg: '--plan-yolo',
}) {}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  OmpProvider.resetBinaryCache();
}
