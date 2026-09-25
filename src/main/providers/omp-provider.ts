import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { collectProfileRoots } from './transcript-utils';
import { ompSessionsRoot } from './omp-transcripts';
import { findTranscriptPathSync, scanTranscriptSessionsRoot, indexCompatibleTranscript } from './pi-compatible-transcripts';
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
    if (opts?.configDir) {
      // OMP honors Pi's PI_CODING_AGENT_DIR — relocates the whole agent dir
      // (default ~/.omp/agent).
      env.PI_CODING_AGENT_DIR = opts.configDir;
    } else {
      // OMP and Pi share PI_CODING_AGENT_DIR. If the host environment carries
      // a Pi profile dir (e.g. Vibeyard launched from a pi shell), an
      // unprofiled OMP session would silently read Pi's config — strip it so
      // OMP falls back to its own ~/.omp/agent.
      delete env.PI_CODING_AGENT_DIR;
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

  onSessionExited(sessionId: string): void {
    unregisterOmpSession(sessionId);
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    return findTranscriptPathSync(ompSessionsRoot, cliSessionId, projectPath, configDir);
  }

  async discoverTranscripts(): Promise<TranscriptDescriptor[]> {
    // Search the default agent dir plus every omp profile's config dir, so
    // global session search surfaces transcripts created under an isolated
    // profile. Each root carries its profileId (undefined = default) so
    // resume can reopen against the right config dir.
    const roots = collectProfileRoots('omp', ompSessionsRoot(), 'sessions');
    const results = await Promise.all(
      [...roots].map(([root, profileId]) => scanTranscriptSessionsRoot(root, profileId))
    );
    return results.flat();
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    return indexCompatibleTranscript(transcriptPath);
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
