import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, CliSessionStatus, McpServer, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { collectProfileRoots } from './transcript-utils';
import { piAgentDir, piSessionsRoot } from './pi-transcripts';
import { findTranscriptPathSync, scanTranscriptSessionsRoot, indexCompatibleTranscript, readTranscriptStatusSync } from './pi-compatible-transcripts';
import { startPiSessionWatcher, registerPendingPiSession, unregisterPiSession, stopPiSessionWatcher } from '../pi-session-watcher';

const binaryCache = { path: null as string | null };

export class PiProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'pi',
    displayName: 'Pi',
    binaryName: 'pi',
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
      selfTitles: false,
      polledStatus: true,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('pi', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('pi');
  }

  buildEnv(_sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env.PATH = getFullPath();
    removeEnvKey(env, 'PI_CODING_AGENT_DIR');
    if (opts?.configDir) {
      // Pi's equivalent of CLAUDE_CONFIG_DIR — relocates the whole agent dir.
      env.PI_CODING_AGENT_DIR = opts.configDir;
    }
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.isResume && opts.cliSessionId) {
      args.push('--session', opts.cliSessionId);
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
    }
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (opts.initialPrompt) {
      // Pi takes the initial prompt as a positional message arg.
      args.push(opts.initialPrompt);
    }
    return args;
  }

  // Pi has no hook system — nothing to install or tear down.
  async installHooks(): Promise<void> {}

  installStatusScripts(): void {}

  cleanup(): void {
    stopPiSessionWatcher();
  }

  reinstallSettings(): void {}

  async getConfig(_projectPath: string, configDir?: string): Promise<ProviderConfig> {
    const empty: ProviderConfig = { mcpServers: [], agents: [], skills: [], commands: [] };
    // Pi's settings.json only carries display prefs (theme, quietStartup, …);
    // its MCP servers live in mcp.json — the only config the ProviderConfig
    // shape can surface. Read it from the pinned profile's own agent tree:
    // falling back to the default dir for a profiled project would surface a
    // different login's servers, tokens included.
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
    // Nothing to validate — Pi has no hooks or status line.
    return { statusLine: 'vibeyard', hooks: 'complete', hookDetails: {} };
  }

  // Pi has no hook system to report the session id — discover it from the
  // sessions tree after spawn (see pi-session-watcher.ts).
  onSessionStarted(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
    startPiSessionWatcher();
    registerPendingPiSession(sessionId, cwd, configDir);
  }

  // A resumed session already knows its cli id, so onSessionStarted never
  // runs for it. Join the sessions-tree watcher anyway: that is what lets a
  // later `/clear` — a brand-new transcript under a new id in the same cwd
  // — be re-adopted instead of the tab freezing on the pre-clear file.
  onSessionResumed(sessionId: string, cwd: string, _win: BrowserWindow, configDir?: string): void {
    startPiSessionWatcher();
    registerPendingPiSession(sessionId, cwd, configDir);
  }

  onSessionExited(sessionId: string): void {
    unregisterPiSession(sessionId);
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    return findTranscriptPathSync(piSessionsRoot, cliSessionId, projectPath, configDir);
  }

  /**
   * Derive the session's status from a resolved transcript path (Pi has no
   * hooks). The merged transcript-sync resolves the path once via
   * getTranscriptPath() and polls this for polledStatus providers.
   */
  readSessionStatus(transcriptPath: string): CliSessionStatus | null {
    return readTranscriptStatusSync(transcriptPath);
  }

  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDescriptor[]> {
    // Search the default agent dir plus every pi profile's config dir, so
    // global session search surfaces transcripts created under an isolated
    // profile. Each root carries its profileId (undefined = default) so
    // resume can reopen against the right config dir.
    const roots = collectProfileRoots('pi', piSessionsRoot(), 'sessions');
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
