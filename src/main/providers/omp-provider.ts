import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, CliSessionStatus, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { collectProfileRoots } from './transcript-utils';
import { ompSessionsRoot, readTranscriptTitleSync } from './omp-transcripts';
import { findTranscriptPathSync, scanTranscriptSessionsRoot, indexCompatibleTranscript, readTranscriptStatusSync } from './pi-compatible-transcripts';
import { startOmpSessionWatcher, registerPendingOmpSession, unregisterOmpSession, stopOmpSessionWatcher } from '../omp-session-watcher';

const binaryCache = { path: null as string | null };

export class OmpProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'omp',
    displayName: 'Oh my Pi',
    binaryName: 'omp',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: false,
      configReading: false,
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
    return resolveBinary('omp', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('omp');
  }

  buildEnv(_sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env.PATH = getFullPath();
    removeEnvKey(env, 'PI_CODING_AGENT_DIR');
    if (opts?.configDir) {
      // OMP honors Pi's PI_CODING_AGENT_DIR — relocates the whole agent dir
      // (default ~/.omp/agent).
      env.PI_CODING_AGENT_DIR = opts.configDir;
    }
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.isResume && opts.cliSessionId) {
      args.push('--resume', opts.cliSessionId);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
    }
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (opts.initialPrompt) {
      // OMP takes the initial prompt as a positional message arg.
      args.push(opts.initialPrompt);
    }
    return args;
  }

  // OMP has no hook system — nothing to install or tear down.
  async installHooks(): Promise<void> {}

  installStatusScripts(): void {}

  cleanup(): void {
    stopOmpSessionWatcher();
  }

  reinstallSettings(): void {}

  async getConfig(_projectPath: string): Promise<ProviderConfig> {
    // OMP's config is config.yml (YAML) — nothing the ProviderConfig shape
    // can surface without a YAML parser, so report an empty config.
    return { mcpServers: [], agents: [], skills: [], commands: [] };
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(): SettingsValidationResult {
    // Nothing to validate — OMP has no hooks or status line.
    return { statusLine: 'vibeyard', hooks: 'complete', hookDetails: {} };
  }

  // OMP has no hook system to report the session id — discover it from the
  // sessions tree after spawn (see omp-session-watcher.ts).
  onSessionStarted(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
    startOmpSessionWatcher();
    registerPendingOmpSession(sessionId, cwd, configDir);
  }

  // A resumed session already knows its cli id, so onSessionStarted never
  // runs for it. Join the sessions-tree watcher anyway: that is what lets a
  // later `/clear` — a brand-new transcript under a new id in the same cwd
  // — be re-adopted instead of the tab freezing on the pre-clear file.
  onSessionResumed(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
    startOmpSessionWatcher();
    registerPendingOmpSession(sessionId, cwd, configDir);
  }

  /**
   * The CLI's own title from a resolved transcript path. OMP keeps it in
   * the transcript head (a `type:"title"` line, mirrored into the session
   * header); the merged transcript-sync resolves the path once and polls
   * this for self-titling providers.
   */
  readSessionTitle(transcriptPath: string): string | null {
    return readTranscriptTitleSync(transcriptPath);
  }

  /**
   * Derive the session's status from a resolved transcript path (OMP has no
   * hooks). The merged transcript-sync resolves the path once and polls
   * this for polledStatus providers, mirroring the result into the
   * `.status` channel.
   */
  readSessionStatus(transcriptPath: string): CliSessionStatus | null {
    return readTranscriptStatusSync(transcriptPath);
  }

  onSessionExited(sessionId: string): void {
    unregisterOmpSession(sessionId);
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    return findTranscriptPathSync(ompSessionsRoot, cliSessionId, projectPath, configDir);
  }

  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDescriptor[]> {
    // Search the default agent dir plus every omp profile's config dir, so
    // global session search surfaces transcripts created under an isolated
    // profile. Each root carries its profileId (undefined = default) so
    // resume can reopen against the right config dir.
    const roots = collectProfileRoots('omp', ompSessionsRoot(), 'sessions');
    const results: TranscriptDescriptor[] = [];
    for (const [root, profileId] of roots) {
      if (signal?.aborted) break;
      results.push(...await scanTranscriptSessionsRoot(root, profileId, signal));
    }
    return results;
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    return indexCompatibleTranscript(transcriptPath);
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
