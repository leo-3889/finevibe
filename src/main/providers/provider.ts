import type { BrowserWindow } from 'electron';
import type { CliProviderMeta, CliSessionStatus, ProviderConfig, SettingsValidationResult } from '../../shared/types';

/** Lightweight pointer to one on-disk transcript, used by global session search. */
export interface TranscriptDescriptor {
  cliSessionId: string;
  /** Absolute path used as the cache key and mtime source for indexing. */
  transcriptPath: string;
  /** Pre-computed cwd, when the format makes it cheap (e.g. read from a sidecar). */
  projectCwd?: string;
  /** Provider-specific project key (Claude slug, Gemini project hash, etc.). Display fallback. */
  projectSlug?: string;
  /** Profile whose config dir this transcript was found under, so resume can reuse it. */
  profileId?: string;
}

export interface CliProvider {
  readonly meta: CliProviderMeta;
  resolveBinaryPath(): string;
  validatePrerequisites(): boolean;
  buildEnv(sessionId: string, baseEnv: Record<string, string>, opts?: { configDir?: string }): Record<string, string>;
  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string; initialPrompt?: string; systemPrompt?: string }): string[];
  installHooks(win?: BrowserWindow | null, projectPath?: string): Promise<void>;
  installStatusScripts(): void;
  cleanup(): void;
  getConfig(projectPath: string): Promise<ProviderConfig>;
  getShiftEnterSequence(): string | null;
  validateSettings(projectPath?: string, configDir?: string): SettingsValidationResult;
  reinstallSettings(): void;
  parseCostFromOutput?(rawText: string): { totalCostUsd: number } | null;
  /** Return the absolute path to the source transcript file for a prior session, if any. */
  getTranscriptPath?(cliSessionId: string, projectPath: string, configDir?: string): string | null;
  /** Cheap enumeration of every on-disk transcript for global session search. */
  discoverTranscripts?(): Promise<TranscriptDescriptor[]>;
  /** Read user-visible text (and optionally the cwd) out of one transcript file. */
  indexTranscript?(transcriptPath: string): Promise<{ text: string; cwd: string }>;
  startConfigWatcher?(win: BrowserWindow, projectPath: string): void;
  stopConfigWatcher?(): void;
  /**
   * Begin CLI session-id discovery for a freshly spawned session. Only
   * providers without a hook system that reports the id implement this
   * (codex tails history.jsonl, pi watches its sessions tree).
   */
  onSessionStarted?(sessionId: string, cwd: string, win: BrowserWindow, configDir?: string): void;
  /**
   * The CLI's own title read from a resolved transcript path, or null when
   * it has none yet. Only meaningful for providers with
   * capabilities.selfTitles — the merged transcript-sync resolves the path
   * once via getTranscriptPath() and polls this, mirroring the result into
   * the `.name` channel (the same channel Claude's statusLine pushes to).
   */
  readSessionTitle?(transcriptPath: string): string | null;
  /**
   * Derive the session's current status from a resolved transcript path,
   * for providers with no hooks (capabilities.polledStatus). The merged
   * transcript-sync resolves the path once via getTranscriptPath() and
   * polls this, mirroring the result into the `.status` channel — the same
   * channel Claude's hooks push to — so the renderer adopts it via the
   * existing status pipeline.
   */
  readSessionStatus?(transcriptPath: string): CliSessionStatus | null;
  /** Cancel pending session-id discovery — PTY exited, or the spawn failed. */
  onSessionExited?(sessionId: string): void;
  /** Absolute path to the user-global agents directory (e.g. ~/.claude/agents). */
  agentsDir?(): string;
  /** Write `<slug>.md` into the agents dir with the given markdown content. */
  installAgent?(slug: string, content: string): Promise<{ filePath: string }>;
  /** Remove `<slug>.md` from the agents dir. Best-effort: missing file is not an error. */
  removeAgent?(slug: string): Promise<void>;
}
