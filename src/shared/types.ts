// Shared type definitions used across main, preload, and renderer processes.

import type { TeamDomain } from './team-config.js';
import type { ShareMode } from './sharing-types.js';

export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 2.0;

/** The implicit localhost host id. Every `hostId` param defaults to this
 * (per-host providers plan §2): channels and loaders are full-back-compat —
 * pre-existing records normalize to 'local' at load, never at call sites. */
export const LOCAL_HOST_ID = 'local';

// --- Provider ---

export type ProviderId = 'claude' | 'codex' | 'copilot' | 'gemini' | 'pi' | 'omp' | 'pi-bolt';
type PendingPromptTrigger = 'session-start' | 'startup-arg';

/**
 * UI language tag. Defined here (rather than imported from `renderer/i18n.ts`)
 * because `shared/` is the lowest common denominator between main and
 * renderer; the renderer is the source of truth for the actual catalog.
 */
export type Locale = 'en' | 'zh-CN';

/**
 * The session statuses a provider can report through the `.status` channel.
 * `idle` is renderer-only (PTY exited) and never crosses the channel.
 */
export type CliSessionStatus = 'working' | 'waiting' | 'completed' | 'input';

export interface CliProviderCapabilities {
  sessionResume: boolean;
  costTracking: boolean;
  contextWindow: boolean;
  hookStatus: boolean;
  /**
   * Where `hookStatus` hooks live: 'user' (default) installs into the user
   * config dir; 'project' (Copilot) writes `<project>/.github/hooks/` per
   * project at PTY spawn and deletes them at quit, so a user-scope check is
   * structurally always 'missing' — Setup validates them against the active
   * project instead.
   */
  hookScope?: 'user' | 'project';
  configReading: boolean;
  shiftEnterNewline: boolean;
  pendingPromptTrigger: PendingPromptTrigger;
  planModeArg?: string;
  systemPromptInjection: boolean;
  /** The provider's buildEnv honors a profile's configDir. */
  profiles: boolean;
  /**
   * The CLI titles its sessions itself and the tab adopts the title.
   * When true, the main process polls the provider's readSessionTitle()
   * and mirrors the result into the `.name` channel. Claude self-titles
   * too, but pushes via its statusLine hook, so it does not need polling.
   */
  selfTitles: boolean;
  /**
   * The CLI has no hooks to report status, so the main process polls its
   * on-disk transcript and derives a status (working/completed/idle),
   * mirroring it into the same `.status` channel Claude's hooks push to.
   * Mutually exclusive with hookStatus: a provider is one or the other.
   */
  polledStatus: boolean;
}

export interface CliProviderMeta {
  id: ProviderId;
  displayName: string;
  binaryName: string;
  capabilities: CliProviderCapabilities;
  defaultContextWindowSize: number;
}

// --- Git ---

export interface GitWorktree {
  path: string;
  head: string;
  branch: string | null;
  isBare: boolean;
}

export interface GitFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  area: 'staged' | 'working' | 'untracked' | 'conflicted';
}

// --- Provider Config ---

export interface McpServer { name: string; url: string; status: string; scope: 'user' | 'project'; filePath: string }
export interface Agent { name: string; model: string; category: 'plugin' | 'built-in'; scope: 'user' | 'project'; filePath: string }
export interface Skill { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface Command { name: string; description: string; scope: 'user' | 'project'; filePath: string }
export interface ProviderConfig { mcpServers: McpServer[]; agents: Agent[]; skills: Skill[]; commands: Command[] }
export type ClaudeConfig = ProviderConfig;

// --- Cost / Context (shared with renderer modules) ---

export interface CostInfo {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalDurationMs: number;
  totalApiDurationMs: number;
  model?: string;
}

export interface ContextWindowInfo {
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

// --- Session / State ---

type SessionType =
  | 'mcp-inspector'
  | 'diff-viewer'
  | 'file-reader'
  | 'remote-terminal'
  | 'browser-tab'
  | 'project-tab'
  | 'kanban'
  | 'team';

export interface SessionRecord {
  id: string;
  name: string;
  type?: SessionType;
  providerId?: ProviderId;
  /** Persisted: host this session's provider runs on; absent means 'local'
   * (normalized at load, per-host providers plan §2). */
  hostId?: string;
  args?: string;
  /** Custom environment variables (raw `KEY=VALUE` lines) injected into the PTY on spawn. */
  envVars?: string;
  cliSessionId: string | null;
  mcpServerUrl?: string;
  diffFilePath?: string;
  diffArea?: string;
  worktreePath?: string;
  fileReaderPath?: string;
  fileReaderLine?: number;
  createdAt: string;
  userRenamed?: boolean;
  cost?: CostInfo;
  contextWindow?: ContextWindowInfo;
  remoteHostName?: string;
  /** Persisted: host this session launches through over SSH (`user@host` or `host`), validated by shared/ssh-host.ts. */
  sshHost?: string;
  shareMode?: ShareMode;
  browserTabUrl?: string;
  /** When true, the browser-tab webview uses an isolated partition that doesn't see imported cookies/passwords. */
  browserIsolated?: boolean;
  /** Persisted: identifies which TeamMember spawned this session, if any. */
  teamMemberId?: string;
  /** Persisted, sticky: which Profile backs this session's CLI config dir. Resume must reuse it. */
  profileId?: string;
  /** Transient: initial prompt to inject on first spawn. Not persisted. */
  pendingInitialPrompt?: string;
  /** Transient: system prompt to attach on first spawn. Not persisted (resume must not re-inject). */
  pendingSystemPrompt?: string;
}

// --- Team ---

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  description?: string;
  domain?: TeamDomain;
  systemPrompt: string;
  source: 'predefined' | 'custom';
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  /** When true, member is mirrored as a CLI-provider agent file at ~/.<cli>/agents/<slug>.md. */
  installAsAgent?: boolean;
  /** Sticky slug assigned on first install; preserved across renames so the right file is removed. */
  agentSlug?: string;
  /**
   * Sticky: pins this member's Chat sessions to a specific Profile, which carries
   * the provider (backend) and config dir. Unset → Chat falls back to the
   * project's defaultProfileId, then the provider's global default profile
   * (preferences.defaultProfiles[providerId]), then no profile.
   */
  profileId?: string;
}

export interface TeamData {
  members: TeamMember[];
  predefinedCache?: { fetchedAt: number; suggestions: TeamMember[] };
}

// --- CLI Provider Profiles ---

/**
 * A named CLI-provider profile backed by a separate config directory, injected
 * via the provider's config-dir env var (e.g. CLAUDE_CONFIG_DIR). Lets a user
 * isolate multiple licenses/logins (work vs personal). Claude, Pi, and OMP
 * inject it (CLAUDE_CONFIG_DIR / PI_CODING_AGENT_DIR); the interface stays
 * uniform for future providers.
 */
export interface Profile {
  id: string;
  name: string;
  providerId: ProviderId;
  /** Absolute, resolved config dir (managed under ~/.finevibe/profiles/<id> or a custom path). */
  configDir: string;
  /** True when configDir is the auto-managed path; false when the user supplied a custom path. */
  managed: boolean;
  createdAt: number;
  /** Persisted: host whose filesystem `configDir` lives on; absent means 'local'
   * (normalized at load, per-host providers plan §2). */
  hostId?: string;
}

// --- Multi-host (Phase 1: Hosts registry) ---

export type HostAuthKind = 'key' | 'password';

export type HostEnrollmentStatus = 'draft' | 'probing' | 'auth-ok' | 'enrolled' | 'partial' | 'failed';

/**
 * A named SSH host from the registry (multi-host Phase 1). Zero secret
 * material: passwords/passphrases live in the safeStorage-backed
 * `host-secrets.json`, managed keys in `<userData>/hosts/<id>/` — this record
 * is safe to log (redacted) and to send over IPC both ways.
 */
export interface HostRecord {
  /** crypto.randomUUID(); the only handle the renderer ever sends. */
  id: string;
  /** Display name, 1..64 chars (escaped at render; never injected raw). */
  name: string;
  user: string;
  /** RFC-1123 hostname or bracketed IPv6 literal (grammar in ssh-host.ts). */
  host: string;
  /** 1..65535; default 22. */
  port: number;
  authKind: HostAuthKind;
  /** Managed keys: finevibe-generated, path derived from id. User keys: absolute path picked by the user. */
  privateKeyPath?: string;
  /** True → finevibe owns <userData>/hosts/<id>/id_ed25519. */
  managedKey: boolean;
  enrollmentStatus: HostEnrollmentStatus;
  /** Last failure reason / partial summary (e.g. "provider X missing"). */
  enrollmentDetail?: string;
  enrolledAt?: string;
  lastProbeAt?: string;
  lastProbeOk?: boolean;
  /** SHA256 fingerprint pinned at first successful connect (TOFU). Mismatch = hard refuse. */
  hostKeyFingerprint?: string;
  /** Prerequisite probe results from enrollment (Phase 2 consumers: provider CLIs, node, git). */
  prerequisites?: Record<string, { ok: boolean; version?: string; path?: string }>;
  /** Default folder for new projects on this host (remote-shell cwd, new-project prefill); absent = remote `~`. */
  defaultFolder?: string;
  /** True for the fleet memory server (UR-3): the daemon + forwards role, not a new type. */
  memoryServer?: boolean;
  /** Identity color (validated `#rrggbb`, shared/host-colors.ts): auto-assigned
   * round-robin from HOST_PALETTE at creation, editable per host (plan §5). */
  color?: string;
}

export interface ArchivedSession {
  id: string;
  name: string;
  providerId: ProviderId;
  cliSessionId: string | null;
  createdAt: string;
  /** Absent while the session is still live (`state: 'active'`). */
  closedAt?: string;
  bookmarked?: boolean;
  teamMemberId?: string;
  /** Preserved so a resumed session reuses the same profile config dir (CLAUDE_CONFIG_DIR). */
  profileId?: string;
  /**
   * 'active' while the owning FineVibe session is live (history records the
   * session from creation, not only at close); 'closed' (or absent, for
   * entries written before the field existed) after finalization.
   */
  state?: 'active' | 'closed';
  /** Live session id the active entry mirrors; finalization matches on it. */
  liveSessionId?: string;
  cost: {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
  } | null;
  /** Why the CLI process exited abnormally (e.g. 'unhandled_rejection'); absent on clean exit. */
  exitReason?: string;
  /** Process metadata captured when this session ended; helps correlate OMP logs. */
  exitCode?: number;
  exitSignal?: number;
  processId?: number;
  /** False when a crash was recorded without a resumable transcript. */
  transcriptAvailable?: boolean;
}

export interface InitialContextSnapshot {
  sessionId: string;
  timestamp: string;
  totalTokens: number;
  contextWindowSize: number;
  usedPercentage: number;
}

export interface DeepSearchResult {
  providerId: ProviderId;
  cliSessionId: string;
  projectSlug: string;
  projectCwd: string;
  snippet: string;
  score: number;
  /** Title derived from the first user message — fallback when FineVibe has no name for this session. */
  derivedName?: string;
  /** Profile whose config dir holds this transcript, so resume reopens under the right CLAUDE_CONFIG_DIR. */
  profileId?: string;
}

interface ProjectInsightsData {
  initialContextSnapshots: InitialContextSnapshot[];
  dismissed: string[];
}

// --- Board ---

export type ColumnBehavior = 'inbox' | 'active' | 'terminal' | 'none';

export interface BoardColumn {
  id: string;
  title: string;
  order: number;
  behavior: ColumnBehavior;
  color?: string;
  locked?: boolean;
}

export interface BoardTask {
  id: string;
  title: string;
  prompt: string;
  notes?: string;
  columnId: string;
  order: number;
  sessionId?: string;
  cliSessionId?: string;
  providerId?: ProviderId;
  /** Profile (CLI config dir) to run this task under; falls back to project/global default when unset. */
  profileId?: string;
  /** Team member to assign this task to; running it starts a team-chat session as that member. */
  assigneeId?: string;
  planMode?: boolean;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TagDefinition {
  name: string;
  color: string;
}

/** Named cluster of adjacent session tabs in the tab strip. */
export interface TabGroupRecord {
  id: string;
  name: string;
  /** Member session ids, kept in project.sessions order. */
  sessionIds: string[];
  /** Index into the tab-group color palette. */
  colorIndex: number;
}

export interface BoardData {
  columns: BoardColumn[];
  tasks: BoardTask[];
  tags?: TagDefinition[];
}

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  sessions: SessionRecord[];
  activeSessionId: string | null;
  layout: {
    mode: 'tabs' | 'split' | 'swarm';
    splitPanes: string[];
    splitDirection: 'horizontal' | 'vertical';
  };
  board?: BoardData;
  sessionHistory?: ArchivedSession[];
  insights?: ProjectInsightsData;
  defaultArgs?: string;
  /** Coding provider for new sessions in this project; absent follows global default. */
  defaultProvider?: ProviderId;
  /** Default profile applied to new sessions in this project (overridden per-session). */
  defaultProfileId?: string;
  defaultEnv?: string;
  terminalPanelOpen?: boolean;
  terminalPanelHeight?: number;
  readiness?: ReadinessResult;
  readinessHistory?: ReadinessSnapshot[];
  overviewLayout?: OverviewLayout;
  githubLastSeen?: Record<string, string>;
  /** Hover-to-group tab clusters; absent on projects that never grouped anything (no migration needed). */
  tabGroups?: TabGroupRecord[];
}

/**
 * One legacy `~/.vibeyard/state.json` project offered for one-time import
 * into the live project list (see src/main/legacy-import.ts).
 */
export interface ImportableLegacyProject {
  name: string;
  path: string;
  /** Session count of the legacy entry; shown so the import picker says what a project carries. */
  sessions: number;
}

// --- Overview Widgets ---

export type OverviewWidgetType =
  | 'readiness'
  | 'provider-tools'
  | 'github-prs'
  | 'github-issues'
  | 'team'
  | 'kanban'
  | 'sessions'
  | 'favorite-sessions'
  | 'usage-stats'
  | 'top-files-by-tokens';

export interface OverviewWidget {
  id: string;
  type: OverviewWidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: Record<string, unknown>;
}

export interface OverviewLayout {
  gridVersion: 1;
  widgets: OverviewWidget[];
}

// --- GitHub ---

export interface GithubItem {
  number: number;
  title: string;
  state: 'open' | 'closed';
  user: { login: string; avatar_url: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present on issues that are PRs (Issues API includes PRs); absent on real issues. */
  pull_request?: { url: string };
  /** Optional PR-only fields populated when fetching from /pulls. */
  draft?: boolean;
  merged_at?: string | null;
  comments?: number;
  labels?: { name: string; color: string }[];
}

export interface GithubFetchResult {
  ok: boolean;
  items?: GithubItem[];
  error?: string;
}

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** Which sidebar sections the user has enabled in the Appearance preferences. */
export interface SidebarViews {
  gitPanel: boolean;
  sessionHistory: boolean;
  discussions: boolean;
  fileTree: boolean;
  /** Show the global cross-project "Active Sessions" section in the sidebar. */
  activeSessions: boolean;
}

export interface Preferences {
  soundOnSessionWaiting: boolean;
  notificationsDesktop: boolean;
  debugMode: boolean;
  sessionHistoryEnabled: boolean;
  insightsEnabled: boolean;
  autoTitleEnabled: boolean;
  confirmCloseWorkingSession: boolean;
  zoomFactor?: number;
  defaultProvider?: ProviderId;
  /** UI language tag. See `Locale` for the supported set. */
  locale?: Locale;
  /** Per-provider global fallback profile, applied when neither the session nor the project specifies one. */
  defaultProfiles?: Partial<Record<ProviderId, string>>;
  /**
   * Per-provider default for "Plan mode" on the checkbox-less quick-send
   * paths (Ask AI / Inspect / Draw / Flow "Send to AI", Kanban create) and
   * the New Session modal's initial tick. Absent = `true` for plan-capable
   * providers (the pre-setting behavior — no upgrade surprise); providers
   * without a verified `planModeArg` are always off regardless
   * (`isPlanModeSupported` short-circuits, `buildPlanSessionArgs` drops the
   * flag). Per-provider rows: Preferences → General (`pref-plan-mode-<id>`).
   */
  planModeDefaults?: Partial<Record<ProviderId, boolean>>;
  statusLineConsent?: 'granted' | 'declined' | null;
  // The foreign statusLine command the user was asked about when they made
  // the consent decision. Used to detect new conflicts (different command)
  // vs the previously-acknowledged one.
  statusLineConsentCommand?: string | null;
  // P1-14: per-profile-dir statusLine consent, keyed by settings-guard's
  // consentDirKey. The default ~/.claude keeps the global fields above; a
  // profile dir's Keep/Replace never governs another dir (and vice versa).
  statusLineConsentByDir?: Record<string, { consent: 'granted' | 'declined'; command: string | null }>;
  copyOnSelect?: boolean;
  /**
   * Where an Ask AI / new-session send from a file pane or browser tab opens:
   * 'switch' (absent = default) makes the new session the active tab; 'stay'
   * runs it in the background and keeps focus on the current tab.
   */
  askAiFocus?: 'switch' | 'stay';
  /**
   * Root directory for new projects. The Add-project modal pre-fills the path
   * as `<defaultProjectsFolder>/<name>` while the name is edited, and a git
   * URL checkout lands at `<defaultProjectsFolder>/<repo>`. Absent/'' = unset:
   * the free-path behavior (and the checkout browse-folder prompt) is kept.
   */
  defaultProjectsFolder?: string;
  keybindings?: Record<string, string>;
  theme?: 'dark' | 'light';
  readinessExcludedProviders?: ProviderId[];
  sidebarViews?: SidebarViews;
  boardCardMetrics?: boolean;
  chromeImport?: ChromeImportSummary;
}

// --- Chrome Import ---

export interface ChromeProfile {
  id: string;
  displayName: string;
}

interface ChromeImportSummary {
  lastImportedAt: number;
  profileId: string;
  cookieCount: number;
  skippedV11: number;
}

export interface ChromeImportProgress {
  stage: 'starting' | 'copy' | 'cookies' | 'done' | 'error';
  done?: number;
  total?: number;
  skippedV11?: number;
  errors?: number;
  message?: string;
}

export interface ChromeImportOptions {
  profileId: string;
}

export interface ChromeImportResult {
  ok: boolean;
  cookieCount: number;
  skippedV11: number;
  errors: string[];
  /**
   * Non-fatal problems that did not block the imported cookies — e.g. the
   * Linux keyring diagnosis (secret-tool missing, `peanuts` fallback)
   * reported alongside a partial import. Shown next to the summary.
   */
  warnings?: string[];
}

/**
 * Theme/zoom slice served synchronously on the `store:startup-prefs` channel
 * so the renderer can apply them before its first paint; the full state load
 * follows asynchronously.
 */
export interface StartupPrefs {
  theme: 'dark' | 'light' | null;
  zoomFactor: number | null;
}

export const BROWSER_DEFAULT_PARTITION = 'persist:finevibe-browser';

// --- Settings Validation ---

export interface SettingsValidationResult {
  statusLine: 'missing' | 'finevibe' | 'foreign';
  hooks: 'missing' | 'complete' | 'partial';
  foreignStatusLineCommand?: string;
  /** SA-P2-1: statusLine is foreign AND the user's declined consent covers
   * this exact command — a deliberate Keep, not an issue to fix. */
  userKeptStatusLine?: boolean;
  hookDetails: Record<string, boolean>;
}

export interface SettingsWarningData {
  sessionId: string;
  /** SA-P1-2: the provider the validation was computed from — the Fix
   * Settings CTA must reinstall THIS provider's settings, not Claude's. */
  providerId: ProviderId;
  statusLine: SettingsValidationResult['statusLine'];
  hooks: SettingsValidationResult['hooks'];
  /** P2-127: the profile config dir the validation was computed from;
   * undefined = the default ~/.claude. The Fix Settings CTA repairs THIS dir. */
  configDir?: string;
  /** P2-55/P2-86: the project cwd the validation was computed from;
   * Copilot's hooks are project-scoped, so the Fix Settings CTA repairs
   * THIS project (and settings:validate re-checks it), not the user scope. */
  projectPath?: string;
  /** The foreign statusLine command, present when statusLine === 'foreign'
   * (P1-14: the banner's dismissal records a Keep bound to this command). */
  foreignStatusLineCommand?: string;
}

export interface StatusLineConflictData {
  foreignCommand: string;
}

export interface PersistedState {
  version: 1;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  /** Optional at the persistence boundary: a `version: 1` file predating
   * this field (peer share, hand-edit, downgrade) parses verbatim, so every
   * loader normalizes it once (`store.ts` on the main side,
   * `hydrateLoadedState` on the renderer side) and consumers read the
   * normalized object, never this optional field. */
  preferences?: Preferences;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  lastSeenVersion?: string;
  appLaunchCount?: number;
  starPromptDismissed?: boolean;
  discussionsLastSeen?: string;
  team?: TeamData;
  /** Global, provider-scoped CLI profiles (e.g. Claude work/personal config dirs). */
  profiles?: Profile[];
  /**
   * Named SSH hosts (multi-host Phase 1). Optional at the persistence
   * boundary like `preferences`: normalized once by each loader
   * (`store.ts` on the main side, `hydrateLoadedState` on the renderer side)
   * via `validateHostRecordShape`; invalid entries are dropped with a log.
   * Carries zero secret material (see `src/main/hosts/secrets.ts`).
   */
  hosts?: HostRecord[];
}

// --- AI Readiness ---

export type ReadinessCheckStatus = 'pass' | 'fail' | 'warning';

export type ReadinessEffort = 'low' | 'medium' | 'high';

export interface ReadinessCheck {
  id: string;
  name: string;
  status: ReadinessCheckStatus;
  description: string;
  score: number;
  maxScore: number;
  fixPrompt?: string;
  providerIds?: ProviderId[];
  effort?: ReadinessEffort;
  impact?: number;
  rationale?: string;
  /**
   * Advisory row: shown and filterable like any other check, but excluded from the category
   * score and from quick-win ranking. Used where a single project can produce an unbounded
   * number of rows (one per nested instruction file), which would otherwise let file count
   * dominate a weighted category.
   */
  informational?: boolean;
}

export interface ReadinessCategory {
  id: string;
  name: string;
  weight: number;
  score: number;
  checks: ReadinessCheck[];
}

export interface ReadinessResult {
  overallScore: number;
  categories: ReadinessCategory[];
  scannedAt: string;
}

export interface ReadinessSnapshot {
  timestamp: string;
  overallScore: number;
  categoryScores: Record<string, number>;
}

// --- Cost / Context ---

export interface CostData {
  cost: { total_cost_usd: number; total_duration_ms: number; total_api_duration_ms: number };
  model?: string;
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

// --- Tool Failure ---

/**
 * A tool signal from a CLI hook, dispatched by consumers on `tool_name`.
 *
 * Not strictly a *failure*: a `Read` truncated at the token cap is a successful
 * tool call that still arrives here, tagged with `TOKEN_TRUNCATION_SENTINEL`,
 * because it needs the same one-shot file → IPC delivery. Adding a parallel
 * channel would cost a KNOWN_EXTENSIONS entry, a second suffix-stripping branch
 * in `extractSessionId`, an IPC channel and a preload binding — to reach
 * consumers that would still filter by `tool_name` anyway.
 */
export interface ToolFailureData {
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

// --- Session Inspector ---

export type InspectorEventType =
  // Core 7 (status + inspector)
  | 'session_start' | 'user_prompt' | 'tool_use' | 'tool_failure'
  | 'stop' | 'stop_failure' | 'permission_request'
  // Inspector-only events
  | 'permission_denied'
  | 'pre_tool_use'
  | 'subagent_start' | 'subagent_stop'
  | 'notification'
  | 'pre_compact' | 'post_compact'
  | 'session_end'
  | 'task_created' | 'task_completed'
  | 'worktree_remove'
  | 'cwd_changed' | 'file_changed' | 'config_change'
  | 'elicitation' | 'elicitation_result'
  | 'instructions_loaded'
  | 'teammate_idle'
  | 'status_update';

export interface InspectorEvent {
  type: InspectorEventType;
  timestamp: number;
  hookEvent: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  cost_snapshot?: { total_cost_usd: number; total_duration_ms: number };
  context_snapshot?: { total_tokens: number; context_window_size: number; used_percentage: number };
  // Copied verbatim from the hook payload by INSPECTOR_FIELDS in claude-cli.ts.
  // Keep the two lists in step — a name here with no counterpart there is dead.
  duration_ms?: number;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  prompt?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  model?: string;
  reason?: string;
  error_details?: string;
  task_id?: string;
  task_subject?: string;
  teammate_name?: string;
  worktree_path?: string;
  file_path?: string;
  event?: string;
  new_cwd?: string;
  mcp_server_name?: string;
  /** Elicitation discriminator: 'form' | 'url'. */
  mode?: string;
  action?: string;
  /**
   * C2R-02: monotonic ingestion id, stamped by session-inspector-state's
   * addEvents. The retention array rotates in place at the 2000-event cap,
   * so an array index is not a stable identity; the timeline's expandable
   * row keys and its rotation guard use this instead.
   */
  seq?: number;
}

export interface ToolUsageStats {
  tool_name: string;
  calls: number;
  failures: number;
  totalCost: number;
}

export interface ContextDataPoint {
  timestamp: number;
  usedPercentage: number;
  totalTokens: number;
}

// --- MCP ---

export interface McpResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// --- Usage Stats ---

interface StatsDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface StatsModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: StatsDailyActivity[];
  dailyModelTokens: { date: string; tokensByModel: Record<string, number> }[];
  modelUsage: Record<string, StatsModelUsage>;
  totalSessions: number;
  totalMessages: number;
  longestSession: { sessionId: string; duration: number; messageCount: number; timestamp: string };
  firstSessionDate: string;
  hourCounts: Record<string, number>;
}

// --- Filesystem IPC ---

/** A single filesystem change emitted by the directory watcher (chokidar-backed). */
export type FsChangeType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

export interface FsChange {
  /** Absolute path of the entry that changed. */
  path: string;
  /** Absolute path of the parent directory (the watched dir the change belongs to). */
  dir: string;
  type: FsChangeType;
}

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'binary' | 'error' };

export type FileStatResult =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false };

export interface TopFile {
  path: string;
  tokens: number;
  size: number;
}

export type TopFilesResult =
  | { ok: true; files: TopFile[]; scanned: number; skipped: number }
  | { ok: false };

/**
 * Why a clipboard write happened. The renderer reports intent; the main process
 * owns what each one means per platform (on Linux a 'selection' copy also
 * populates the X11 PRIMARY selection so middle-click paste works).
 */
export type ClipboardSource = 'selection' | 'explicit';

/**
 * Every clipboard flavor the terminal can turn into input. Main owns the
 * clipboard: it reads text, turns an image into `imagePath` (a file in the paste
 * temp dir) and reads a file list as absolute paths, because every provider takes
 * attachments as a path — a drop injects the same string. Precedence belongs to
 * the renderer: text, files, image, markup, then a raw Ctrl+V forward for a
 * flavor neither side translates; an empty clipboard sends nothing.
 */
export type ClipboardPastePayload = {
  /** Plain text, the flavor a shell consumes verbatim. */
  text: string;
  /** Markup source, present only when a rich-text copy carries HTML and no text. */
  html: string;
  /** Absolute paths the clipboard carries a list of (browser/Finder/Explorer/Nautilus copies). */
  files: string[];
  /** Temp path for a clipboard image, which has no path of its own. */
  imagePath: string | null;
  /** False only for a truly empty clipboard; any other untranslated flavor forwards Ctrl+V. */
  hasContent: boolean;
  /** P4: true when main cut the text at the 8 Mi paste bound — a visible truncation the renderer must surface. */
  textTruncated?: boolean;
};

/** One disk-space reading for the volume that hosts app userData. Emitted
 * by the disk-health preflight (src/main/disk-health.ts) on state
 * transitions only, and served on `disk-health:get` for the renderer. */
export type DiskHealth = { state: 'ok' | 'low' | 'unknown'; availableBytes?: number; checkedAt: string };
