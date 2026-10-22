import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as zlib from 'zlib';
import * as os from 'os';
import type { CliProvider, TranscriptDiscovery } from './provider';
import type { CliProviderMeta, ProviderConfig, SettingsValidationResult } from '../../shared/types';
import { removeEnvKey } from '../../shared/env-vars';
import { tokenizeArgs } from '../../shared/launch-args';
import { getFullPath } from '../pty-manager';
import { resolveBinary, validateBinaryExists, validateBinaryExistsAsync } from './resolve-binary';
import { getCodexConfig } from '../codex-config';
import { installCodexHooks, validateCodexHooks, cleanupCodexHooks, SESSION_ID_VAR } from '../codex-hooks';
import { startCodexSessionWatcher, stopCodexSessionWatcher, registerPendingCodexSession, unregisterCodexSession } from '../codex-session-watcher';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { MAX_INDEX_BYTES, MAX_INDEX_FILE_BYTES, IndexTextBudget, TranscriptDiscoveryScan, readdirForDiscovery } from './transcript-utils';
import { writeAgentFile, deleteAgentFile } from './agent-files';
const CODEX_FILE_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

import type { BrowserWindow } from 'electron';

const binaryCache = { path: null as string | null };

// onSessionStarted ran validateCodexHooks() — several synchronous file
// reads — pre-spawn on EVERY Codex launch (audit P3-5). The hooks status is
// bounded-TTL cached: launches within HOOK_VALIDATION_TTL_MS reuse the last
// result; install/reinstall/settings validation and cleanup refresh the
// cache, so hook repair is seen on the next launch, not a TTL away.
const HOOK_VALIDATION_TTL_MS = 30_000;
let hookValidationCache: { result: SettingsValidationResult; at: number } | null = null;

function validateCodexHooksCached(): SettingsValidationResult {
  const now = Date.now();
  if (hookValidationCache && now - hookValidationCache.at < HOOK_VALIDATION_TTL_MS) {
    return hookValidationCache.result;
  }
  const result = validateCodexHooks();
  hookValidationCache = { result, at: now };
  return result;
}

function invalidateHookValidationCache(): void {
  hookValidationCache = null;
}

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
      // planModeArg intentionally UNSET — VERIFICATION-PENDING. Codex plan mode is
      // GA (rust-v0.94.0 collaboration mode; TUI /plan, Shift+Tab), but
      // `--collaboration-mode` is `codex exec`-only (headless JSON, incompatible
      // with FineVibe's PTY terminal), there is no TUI startup parameter
      // (openai/codex#13377 — the startup config field is removed on main), and
      // the required probe (`codex --help` on an installed binary) could not run
      // on 2026-10-21: the CLI is not installed here. Never ship a planModeArg
      // from docs alone — an unknown flag makes codex exit at startup, bricking
      // every spawn. Probe outcomes + the `/plan` startup-input fallback are in
      // docs/provider-contracts.md and todos/ask-ai-plan-mode-provider-support-plan.md.
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

  // PA-01: async twin so boot can probe every provider concurrently.
  validatePrerequisitesAsync(): Promise<boolean> {
    return validateBinaryExistsAsync('codex');
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
    invalidateHookValidationCache();
  }

  installStatusScripts(): void {}

  cleanup(): void {
    stopConfigWatch();
    cleanupCodexHooks();
    // The rollout watcher is a recursive fs.watch plus a 2s interval: without
    // this it survives quit, and a scan armed within its 500ms arming window
    // fires after cleanupAll() deleted STATUS_DIR and recreates
    // os.tmpdir()/finevibe with a .sessionid file (Pi/OMP do the same in their
    // cleanup()).
    stopCodexSessionWatcher();
    invalidateHookValidationCache();
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
    if (validateCodexHooksCached().hooks === 'complete') return;
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
    const result = validateCodexHooks();
    hookValidationCache = { result, at: Date.now() };
    return result;
  }

  reinstallSettings(): void {
    installCodexHooks();
    invalidateHookValidationCache();
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
  async discoverTranscripts(signal?: AbortSignal): Promise<TranscriptDiscovery> {
    // sessions are partitioned as YYYY/MM/DD/rollout-<ts>-<id>.jsonl[.zst].
    // A readdir failure anywhere in the walk (other than "dir missing")
    // propagates and marks the pass incomplete — a partial tree is not
    // evidence the corpus shrank, and pruning the derived index off it
    // re-reads every rollout on the next search (P2-70).
    const root = path.join(os.homedir(), '.codex', 'sessions');
    const scan = new TranscriptDiscoveryScan();
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (signal?.aborted) return;
      const entries = await readdirForDiscovery(dir, true);
      if (depth === 3) {
        for (const entry of entries) {
          if (signal?.aborted) return;
          const m = entry.name.match(CODEX_FILE_RE);
          if (!m) continue;
          scan.descriptors.push({ cliSessionId: m[1], transcriptPath: path.join(dir, entry.name) });
        }
        return;
      }
      for (const entry of entries) {
        if (signal?.aborted) return;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), depth + 1);
      }
    };
    await scan.collect(root, () => walk(root, 0));
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
          if (block && typeof block.text === 'string') text += `${block.text}\n`;
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

/** @internal Test-only: reset the cached hooks validation */
export function _resetHookValidationCache(): void {
  invalidateHookValidationCache();
}
