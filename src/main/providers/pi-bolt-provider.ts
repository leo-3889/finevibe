import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDiscovery } from './provider';
import type { CliProviderMeta, CliSessionStatus, McpServer, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists, validateBinaryExistsAsync } from './resolve-binary';
import { TranscriptDiscoveryScan } from './transcript-utils';
import { piAgentDir, piSessionsRoot } from './pi-transcripts';
import { findTranscriptPathSync, findTranscriptPathInFlatDir, scanFlatSessionDir, indexCompatibleTranscript, readTranscriptStatusSync, readSessionExitReasonSync, readTranscriptTitleWithSessionInfoSync } from './pi-compatible-transcripts';
import type { SessionExitReason } from './pi-compatible-transcripts';
import { startPiBoltSessionWatcher, registerPendingPiBoltSession, unregisterPiBoltSession, stopPiBoltSessionWatcher } from '../pi-bolt-session-watcher';
import { writeCliSessionId } from '../hook-status';
import { launchSessionDir, launchSessionBaseDir, ensureLaunchSessionDir, writeLaunchSessionMeta, readLaunchSessionMetaCached, listLaunchSessionDirs, profileIdForConfigDir } from '../launch-session-dir';

const binaryCache = { path: null as string | null };

/**
 * Pi-Bolt is the Pi coding agent compiled ahead of time to native code — a
 * fork of Pi (Pi v1.4.0) with the same commands, sessions, settings,
 * providers and extensions, and — critically — the SAME on-disk contract:
 * `~/.pi/agent` as its agent dir and Pi's transcript format. It is a
 * different *binary* (`pi-bolt`), not a different *agent*: a session it
 * writes is byte-compatible with a session Pi writes, in the same tree.
 *
 * So this provider is a near-clone of PiProvider. It reuses Pi's transcript
 * readers/writers (`pi-transcripts` / `pi-compatible-transcripts`), the shared
 * Pi-compatible sessions watcher, and Pi's profile/config-dir model
 * (PI_CODING_AGENT_DIR). The only deltas from Pi are: the binary name, the
 * `pi-bolt` provider id, and a per-provider launch-session base
 * (`pi-bolt-sessions`) so sessions launched from FineVibe under Pi-Bolt are
 * owned distinctly from Pi launches.
 *
 * Per-launch identity, established by onSessionStarted/onSessionResumed
 * BEFORE spawnPty runs (the pty:create handler calls the hook first):
 *  - sessionDir: the exclusive `--session-dir` for this launch.
 *  - knownCliId: fresh launches pin a FineVibe-generated id via
 *    `--session-id`, so the transcript id is known before the first write;
 *    resumes carry the id they were resumed with.
 *  - resumeTarget: the transcript to resume — the resolved path when the
 *    file is still on disk (Pi-Bolt appends to it in place), else the bare id.
 */
interface PiBoltLaunchState {
  sessionDir: string;
  knownCliId: string | null;
  resumeTarget: string | null;
}

const launchStates = new Map<string, PiBoltLaunchState>();

export class PiBoltProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'pi-bolt',
    displayName: 'Pi-Bolt',
    binaryName: 'pi-bolt',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: false,
      configReading: true,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'startup-arg',
      systemPromptInjection: true,
      profiles: true,
      selfTitles: true,
      polledStatus: true,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('pi-bolt', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('pi-bolt');
  }

  // PA-01: async twin so boot can probe every provider concurrently.
  validatePrerequisitesAsync(): Promise<boolean> {
    return validateBinaryExistsAsync('pi-bolt');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env.PATH = getFullPath();
    // Host-side hook block (per-host providers plan §3): the merged on-host
    // hooks read the FineVibe session id from this var. Inert on a local
    // launch — pi-bolt has no local hook system.
    env.FINEVIBE_SESSION_ID = sessionId;
    // Pi-Bolt shares Pi's env: PI_CODING_AGENT_DIR is Pi's agent-dir selector
    // (Pi-Bolt reuses ~/.pi/agent as-is). Strip inherited profile/storage
    // selectors case-insensitively so the pinned profile (below) is the single
    // effective identity — a native profile in the user's global environment
    // must not silently repoint the child away from the tree FineVibe tracks.
    removeEnvKey(env, 'PI_CODING_AGENT_DIR');
    removeEnvKey(env, 'PI_CONFIG_DIR');
    removeEnvKey(env, 'PI_PROFILE');
    removeEnvKey(env, 'PI_CODING_AGENT_SESSION_DIR');
    if (opts?.configDir) {
      // Pi's equivalent of CLAUDE_CONFIG_DIR — relocates the whole agent dir.
      env.PI_CODING_AGENT_DIR = opts.configDir;
    }
    return env;
  }

  buildArgs(opts: { sessionId: string; cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    // Every launch stores its transcripts in its own dir — the
    // process-scoped ownership signal the sessions watcher adopts by.
    const state = launchStates.get(opts.sessionId);
    const sessionDir = state?.sessionDir ?? launchSessionDir('pi-bolt', opts.sessionId);
    args.push('--session-dir', sessionDir);
    if (opts.isResume && opts.cliSessionId) {
      // Resume the exact transcript: the resolved path when it is still on
      // disk (Pi-Bolt appends to it in place), else the bare id.
      args.push('--session', state?.resumeTarget ?? opts.cliSessionId);
    } else if (!opts.isResume) {
      // Fresh launch: pin the FineVibe-generated id so the transcript is
      // attributable before its first write.
      const knownCliId = state?.knownCliId;
      if (knownCliId) args.push('--session-id', knownCliId);
    }
    if (opts.extraArgs) {
      args.push(...tokenizeArgs(opts.extraArgs));
    }
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (opts.initialPrompt) {
      // Pi-Bolt takes the initial prompt as a positional message arg.
      args.push(opts.initialPrompt);
    }
    return args;
  }

  // Pi-Bolt has no hook system — nothing to install or tear down.
  async installHooks(): Promise<void> {}

  installStatusScripts(): void {}

  cleanup(): void {
    stopPiBoltSessionWatcher();
    launchStates.clear();
  }

  reinstallSettings(): void {}

  async getConfig(_projectPath: string, configDir?: string): Promise<ProviderConfig> {
    const empty: ProviderConfig = { mcpServers: [], agents: [], skills: [], commands: [] };
    // Pi-Bolt uses Pi's settings/mcp.json in the shared ~/.pi/agent tree, so
    // its config surface is identical to Pi's. Read mcp.json from the pinned
    // profile's own agent tree: falling back to the default dir for a
    // profiled project would surface a different login's servers, tokens
    // included.
    const mcpPath = path.join(configDir ? path.resolve(configDir) : piAgentDir(), 'mcp.json');
    try {
      const raw = JSON.parse(await fs.promises.readFile(mcpPath, 'utf-8'));
      const servers = raw?.mcpServers;
      if (!servers || typeof servers !== 'object') return empty;
      const mcpServers: McpServer[] = Object
        .entries(servers as Record<string, unknown>)
        // A null/malformed entry must not throw and wipe the valid ones.
        .filter(([, cfg]) => typeof cfg === 'string' || (cfg !== null && typeof cfg === 'object'))
        .map(([name, cfg]) => ({
          name,
          url: serverUrl(cfg),
          status: 'configured',
          scope: 'user',
          filePath: mcpPath,
        }));
      return { ...empty, mcpServers };
    } catch {
      return empty;
    }
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(): SettingsValidationResult {
    // Nothing to validate — Pi-Bolt has no hooks or status line.
    return { statusLine: 'finevibe', hooks: 'complete', hookDetails: {} };
  }

  // Pi-Bolt has no hook system to report the session id. A fresh launch pins
  // a FineVibe-generated id (`--session-id`) into its exclusive `--session-dir`
  // before spawn, so the id is known up front and the watcher adopts the
  // file carrying exactly that id — no cwd/time inference.
  onSessionStarted(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
    const sessionDir = launchSessionDir('pi-bolt', sessionId);
    ensureLaunchSessionDir(sessionDir);
    const knownCliId = randomUUID();
    launchStates.set(sessionId, { sessionDir, knownCliId, resumeTarget: null });
    writeLaunchSessionMeta(sessionDir, { providerId: 'pi-bolt', cwd, configDir, createdAt: new Date().toISOString() });
    // The id is known now, so publish it immediately: the history panel shows
    // the CLI session id on the live row from spawn, not after the watcher's
    // first transcript adoption. Best-effort: a STATUS_DIR write failure
    // must not kill the spawn path — the watcher republishes the same id on
    // adoption (pi-compatible-session-watcher adopt() retries on failure).
    try {
      writeCliSessionId(sessionId, knownCliId);
    } catch (err) {
      console.warn(`pi-bolt: early session-id publish failed for ${sessionId}:`, err);
    }
    startPiBoltSessionWatcher();
    registerPendingPiBoltSession(sessionId, cwd, configDir, { sessionDir, knownCliId });
  }

  // A resumed session already knows its cli id, so it is seeded as an
  // ADOPTED entry (known id + its existing transcript path) — never as an
  // unidentified pending entry. That is what lets a later `/clear` — a
  // brand-new transcript under a new id in the launch's own dir — be
  // re-adopted instead of the tab freezing on the pre-clear file.
  onSessionResumed(sessionId: string, cwd: string, _win: BrowserWindow, configDir: string | undefined, cliSessionId: string): void {
    const sessionDir = launchSessionDir('pi-bolt', sessionId);
    ensureLaunchSessionDir(sessionDir);
    // Legacy transcripts live in the shared default/profile trees; a
    // post-`/clear` one lives in a previous launch's dir. Resolve before seeding.
    const adoptedFile = this.getTranscriptPath(cliSessionId, cwd, configDir, sessionDir);
    launchStates.set(sessionId, { sessionDir, knownCliId: cliSessionId, resumeTarget: adoptedFile ?? cliSessionId });
    writeLaunchSessionMeta(sessionDir, { providerId: 'pi-bolt', cwd, configDir, createdAt: new Date().toISOString() });
    startPiBoltSessionWatcher();
    registerPendingPiBoltSession(sessionId, cwd, configDir, { sessionDir, knownCliId: cliSessionId, adoptedFile: adoptedFile ?? undefined });
  }

  onSessionExited(sessionId: string): void {
    launchStates.delete(sessionId);
    unregisterPiBoltSession(sessionId);
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string, sessionDir?: string): string | null {
    // The launch's own dir first (post-`/clear` transcripts live there),
    // then the shared Pi tree (default/profile roots). Pi-Bolt and Pi share
    // `~/.pi/agent/sessions`, so a transcript created by `pi` is resolvable
    // for a Pi-Bolt resume — they are the same agent's sessions.
    if (sessionDir) {
      const inDir = findTranscriptPathInFlatDir(sessionDir, cliSessionId, projectPath);
      if (inDir) return inDir;
    }
    return findTranscriptPathSync(piSessionsRoot, cliSessionId, projectPath, configDir);
  }

  /**
   * The CLI's own session name from a resolved transcript path: the newest
   * `session_info` entry (set via `--name`, `/name`, or pi-bolt extensions
   * calling `pi.setSessionName()`), scanned from the tail first (recent
   * renames land at the end of the append-only file), then the head.
   */
  readSessionTitle(transcriptPath: string): string | null {
    return readTranscriptTitleWithSessionInfoSync(transcriptPath);
  }

  /**
   * Derive the session's status from a resolved transcript path (Pi-Bolt has
   * no hooks). The merged transcript-sync resolves the path once via
   * getTranscriptPath() and polls this for polledStatus providers.
   */
  readSessionStatus(transcriptPath: string): CliSessionStatus | null {
    return readTranscriptStatusSync(transcriptPath);
  }

  /**
   * The CLI's own explanation of an abnormal exit, from the trailing
   * `session_exit` entry of a resolved transcript path.
   */
  readSessionExitReason(transcriptPath: string): SessionExitReason | null {
    return readSessionExitReasonSync(transcriptPath);
  }

  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDiscovery> {
    // Pi-Bolt shares Pi's `~/.pi/agent` tree: a session it writes is identical
    // to a Pi session, in the same directory. Enumerating that shared root
    // here would double-list Pi's corpus (the Pi provider already surfaces it),
    // so Pi-Bolt's global-search corpus is ONLY the launches this app created
    // under its own `pi-bolt-sessions` base (flat layout, sidecar carries each
    // dir's profile). Legacy/terminal Pi-Bolt sessions remain attributed to
    // the Pi provider — see the README "Known limits" note.
    const scan = new TranscriptDiscoveryScan();
    for (const { dir: sessionDir, mtimeMs } of await listLaunchSessionDirs(launchSessionBaseDir('pi-bolt'))) {
      if (signal?.aborted) break;
      const meta = await readLaunchSessionMetaCached(sessionDir, mtimeMs);
      const profileId = profileIdForConfigDir('pi-bolt', meta?.configDir);
      await scan.collect(sessionDir, async () => {
        scan.descriptors.push(...await scanFlatSessionDir(sessionDir, profileId, signal));
      });
    }
    return scan.result();
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    return indexCompatibleTranscript(transcriptPath);
  }
}

/** Flatten one mcp.json server entry to the display string ProviderConfig carries. */
function serverUrl(cfg: unknown): string {
  if (typeof cfg === 'string') return cfg;
  const c = cfg as { url?: unknown; command?: unknown; args?: unknown };
  if (typeof c.url === 'string' && c.url) return c.url;
  return [typeof c.command === 'string' ? c.command : undefined,
    ...(Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [])]
    .filter(Boolean).join(' ');
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
