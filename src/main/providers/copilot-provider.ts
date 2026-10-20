import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { getCopilotConfig, AGENT_EXT } from '../copilot-config';
import { installCopilotHooks, validateCopilotHooks, cleanupCopilotHooks, SESSION_ID_VAR } from '../copilot-hooks';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { MAX_INDEX_BYTES, MAX_INDEX_FILE_BYTES, IndexTextBudget, UUID_RE } from './transcript-utils';
import { writeAgentFile, deleteAgentFile } from './agent-files';

const binaryCache = { path: null as string | null };

/**
 * `cliSessionId` arrives from the renderer (`session:transcriptExists`,
 * `session:exportArchive`, the resume path) and is joined straight into
 * `~/.copilot/session-state/<id>/events.jsonl`, and the answer the caller
 * gets back is "does that file exist" — so a `../../x` id is a filesystem-wide
 * existsSync oracle. Copilot names session dirs by UUID (see UUID_RE in
 * discoverTranscripts); this is the permissive superset hook-status.ts uses
 * for its `.status` names: [A-Za-z0-9._-], no leading dot, 128-char cap.
 */
const TRANSCRIPT_ID_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}$/;

export class CopilotProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    binaryName: 'copilot',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: true,
      configReading: true,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'startup-arg',
      planModeArg: '--mode plan',
      systemPromptInjection: false,
      profiles: false,
      selfTitles: false,
      polledStatus: false,
    },
    defaultContextWindowSize: 128_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('copilot', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('copilot');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, _opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env[SESSION_ID_VAR] = sessionId;
    env.PATH = getFullPath();
    return env;
  }

  buildArgs(opts: { sessionId: string; cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.isResume && opts.cliSessionId) {
      // terminal-pane hands the queued prompt to pty.create for every
      // startup-arg provider, so dropping it on resume silently loses a
      // browser-tab / team / Restart Session prompt delivered to a dormant
      // session. `--resume=<id>` then `-i <prompt>` is the shape Gemini uses
      // for the same case (gemini-provider.ts:114-122).
      args.push(`--resume=${opts.cliSessionId}`);
      if (opts.initialPrompt) args.push('-i', opts.initialPrompt);
    } else if (opts.initialPrompt) {
      args.push('-i', opts.initialPrompt);
    }
    if (opts.extraArgs) {
      args.push(...tokenizeArgs(opts.extraArgs));
    }
    return args;
  }

  async installHooks(_win?: BrowserWindow | null, projectPath?: string): Promise<void> {
    installCopilotHooks(projectPath);
  }

  installStatusScripts(): void {}

  cleanup(): void {
    stopConfigWatch();
    cleanupCopilotHooks();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath, 'copilot');
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  async getConfig(projectPath: string): Promise<ProviderConfig> {
    return Promise.resolve(getCopilotConfig(projectPath));
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(projectPath?: string): SettingsValidationResult {
    return validateCopilotHooks(projectPath);
  }

  reinstallSettings(): void {
    installCopilotHooks();
  }

  agentsDir(): string {
    return path.join(os.homedir(), '.copilot', 'agents');
  }

  async installAgent(slug: string, content: string): Promise<{ filePath: string }> {
    return writeAgentFile(this.agentsDir(), slug, content, AGENT_EXT);
  }

  async removeAgent(slug: string): Promise<void> {
    return deleteAgentFile(this.agentsDir(), slug, AGENT_EXT);
  }

  getTranscriptPath(cliSessionId: string, _projectPath: string): string | null {
    // Non-ids are rejected before the join, not after the existsSync: the
    // caller only learns "this path exists", which is exactly the oracle a
    // traversal id is after (see TRANSCRIPT_ID_RE).
    if (!TRANSCRIPT_ID_RE.test(cliSessionId)) return null;
    const filePath = path.join(os.homedir(), '.copilot', 'session-state', cliSessionId, 'events.jsonl');
    return fs.existsSync(filePath) ? filePath : null;
  }

  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDescriptor[]> {
    const root = path.join(os.homedir(), '.copilot', 'session-state');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: TranscriptDescriptor[] = [];
    for (const entry of entries) {
      if (signal?.aborted) return out;
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      const cliSessionId = entry.name;
      const dir = path.join(root, cliSessionId);
      const transcriptPath = path.join(dir, 'events.jsonl');
      let projectCwd = '';
      try {
        const yaml = await fs.promises.readFile(path.join(dir, 'workspace.yaml'), 'utf-8');
        const m = yaml.match(/^cwd:\s*"?([^"\n]+?)"?\s*$/m);
        if (m) projectCwd = m[1].trim();
      } catch {
        // workspace.yaml may be absent on partial-init sessions; cwd stays empty
      }
      out.push({ cliSessionId, transcriptPath, projectCwd });
    }
    return out;
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    let size: number;
    try {
      size = (await fs.promises.stat(transcriptPath)).size;
    } catch {
      return { text: '', cwd: '' };
    }
    if (size > MAX_INDEX_FILE_BYTES) return { text: '', cwd: '' };

    const budget = new IndexTextBudget();

    const input = fs.createReadStream(transcriptPath, { end: MAX_INDEX_BYTES - 1 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim() || budget.full) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'user.message') continue;
          const c = entry.data?.content;
          budget.push(c);
        } catch {
          // partial-write tolerance
        }
      }
    } catch {
      // Best-effort: keep whatever was extracted before the stream failed.
    } finally {
      lines.close();
      input.destroy();
    }
    return { text: budget.join(), cwd: '' };
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
