import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, McpServer, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { MAX_INDEX_CHARS_PER_SESSION, TRANSCRIPT_TEXT_SEPARATOR, collectProfileRoots } from './transcript-utils';
import { piAgentDir, piSessionsRoot, readFirstLineSync, readFirstLineAsync, parseSessionHeader } from './pi-transcripts';
import { startPiSessionWatcher, registerPendingPiSession, unregisterPiSession } from '../pi-session-watcher';

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
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('pi', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('pi');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env.PATH = getFullPath();
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

  cleanup(): void {}

  reinstallSettings(): void {}

  async getConfig(_projectPath: string): Promise<ProviderConfig> {
    const empty: ProviderConfig = { mcpServers: [], agents: [], skills: [], commands: [] };
    // Pi's settings.json only carries display prefs (theme, quietStartup, …);
    // its MCP servers live in mcp.json — the only config the ProviderConfig
    // shape can surface.
    const mcpPath = path.join(piAgentDir(), 'mcp.json');
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

  onSessionExited(sessionId: string): void {
    unregisterPiSession(sessionId);
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    try {
      const sessionsRoot = piSessionsRoot(configDir);
      if (!fs.existsSync(sessionsRoot)) return null;

      // Filenames are <ISO-timestamp>_<uuid>.jsonl — match the id in the name
      // first, then read only the header line to prefer an exact cwd match.
      const suffix = `_${cliSessionId}.jsonl`;
      let fallback: string | null = null;
      for (const dir of fs.readdirSync(sessionsRoot)) {
        const dirPath = path.join(sessionsRoot, dir);
        let files: string[];
        try { files = fs.readdirSync(dirPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(suffix)) continue;
          const full = path.join(dirPath, f);
          const header = parseSessionHeader(readFirstLineSync(full));
          if (!header || header.id !== cliSessionId) continue;
          if (header.cwd === projectPath) return full;
          fallback ??= full;
        }
      }
      return fallback;
    } catch {
      return null;
    }
  }

  async discoverTranscripts(): Promise<TranscriptDescriptor[]> {
    // Search the default agent dir plus every pi profile's config dir, so
    // global session search surfaces transcripts created under an isolated
    // profile. Each root carries its profileId (undefined = default) so
    // resume can reopen against the right config dir.
    const roots = collectProfileRoots('pi', piSessionsRoot(), 'sessions');
    const results = await Promise.all(
      [...roots].map(([root, profileId]) => scanSessionsRoot(root, profileId))
    );
    return results.flat();
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(transcriptPath, 'utf-8');
    } catch {
      return { text: '', cwd: '' };
    }
    let cwd = '';
    const texts: string[] = [];
    let totalChars = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: { type?: string; cwd?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'session' && typeof entry.cwd === 'string') {
        cwd = entry.cwd;
        continue;
      }
      if (entry.type !== 'message') continue;
      if (totalChars >= MAX_INDEX_CHARS_PER_SESSION) break;
      if (entry.message?.role !== 'user') continue;
      let text = '';
      const c = entry.message.content;
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string') {
            text += (block as { text: string }).text + '\n';
          }
        }
      }
      if (text) {
        texts.push(text.trim());
        totalChars += text.length;
      }
    }
    return { text: texts.join(TRANSCRIPT_TEXT_SEPARATOR), cwd };
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

async function scanSessionsRoot(sessionsRoot: string, profileId: string | undefined): Promise<TranscriptDescriptor[]> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(sessionsRoot);
  } catch {
    return [];
  }
  const out: TranscriptDescriptor[] = [];
  for (const dir of dirs) {
    const dirPath = path.join(sessionsRoot, dir);
    let files: string[];
    try { files = await fs.promises.readdir(dirPath); } catch { continue; }
    // Header reads are independent — read them concurrently.
    const descriptors = await Promise.all(
      files.filter((f) => f.endsWith('.jsonl')).map(async (f) => {
        const transcriptPath = path.join(dirPath, f);
        const header = parseSessionHeader(await readFirstLineAsync(transcriptPath));
        return header
          ? { cliSessionId: header.id, transcriptPath, projectCwd: header.cwd ?? '', profileId }
          : null;
      })
    );
    for (const d of descriptors) if (d) out.push(d);
  }
  return out;
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
