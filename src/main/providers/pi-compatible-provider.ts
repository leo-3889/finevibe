import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDiscovery } from './provider';
import type { CliProviderMeta, CliSessionStatus, McpServer, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import type { CompatibleSessionWatcher } from '../pi-compatible-session-watcher';
import { resolveBinary, validateBinaryExists, validateBinaryExistsAsync } from './resolve-binary';
import { collectProfileRoots, TranscriptDiscoveryScan } from './transcript-utils';
import { findTranscriptPathSync, findTranscriptPathInFlatDir, scanTranscriptSessionsRoot, scanFlatSessionDir, indexCompatibleTranscript, readTranscriptStatusSync, readSessionExitReasonSync, seedLaunchTranscript } from './pi-compatible-transcripts';
import type { SessionExitReason } from './pi-compatible-transcripts';
import { writeCliSessionId } from '../hook-status';
import { launchSessionDir, launchSessionBaseDir, ensureLaunchSessionDir, writeLaunchSessionMeta, readLaunchSessionMetaCached, listLaunchSessionDirs, profileIdForConfigDir, systemPromptArg } from '../launch-session-dir';
import type { LaunchSessionProvider } from '../launch-session-dir';

/**
 * The ONE implementation of the three Pi-compatible providers — Pi, Pi-Bolt
 * and Oh my Pi (audit row 27: Pi and Pi-Bolt were a 0.70-similarity clone
 * pair, row 109: their `launchStates` shapes had drifted). It follows the
 * idiom already used for the transcript readers
 * (`pi-compatible-transcripts.createCompatibleTranscriptModule`) and the
 * session watchers (`provider-session-watcher.createProviderSessionWatcher`):
 * one parameterized body, thin per-provider wrappers that name their own
 * binary, roots, watcher and flags.
 *
 * What the three share (all Pi-compatible on disk): the exclusive per-launch
 * `--session-dir` ownership scheme (launch-session-dir.ts), the Pi transcript
 * format readers, the profile/config-dir model (`PI_CODING_AGENT_DIR`), the
 * tokenized extra args, the positional initial prompt,
 * `--append-system-prompt` with the Windows file redirect, and the
 * watcher/launch-state lifecycle. Each provider's `*-provider.ts` wrapper
 * keeps its own documentation of the deltas.
 */
export interface PiCompatibleProviderConfig {
  /** Provider id; doubles as the launch-session-dir provider key + sidecar id. */
  id: LaunchSessionProvider;
  displayName: string;
  binaryName: string;
  /** The provider's session watcher (per-provider module; see *-session-watcher.ts). */
  watcher: CompatibleSessionWatcher;
  /** Root of the provider's legacy (non-launch-dir) transcript tree. */
  sessionsRoot: (configDir?: string) => string;
  /** The CLI's own title reader (Pi: `session_info`, OMP: head `title`). */
  readTitle: (transcriptPath: string) => string | null;
  /** Resume flag spelling: Pi/Pi-Bolt `--session <path|id>`, OMP `--resume <path|id>`. */
  resumeFlag: '--session' | '--resume';
  /**
   * Pi and Pi-Bolt pin a FineVibe-generated id with `--session-id` on a fresh
   * launch (and seed the transcript so the CLI's id lookup is silent). OMP
   * has no such flag — it generates the id and the watcher adopts the first
   * transcript in the exclusive dir.
   */
  pinsSessionId: boolean;
  /**
   * Agent dir holding the Pi `mcp.json` this provider reads (`getConfig`), or
   * undefined when the provider's config is not surfaceable in the
   * ProviderConfig shape (OMP's `config.yml`) — which also clears the
   * `configReading` capability.
   */
  mcpConfigDir?: (configDir?: string) => string;
  /**
   * Enumerate the provider's default + per-profile roots in global search.
   * False for Pi-Bolt: it shares Pi's `~/.pi/agent` tree, so the Pi provider
   * owns that corpus and Pi-Bolt lists only its own launch dirs
   * (never double-list, docs/provider-contracts.md).
   */
  discoverSharedRoots: boolean;
  /** Env keys this provider strips on top of Pi's shared profile/storage set. */
  extraEnvKeysToRemove?: string[];
  /** The CLI's native plan-mode startup flag, only ever set when probe-verified. */
  planModeArg?: string;
}

/**
 * Per-launch identity, established by onSessionStarted/onSessionResumed
 * BEFORE spawnPty runs (the pty:create handler calls the hook first):
 *  - sessionDir: the exclusive `--session-dir` for this launch.
 *  - knownCliId: the pinned id (Pi/Pi-Bolt fresh launches), the id a resume
 *    was started with, or null when the CLI generates it (OMP fresh).
 *  - resumeTarget: the transcript to resume — the resolved path when the file
 *    is still on disk (the CLIs append to it in place), else the bare id.
 */
interface PiCompatibleLaunchState {
  sessionDir: string;
  knownCliId: string | null;
  resumeTarget: string | null;
}

/** Every Pi-compatible provider relocates the same Pi selectors. */
const SHARED_ENV_KEYS_TO_REMOVE = ['PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'PI_PROFILE', 'PI_CODING_AGENT_SESSION_DIR'];

export function createPiCompatibleProvider(config: PiCompatibleProviderConfig) {
  // Per-provider state: the factory runs once per wrapper module, so this is
  // that provider's module-level state. Keyed by UI session id, dropped on
  // session exit and on provider stop (module-map-governance `teardown`).
  // This one Map is the governance-reviewed collection for all three
  // Pi-compatible providers (module-map-governance.test.ts): it is indented,
  // so the scanner deliberately does not list it, and its `teardown` bound is
  // the factory's own two drops — onSessionExited per key, cleanup() on quit
  // (main.ts calls every provider's cleanup).
  const launchStates = new Map<string, PiCompatibleLaunchState>();
  const binaryCache = { path: null as string | null };
  const envKeysToRemove = [...SHARED_ENV_KEYS_TO_REMOVE, ...(config.extraEnvKeysToRemove ?? [])];

  return class PiCompatibleProvider implements CliProvider {
    /** @internal Test-only: reset the cached binary path. */
    static resetBinaryCache(): void {
      binaryCache.path = null;
    }

    readonly meta: CliProviderMeta = {
      id: config.id,
      displayName: config.displayName,
      binaryName: config.binaryName,
      capabilities: {
        sessionResume: true,
        costTracking: false,
        contextWindow: false,
        hookStatus: false,
        configReading: config.mcpConfigDir !== undefined,
        shiftEnterNewline: false,
        pendingPromptTrigger: 'startup-arg',
        systemPromptInjection: true,
        profiles: true,
        selfTitles: true,
        polledStatus: true,
        ...(config.planModeArg ? { planModeArg: config.planModeArg } : {}),
      },
      defaultContextWindowSize: 200_000,
    };

    resolveBinaryPath(): string {
      return resolveBinary(config.binaryName, binaryCache);
    }

    validatePrerequisites(): boolean {
      return validateBinaryExists(config.binaryName);
    }

    // PA-01: async twin so boot can probe every provider concurrently.
    validatePrerequisitesAsync(): Promise<boolean> {
      return validateBinaryExistsAsync(config.binaryName);
    }

    buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
      const env = { ...baseEnv };
      env.PATH = getFullPath();
      // Host-side hook block (per-host providers plan §3): the merged on-host
      // hooks read the FineVibe session id from this var. Inert on a local
      // launch — none of these CLIs has a local hook system.
      env.FINEVIBE_SESSION_ID = sessionId;
      // Strip inherited profile/storage selectors case-insensitively so the
      // pinned profile (below) is the single effective identity: a native
      // profile or relocated dir in the user's global environment must not
      // silently repoint the child away from the tree FineVibe tracks.
      for (const key of envKeysToRemove) removeEnvKey(env, key);
      if (opts?.configDir) {
        // Pi's equivalent of CLAUDE_CONFIG_DIR — relocates the whole agent dir
        // (Pi-Bolt shares the tree; OMP honors the same variable).
        env.PI_CODING_AGENT_DIR = opts.configDir;
      }
      return env;
    }

    buildArgs(opts: { sessionId: string; cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string; remote?: boolean }): string[] {
      const args: string[] = [];
      // Every launch stores its transcripts in its own dir — the
      // process-scoped ownership signal the sessions watcher adopts by.
      const state = launchStates.get(opts.sessionId);
      const sessionDir = state?.sessionDir ?? launchSessionDir(config.id, opts.sessionId);
      args.push('--session-dir', sessionDir);
      if (opts.isResume && opts.cliSessionId) {
        // Resume the exact transcript: the resolved path when it is still on
        // disk (the CLI appends to it in place), else the bare id.
        args.push(config.resumeFlag, state?.resumeTarget ?? opts.cliSessionId);
      } else if (!opts.isResume && config.pinsSessionId && state?.knownCliId) {
        // Fresh launch: pin the FineVibe-generated id so the transcript is
        // attributable before its first write. Gated on the config, not just
        // the state: OMP has no `--session-id` flag and exits on unknown
        // flags, so a leftover state from a resumed launch must never make
        // the fresh path push it.
        args.push('--session-id', state.knownCliId);
      }
      if (opts.extraArgs) {
        args.push(...tokenizeArgs(opts.extraArgs));
      }
      if (opts.systemPrompt) {
        args.push('--append-system-prompt', systemPromptArg(opts.systemPrompt, sessionDir, opts.remote));
      }
      if (opts.initialPrompt) {
        // All three take the initial prompt as a positional message arg.
        args.push(opts.initialPrompt);
      }
      return args;
    }

    // None of these CLIs has a hook system — nothing to install or tear down.
    async installHooks(): Promise<void> {}

    installStatusScripts(): void {}

    cleanup(): void {
      config.watcher.stop();
      launchStates.clear();
    }

    reinstallSettings(): void {}

    async getConfig(_projectPath: string, configDir?: string): Promise<ProviderConfig> {
      const empty: ProviderConfig = { mcpServers: [], agents: [], skills: [], commands: [] };
      if (!config.mcpConfigDir) {
        // The provider's config is a format ProviderConfig cannot surface
        // (OMP's config.yml) — report an empty config rather than guess.
        return empty;
      }
      // Pi's settings.json only carries display prefs (theme, quietStartup, …);
      // its MCP servers live in mcp.json — the only config the ProviderConfig
      // shape can surface. Read it from the pinned profile's own agent tree:
      // falling back to the default dir for a profiled project would surface a
      // different login's servers, tokens included.
      const mcpPath = path.join(config.mcpConfigDir(configDir ? path.resolve(configDir) : undefined), 'mcp.json');
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
      // Nothing to validate — no hooks, no status line.
      return { statusLine: 'finevibe', hooks: 'complete', hookDetails: {} };
    }

    // No hook system reports the session id, so ownership comes from the
    // launch's exclusive `--session-dir`. A pinned launch (Pi/Pi-Bolt) knows
    // its id before the first write and the watcher adopts the file carrying
    // exactly that id; an unpinned one (OMP) adopts the first transcript to
    // appear there — the dir guarantees it is this process's.
    onSessionStarted(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
      const sessionDir = launchSessionDir(config.id, sessionId);
      ensureLaunchSessionDir(sessionDir);
      const knownCliId = config.pinsSessionId ? randomUUID() : null;
      launchStates.set(sessionId, { sessionDir, knownCliId, resumeTarget: null });
      writeLaunchSessionMeta(sessionDir, { providerId: config.id, cwd, configDir, createdAt: new Date().toISOString() });
      if (knownCliId) {
        // The id is known now, so publish it immediately: the history panel shows
        // the CLI session id on the live row from spawn, not after the watcher's
        // first transcript adoption. Best-effort: a STATUS_DIR write failure
        // must not kill the spawn path — the watcher republishes the same id on
        // adoption (pi-compatible-session-watcher adopt() retries on failure).
        try {
          writeCliSessionId(sessionId, knownCliId);
        } catch (err) {
          console.warn(`${config.id}: early session-id publish failed for ${sessionId}:`, err);
        }
      }
      config.watcher.start();
      config.watcher.registerPending(sessionId, cwd, configDir, { sessionDir, knownCliId: knownCliId ?? undefined });
      if (knownCliId) {
        // Seed the transcript file AFTER registration (the registration
        // snapshot would freeze out a pre-existing file) so the CLI's
        // `--session-id` lookup finds it and starts silent — without it every
        // fresh launch prints "Warning: No project session found with id ...".
        // Best-effort: a failed seed only restores the old warning.
        try {
          seedLaunchTranscript(sessionDir, knownCliId, cwd);
        } catch (err) {
          console.warn(`${config.id}: transcript seed failed for ${sessionId}:`, err);
        }
      }
    }

    // A resumed session already knows its cli id, so it is seeded as an
    // ADOPTED entry (known id + its existing transcript path) — never as an
    // unidentified pending entry. That is what lets a later `/clear` — a
    // brand-new transcript under a new id in the launch's own dir — be
    // re-adopted instead of the tab freezing on the pre-clear file.
    onSessionResumed(sessionId: string, cwd: string, _win: BrowserWindow, configDir: string | undefined, cliSessionId: string): void {
      const sessionDir = launchSessionDir(config.id, sessionId);
      ensureLaunchSessionDir(sessionDir);
      // Legacy transcripts live in the default/profile trees; a post-`/clear`
      // one lives in a previous launch's dir. Resolve before seeding.
      const adoptedFile = this.getTranscriptPath(cliSessionId, cwd, configDir, sessionDir);
      launchStates.set(sessionId, { sessionDir, knownCliId: cliSessionId, resumeTarget: adoptedFile ?? cliSessionId });
      writeLaunchSessionMeta(sessionDir, { providerId: config.id, cwd, configDir, createdAt: new Date().toISOString() });
      config.watcher.start();
      config.watcher.registerPending(sessionId, cwd, configDir, { sessionDir, knownCliId: cliSessionId, adoptedFile: adoptedFile ?? undefined });
    }

    onSessionExited(sessionId: string): void {
      launchStates.delete(sessionId);
      config.watcher.unregister(sessionId);
    }

    getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string, sessionDir?: string): string | null {
      // The launch's own dir first (post-`/clear` transcripts live there),
      // then the legacy default/profile trees.
      if (sessionDir) {
        const inDir = findTranscriptPathInFlatDir(sessionDir, cliSessionId, projectPath);
        if (inDir) return inDir;
      }
      // A pinned profile's configDir relocates the agent tree: the legacy
      // scan runs under <configDir>/sessions. The P2-113 renderer gate lives
      // at the IPC boundary (ipc-handlers), not here — every main-side caller
      // threads a configDir it resolved from app state (pty:create gates its
      // own at the launch; the sessionDir branch above is main-derived).
      return findTranscriptPathSync(config.sessionsRoot, cliSessionId, projectPath, configDir);
    }

    /** The CLI's own session name from a resolved transcript path. */
    readSessionTitle(transcriptPath: string): string | null {
      return config.readTitle(transcriptPath);
    }

    /**
     * Derive the session's status from a resolved transcript path (no hooks).
     * The merged transcript-sync resolves the path once via
     * getTranscriptPath() and polls this for polledStatus providers.
     */
    readSessionStatus(transcriptPath: string): CliSessionStatus | null {
      return readTranscriptStatusSync(transcriptPath);
    }

    /**
     * The CLI's own explanation of an abnormal exit, from the trailing
     * `session_exit` entry of a resolved transcript path. The pty:create exit
     * callback reads this on a non-zero exit before the session is torn down,
     * so the renderer can surface why the CLI died.
     */
    readSessionExitReason(transcriptPath: string): SessionExitReason | null {
      return readSessionExitReasonSync(transcriptPath);
    }

    async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDiscovery> {
      const scan = new TranscriptDiscoveryScan();
      // The default agent dir plus every profile's config dir, so global search
      // surfaces transcripts created under an isolated profile. Each root
      // carries its profileId (undefined = default) so resume can reopen
      // against the right config dir. A root whose scan throws (other than
      // "root missing") marks the pass incomplete (P2-70).
      if (config.discoverSharedRoots) {
        for (const [root, profileId] of collectProfileRoots(config.id, config.sessionsRoot(), 'sessions')) {
          if (signal?.aborted) break;
          await scan.collect(root, async () => {
            scan.descriptors.push(...await scanTranscriptSessionsRoot(root, profileId, signal));
          });
        }
      }
      // Plus every per-launch dir this app created (flat layout). Legacy
      // history above is untouched; the sidecar carries each dir's profile.
      // Async sweep + mtime-keyed meta cache (PA-19): the sidecar is written
      // once at launch, so per-search re-reads were pure overhead.
      for (const { dir: sessionDir, mtimeMs } of await listLaunchSessionDirs(launchSessionBaseDir(config.id))) {
        if (signal?.aborted) break;
        const meta = await readLaunchSessionMetaCached(sessionDir, mtimeMs);
        const profileId = profileIdForConfigDir(config.id, meta?.configDir);
        await scan.collect(sessionDir, async () => {
          scan.descriptors.push(...await scanFlatSessionDir(sessionDir, profileId, signal));
        });
      }
      return scan.result();
    }

    async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
      return indexCompatibleTranscript(transcriptPath);
    }
  };
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
