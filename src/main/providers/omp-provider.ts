import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { MAX_INDEX_CHARS_PER_SESSION, TRANSCRIPT_TEXT_SEPARATOR, collectProfileRoots } from './transcript-utils';
import { ompAgentDir, ompSessionsRoot, readFirstLineSync, readFirstLineAsync, parseSessionHeader } from './omp-transcripts';
import { startOmpSessionWatcher, registerPendingOmpSession, unregisterOmpSession } from '../omp-session-watcher';

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

  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
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

  cleanup(): void {}

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
    try {
      const sessionsRoot = ompSessionsRoot(configDir);
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
    // Search the default agent dir plus every omp profile's config dir, so
    // global session search surfaces transcripts created under an isolated
    // profile. Each root carries its profileId (undefined = default) so
    // resume can reopen against the right config dir.
    const roots = collectProfileRoots('omp', ompSessionsRoot(), 'sessions');
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
