import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow } from 'electron';
import type { CliProvider, TranscriptDescriptor, TranscriptDiscovery } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import { installStatusLineScript, cleanupAll as cleanupHookStatus } from '../hook-status';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { getClaudeConfig, isManagedMcpConfigDir } from '../claude-cli';
import { guardedInstall, validateSettings, reinstallSettings } from '../settings-guard';
import { resolveBinary, validateBinaryExists, validateBinaryExistsAsync } from './resolve-binary';
import { MAX_INDEX_BYTES, MAX_INDEX_FILE_BYTES, IndexTextBudget, UUID_RE, collectProfileRoots, TranscriptDiscoveryScan, readdirForDiscovery } from './transcript-utils';
import { writeAgentFile, deleteAgentFile } from './agent-files';

/**
 * A renderer-supplied cliSessionId is joined into the transcript path, so it
 * must be the file's name, not a path. Claude names transcripts `<uuid>.jsonl`
 * (see UUID_RE); ids from other producers are slug shaped, so this is the
 * permissive superset hook-status.ts uses for its `.status` names:
 * [A-Za-z0-9._-], no leading dot (a relative/hidden name), 128-char cap.
 */
const TRANSCRIPT_ID_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}$/;

const binaryCache = { path: null as string | null };

/**
 * Enumerate every on-disk transcript under one `.../projects` root, tagged
 * with its profile. A readdir failure on an existing dir (EIO/EPERM on a
 * mounted tree) propagates: the caller marks the pass incomplete so the
 * derived index is not pruned off a partial scan (P2-70).
 */
async function scanProjectsRoot(root: string, profileId?: string, signal?: AbortSignal): Promise<TranscriptDescriptor[]> {
  const entries = await readdirForDiscovery(root, true);
  const out: TranscriptDescriptor[] = [];
  for (const slugEntry of entries) {
    if (signal?.aborted) return out;
    if (!slugEntry.isDirectory()) continue;
    const slug = slugEntry.name;
    const slugPath = path.join(root, slug);
    const files = await readdirForDiscovery(slugPath);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const cliSessionId = file.slice(0, -6);
      if (!UUID_RE.test(cliSessionId)) continue;
      out.push({ cliSessionId, transcriptPath: path.join(slugPath, file), projectSlug: slug, profileId });
    }
  }
  return out;
}

export class ClaudeProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    capabilities: {
      sessionResume: true,
      costTracking: true,
      contextWindow: true,
      hookStatus: true,
      configReading: true,
      shiftEnterNewline: true,
      pendingPromptTrigger: 'startup-arg',
      planModeArg: '--permission-mode plan',
      systemPromptInjection: true,
      profiles: true,
      selfTitles: true,
      polledStatus: false,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('claude', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('claude');
  }

  // PA-01: async twin so boot can probe every provider concurrently.
  validatePrerequisitesAsync(): Promise<boolean> {
    return validateBinaryExistsAsync('claude');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    delete env.CLAUDE_CODE; // avoid subprocess detection conflicts
    env.CLAUDE_IDE_SESSION_ID = sessionId;
    env.PATH = getFullPath();
    // Profile support: point Claude Code at an isolated config dir (separate
    // credentials/license, settings, hooks, transcripts). Absent = default ~/.claude.
    removeEnvKey(env, 'CLAUDE_CONFIG_DIR');
    if (opts?.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
    return env;
  }

  buildArgs(opts: { sessionId: string; cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.cliSessionId) {
      if (opts.isResume) {
        args.push('-r', opts.cliSessionId);
      } else {
        args.push('--session-id', opts.cliSessionId);
      }
    }
    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt);
    }
    if (opts.initialPrompt) {
      args.push(opts.initialPrompt);
    }
    if (opts.extraArgs) {
      args.push(...tokenizeArgs(opts.extraArgs));
    }
    return args;
  }

  async installHooks(win?: BrowserWindow | null, _projectPath?: string): Promise<void> {
    await guardedInstall(win ?? null);
  }

  installStatusScripts(): void {
    installStatusLineScript();
  }

  cleanup(): void {
    stopConfigWatch();
    cleanupHookStatus();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath, 'claude');
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  async getConfig(projectPath: string, configDir?: string): Promise<ProviderConfig> {
    // configDir is the project's pinned profile dir (provider.ts:34): the
    // profiled CLI reads its MCP/agents/skills there, not in ~/.claude.
    return getClaudeConfig(projectPath, configDir);
  }

  validateSettings(_projectPath?: string, configDir?: string): SettingsValidationResult {
    // For a profile session, validate the profile's config dir (where spawnPty
    // installed hooks + statusLine), not the default ~/.claude.
    return validateSettings(configDir);
  }

  reinstallSettings(configDir?: string): void {
    // P2-127: repair the dir the warning banner was computed from — for a
    // profiled session that is the profile dir, the tree the CLI reads.
    reinstallSettings(configDir);
    installStatusLineScript();
  }

  getShiftEnterSequence(): string | null {
    return '\x1b[13;2u';
  }

  getTranscriptPath(cliSessionId: string, projectPath: string, configDir?: string): string | null {
    // The id arrives from the renderer (`session:transcriptExists`,
    // `session:exportArchive`, the resume path) and is joined into a path
    // whose existence is reported back to it, so a `../../x` id is an
    // existsSync oracle over the whole filesystem. Transcripts Claude writes
    // are named `<uuid>.jsonl`; anything else is not an id. Same shape as
    // hook-status' UI_SESSION_ID_RE: [A-Za-z0-9._-], no leading dot, capped.
    if (!TRANSCRIPT_ID_RE.test(cliSessionId)) return null;
    // P2-113: `root` below is a renderer-supplied configDir, and this
    // existsSync answer travels back verbatim (transcriptExists /
    // exportArchive / resume), so a foreign dir is an existence oracle over
    // its whole tree. Reads take the same canonical allowlist mcp:addServer
    // enforces on its write target; undefined = the default ~/.claude tree,
    // which the app owns. Decline as the provider's no-match shape.
    if (configDir && !isManagedMcpConfigDir(configDir)) return null;
    // Claude encodes the project path by replacing any non-alphanumeric char with '-'
    const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
    const root = configDir ?? path.join(os.homedir(), '.claude');
    const filePath = path.join(root, 'projects', slug, `${cliSessionId}.jsonl`);
    return fs.existsSync(filePath) ? filePath : null;
  }

  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDiscovery> {
    // Search the default config dir plus every claude profile's config dir, so
    // global session search surfaces transcripts created under an isolated profile.
    // Each root carries its profileId (undefined = default ~/.claude) so resume
    // can reopen against the right config dir. A root whose scan throws (other
    // than "root missing") is reported incomplete: the caller must not prune
    // the derived index off this partial corpus (P2-70).
    const roots = collectProfileRoots('claude', path.join(os.homedir(), '.claude', 'projects'), 'projects');
    const scan = new TranscriptDiscoveryScan();
    for (const [root, profileId] of roots) {
      if (signal?.aborted) break;
      await scan.collect(root, async () => {
        scan.descriptors.push(...await scanProjectsRoot(root, profileId, signal));
      });
    }
    return scan.result();
  }

  async indexTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    let size: number;
    try {
      size = (await fs.promises.stat(transcriptPath)).size;
    } catch {
      return { text: '', cwd: '' };
    }
    if (size > MAX_INDEX_FILE_BYTES) return { text: '', cwd: '' };

    let cwd = '';
    const budget = new IndexTextBudget();

    const input = fs.createReadStream(transcriptPath, { end: MAX_INDEX_BYTES - 1 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim() || budget.full) continue;
        try {
          const entry = JSON.parse(line);
          if (!cwd && entry.cwd) cwd = entry.cwd;
          if (entry.type !== 'user' || !entry.message?.content) continue;
          const c = entry.message.content;
          let text = '';
          if (typeof c === 'string') {
            text = c;
          } else if (Array.isArray(c)) {
            for (const block of c) {
              text += `${block.text}\n`;
            }
          }
          if (text) budget.push(text);
        } catch {
          // partial-write tolerance: skip malformed lines
        }
      }
    } catch {
      // Best-effort: keep whatever was extracted before the stream failed.
    } finally {
      lines.close();
      input.destroy();
    }
    return { text: budget.join(), cwd };
  }

  /**
   * P2-116: a profile-pinned launch runs with CLAUDE_CONFIG_DIR=<profileDir>
   * and reads its agents from `<profileDir>/agents` — writing
   * ~/.claude/agents would report success into a tree that CLI never reads.
   * Mirrors addMcpServer's configDir threading (claude-cli.ts).
   */
  agentsDir(configDir?: string): string {
    return path.join(configDir ?? path.join(os.homedir(), '.claude'), 'agents');
  }

  async installAgent(slug: string, content: string, configDir?: string): Promise<{ filePath: string }> {
    return writeAgentFile(this.agentsDir(configDir), slug, content);
  }

  async removeAgent(slug: string, configDir?: string): Promise<void> {
    return deleteAgentFile(this.agentsDir(configDir), slug);
  }

  parseCostFromOutput(rawText: string): { totalCostUsd: number } | null {
    const COST_RE = /\$(\d+\.\d{2,})/g;
    let match: RegExpExecArray | null = COST_RE.exec(rawText);
    let lastCost: string | null = null;
    while (match !== null) {
      lastCost = match[0];
      match = COST_RE.exec(rawText);
    }
    if (lastCost) {
      return { totalCostUsd: parseFloat(lastCost.replace('$', '')) };
    }
    return null;
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
