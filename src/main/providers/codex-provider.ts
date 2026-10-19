import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as zlib from 'zlib';
import * as os from 'os';
import type { CliProvider, TranscriptDescriptor } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists } from './resolve-binary';
import { getCodexConfig } from '../codex-config';
import { installCodexHooks, validateCodexHooks, cleanupCodexHooks, SESSION_ID_VAR } from '../codex-hooks';
import { startCodexSessionWatcher, stopCodexSessionWatcher, registerPendingCodexSession, unregisterCodexSession } from '../codex-session-watcher';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { MAX_INDEX_BYTES, MAX_INDEX_FILE_BYTES, IndexTextBudget } from './transcript-utils';
import { writeAgentFile, deleteAgentFile } from './agent-files';
const CODEX_FILE_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

import type { BrowserWindow } from 'electron';

const binaryCache = { path: null as string | null };

export class CodexProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'codex',
    displayName: 'Codex CLI',
    binaryName: 'codex',
    capabilities: {
      sessionResume: true,
      costTracking: false,
      contextWindow: false,
      hookStatus: true,
      configReading: true,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'startup-arg',
      systemPromptInjection: true,
      profiles: false,
      selfTitles: false,
      polledStatus: false,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    return resolveBinary('codex', binaryCache);
  }

  validatePrerequisites(): boolean {
    return validateBinaryExists('codex');
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>, _opts?: { configDir?: string }): Record<string, string> {
    const env = { ...baseEnv };
    env[SESSION_ID_VAR] = sessionId;
    env.PATH = getFullPath();
    // Hooks are installed at, and the rollout watcher scans, the hardcoded
    // ~/.codex: an inherited CODEX_HOME moves the child's config.toml and
    // rollouts out of reach, silently losing .sessionid, statusLine, titles,
    // archive and resume. Session-level values are rejected pre-spawn by
    // UNSUPPORTED_STORAGE_ENV_KEYS.
    removeEnvKey(env, 'CODEX_HOME');
    return env;
  }

  buildArgs(opts: { sessionId: string; cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[] {
    const args: string[] = [];
    if (opts.systemPrompt) {
      args.push('-c', `developer_instructions=${opts.systemPrompt}`);
    }
    if (opts.isResume && opts.cliSessionId) {
      // `codex resume <id> [PROMPT]` takes a trailing prompt (openai/codex#26818):
      // dropping it here silently loses a queued prompt on Restart Session.
      args.push('resume', opts.cliSessionId);
      if (opts.initialPrompt) args.push(opts.initialPrompt);
    } else if (opts.initialPrompt) {
      args.push(opts.initialPrompt);
    }
    if (opts.extraArgs) {
      args.push(...tokenizeArgs(opts.extraArgs));
    }
    return args;
  }

  async installHooks(): Promise<void> {
    installCodexHooks();
  }

  installStatusScripts(): void {}

  cleanup(): void {
    stopConfigWatch();
    cleanupCodexHooks();
    // The rollout watcher is a recursive fs.watch plus a 2s interval: without
    // this it survives quit, and a scan armed within its 500ms arming window
    // fires after cleanupAll() deleted STATUS_DIR and recreates
    // os.tmpdir()/vibeyard with a .sessionid file (Pi/OMP do the same in their
    // cleanup()).
    stopCodexSessionWatcher();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath, 'codex');
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  // Codex hooks write .sessionid per session (exact). The rollout watcher
  // correlates by cwd (per-cwd FIFO over the session_meta of new rollout
  // files): a global spawn-order FIFO let external `codex` runs hijack the
  // oldest pending tab, so it runs only as the fallback for installs
  // without complete hooks.
  onSessionStarted(sessionId: string, cwd: string, win: BrowserWindow): void {
    if (validateCodexHooks().hooks === 'complete') return;
    startCodexSessionWatcher(win);
    registerPendingCodexSession(sessionId, cwd);
  }

  onSessionExited(sessionId: string): void {
    unregisterCodexSession(sessionId);
  }

  async getConfig(projectPath: string): Promise<ProviderConfig> {
    return getCodexConfig(projectPath);
  }

  getShiftEnterSequence(): string | null {
    return null;
  }

  validateSettings(): SettingsValidationResult {
    return validateCodexHooks();
  }

  reinstallSettings(): void {
    installCodexHooks();
  }

  agentsDir(): string {
    return path.join(os.homedir(), '.codex', 'agents');
  }

  async installAgent(slug: string, content: string): Promise<{ filePath: string }> {
    return writeAgentFile(this.agentsDir(), slug, content);
  }

  async removeAgent(slug: string): Promise<void> {
    return deleteAgentFile(this.agentsDir(), slug);
  }

  getTranscriptPath(cliSessionId: string, _projectPath: string): string | null {
    try {
      const root = path.join(os.homedir(), '.codex', 'sessions');
      const suffix = `-${cliSessionId}.jsonl`;
      // sessions are partitioned as YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst].
      // Walk newest-first and return on first match.
      for (const year of descSortedReaddir(root)) {
        const yearDir = path.join(root, year);
        for (const month of descSortedReaddir(yearDir)) {
          const monthDir = path.join(yearDir, month);
          for (const day of descSortedReaddir(monthDir)) {
            const dayDir = path.join(monthDir, day);
            for (const file of descSortedReaddir(dayDir)) {
              if (file.endsWith(suffix) || file.endsWith(`${suffix}.zst`)) return path.join(dayDir, file);
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDescriptor[]> {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    const out: TranscriptDescriptor[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (signal?.aborted) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (depth === 3) {
        for (const entry of entries) {
          if (signal?.aborted) return;
          const m = entry.name.match(CODEX_FILE_RE);
          if (!m) continue;
          out.push({ cliSessionId: m[1], transcriptPath: path.join(dir, entry.name) });
        }
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) return;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
      }
    };
    await walk(root, 0);
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
    if (transcriptPath.endsWith('.zst')) return this.indexCompressedTranscript(transcriptPath);

    const { consume, budget, cwd } = this.createLineConsumer();
    const input = fs.createReadStream(transcriptPath, { end: MAX_INDEX_BYTES - 1 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) consume(line);
    } catch {
      // Best-effort: keep whatever was extracted before the stream failed.
    } finally {
      lines.close();
      input.destroy();
    }
    return { text: budget.join(), cwd: cwd() };
  }

  /**
   * Recent Codex builds compress rollouts to `.jsonl.zst`. The index only
   * needs the head, so decompress a bounded prefix; a truncated tail frame
   * (Codex compresses incrementally) is tolerated the same way a partial
   * write is in the plain path.
   */
  private async indexCompressedTranscript(transcriptPath: string): Promise<{ text: string; cwd: string }> {
    const { consume, budget, cwd } = this.createLineConsumer();
    const input = fs.createReadStream(transcriptPath, { end: MAX_INDEX_BYTES * 8 - 1 });
    const zstd = zlib.createZstdDecompress();
    input.pipe(zstd);
    input.on('error', () => { /* best-effort, same as the plain path */ });
    zstd.on('error', () => { /* truncated tail frame: keep the decompressed head */ });
    const lines = readline.createInterface({ input: zstd, crlfDelay: Infinity });
    try {
      for await (const line of lines) consume(line);
    } catch {
      // Best-effort: keep whatever was extracted before decompression failed.
    } finally {
      lines.close();
      zstd.destroy();
      input.destroy();
    }
    return { text: budget.join(), cwd: cwd() };
  }

  private createLineConsumer(): { consume: (line: string) => void; budget: IndexTextBudget; cwd: () => string } {
    const budget = new IndexTextBudget();
    // Per-index cwd, never a provider field: session-deep-search indexes up to
    // TRANSCRIPT_IO_CONCURRENCY (4) transcripts through this singleton at
    // once, so a shared field made one call return (and persist) another
    // transcript's cwd, which then resumes the session in the wrong repo.
    let cwd = '';
    const consume = (line: string): void => {
      if (!line.trim() || budget.full) return;
      try {
        const entry = JSON.parse(line);
        if (!cwd && entry.type === 'session_meta' && entry.payload?.cwd) cwd = entry.payload.cwd;
        if (entry.type !== 'response_item') return;
        const p = entry.payload;
        if (!p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return;
        let text = '';
        for (const block of p.content) {
          if (block && typeof block.text === 'string') text += block.text + '\n';
        }
        if (text) budget.push(text);
      } catch {
        // partial-write tolerance
      }
    };
    return { consume, budget, cwd: () => cwd };
  }
}

function descSortedReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  binaryCache.path = null;
}
