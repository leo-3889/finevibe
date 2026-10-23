import type { FinevibeApi } from './types.js';
import type { SessionRecord, ProjectRecord, Preferences, PersistedState, ArchivedSession, ProviderId, CostInfo, ContextWindowInfo, InitialContextSnapshot, ReadinessResult, TeamMember, TeamData, Profile, OverviewLayout, SidebarViews } from '../shared/types.js';
import type { ShareMode } from '../shared/sharing-types.js';
import { getProviderCapabilities, getProviderAvailabilitySnapshot } from './provider-availability.js';
import { pruneGithubLastSeen } from '../shared/github-last-seen.js';
import { basename } from '../shared/platform.js';
import { isCliSession } from './session-utils.js';
import {
  archiveSession as archiveSessionPure,
  archiveSessionOnCreate,
  findCreateEntry,
  syncCreateEntryCliId,
} from './state/session-archive.js';
import {
  buildResumedSession,
  buildResumedSessionFromCliId,
  clearSessionHistory as clearSessionHistoryPure,
  findCliSessionTab,
  getSessionHistory as getSessionHistoryPure,
  removeHistoryEntry as removeHistoryEntryPure,
  resolveResumeSource,
  toggleBookmark as toggleBookmarkPure,
} from './state/session-history.js';
import {
  attachSessionToProject,
  buildBrowserTabSession,
  buildCliSession,
  buildDiffViewerSession,
  buildFileReaderSession,
  buildKanbanSession,
  buildMcpInspectorSession,
  buildProjectTabSession,
  buildRemoteSession,
  buildTeamSession,
} from './state/session-factory.js';
import { NavHistory } from './state/nav-history.js';
import { defaultSessionName } from './state/session-naming.js';
import { createDefaultBoard, ensureProjectDefaults, hydrateLoadedState, serializeForSave } from './state/persistence.js';
import {
  applyMemberPatch,
  buildNewMember,
  buildTeamChatSession,
  isSystemPromptOversize,
  type TeamChatOpts,
  fireAndForgetRemoveAgent,
  reconcileAgent as reconcileAgentPure,
  removeMember,
  resolveTeamChatBackend,
  syncAgentInstall as syncAgentInstallPure,
  uniqueMemberId,
} from './state/team-state.js';
import {
  browserTabNameFromUrl,
  buildPlanSessionArgs,
  findExistingBrowserTab,
  findExistingDiffViewer,
  findExistingFileReader,
  findExistingTabByType,
  resolveCliProvider,
  resolvePlanProvider,
  resolveProfile,
  resolveProjectFilePath,
} from './state/specialized-sessions.js';
import {
  addInsightSnapshot as addInsightSnapshotPure,
  dismissInsight as dismissInsightPure,
  isInsightDismissed as isInsightDismissedPure,
  setProjectReadiness as setProjectReadinessPure,
} from './state/insights-state.js';
import {
  collectRemovalIds,
  cycleSessionId,
  reorderSessionInProject,
  sessionIdAtIndex,
  toggleSwarmMode,
} from './state/layout-state.js';
import {
  groupTabsInProject,
  pruneSessionFromTabGroups,
  renameTabGroupInProject,
  ungroupInProject,
} from './state/tab-group-state.js';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState, ArchivedSession } from '../shared/types.js';

export const MAX_SESSION_NAME_LENGTH = 60;
export const MAX_PROJECT_NAME_LENGTH = 80;

declare global {
  interface Window {
    finevibe: FinevibeApi;
  }
}

type EventType =
  | 'project-added'
  | 'project-removed'
  | 'project-changed'
  | 'session-added'
  | 'session-removed'
  | 'session-changed'
  | 'layout-changed'
  | 'preferences-changed'
  | 'terminal-panel-changed'
  | 'history-changed'
  | 'insights-changed'
  | 'readiness-changed'
  | 'sidebar-toggled'
  | 'cli-session-cleared'
  | 'board-changed'
  | 'team-changed'
  | 'profiles-changed'
  | 'github-unread-changed'
  | 'state-loaded';

type EventCallback = (data?: unknown) => void;

/** What a `session-changed` fan-out was caused by; see {@link SessionChangedPayload}. */
export type SessionChangeKind = 'activate' | 'add' | 'remove' | 'reorder' | 'metadata';

/**
 * `session-changed` payload. The event used to be emitted payload-less, so
 * every subscriber (tab strip, split layout, sidebar badge, git status, board
 * sync) had to assume the whole session set had changed and rebuild
 * everything. The payload names the mutation class and, when one session owns
 * it, which session — a tab click no longer has to look like a tab-set
 * rewrite. Subscribers MUST keep working when the argument is absent
 * (defensive full path): the payload is an optimization, not a requirement.
 * Cli-id and title adoption are `metadata`.
 * `deferRender: true` marks an event inside a batch close: full-strip/layout
 * consumers MUST skip their render — the batch's trailing payload-less-kick
 * `session-changed` (no deferRender) renders once for the whole batch.
 */
export interface SessionChangedPayload {
  sessionId?: string;
  kind: SessionChangeKind;
  deferRender?: boolean;
}

/**
 * Run `cb` on the coming frame. `requestAnimationFrame` in the renderer; a
 * 16 ms timer in hosts without a DOM (the node-env renderer tests), so the
 * coalescing semantics under test are the semantics shipped.
 */
function scheduleFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, 16);
}

const defaultPreferences: Preferences = {
  soundOnSessionWaiting: true,
  notificationsDesktop: true,
  debugMode: false,
  sessionHistoryEnabled: true,
  insightsEnabled: true,
  autoTitleEnabled: true,
  confirmCloseWorkingSession: true,
  copyOnSelect: false,
  zoomFactor: 1.0,
  readinessExcludedProviders: [],
  sidebarViews: { gitPanel: true, sessionHistory: true, discussions: true, fileTree: true, activeSessions: true },
  boardCardMetrics: true,
  locale: 'en',
  defaultProjectsFolder: '',
};

class AppState {
  /** Leading-edge persist throttle window; see persist(). */
  static readonly PERSIST_THROTTLE_MS = 200;
  private state: PersistedState = { version: 1, projects: [], activeProjectId: null, preferences: { ...defaultPreferences } };
  private listeners = new Map<EventType, Set<EventCallback>>();
  private nav = new NavHistory();
  /** sessionId → owning project + session record, kept in sync by the add/remove paths (O(1) lookups). */
  private sessionIndex = new Map<string, { project: ProjectRecord; session: SessionRecord }>();
  /** False until load() completes; see the `loaded` getter. */
  private loadedFlag = false;
  private warnedPrematurePersist = false;
  /** Coalesced persist for high-frequency cost/context ticks (see scheduleCostFlush). */
  private costFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Leading-edge persist throttle (see persist). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistAt = 0;
  /** PA-15: a write is scheduled on the coming frame; see persist(). */
  private persistFrameScheduled = false;
  /** Bumped by flushPersist so the cancelled frame callback cannot write later. */
  private persistFrameToken = 0;
  /**
   * PA-25: transcript availability prefetched asynchronously, keyed
   * sessionId → `providerId|cliSessionId` → exists. The archive gate used to
   * call `session:transcriptExistsSync` — a synchronous IPC that blocked the
   * whole renderer for a main-side stat/decompress on EVERY archivable close.
   * The flag is filled when a cli id is bound; a missing entry (restored tab,
   * probe still in flight) means "present", i.e. the gate degrades to
   * best-effort archiving. That false positive is cheap and self-healing:
   * `resumeFromHistorySafe` re-checks asynchronously and drops the row when
   * the transcript is really gone. One entry per session: a new cli id
   * replaces the map, so a tab that `/clear`s often cannot grow it.
   */
  private transcriptFlags = new Map<string, Map<string, boolean>>();

  private pushNav(sessionId: string | null | undefined): void {
    this.nav.push(sessionId);
  }

  private pruneNav(sessionId: string): void {
    this.nav.prune(sessionId);
  }

  /** Resolve a session id to both the session and its owning project (O(1) via sessionIndex). */
  findSessionWithProject(
    sessionId: string,
  ): { project: ProjectRecord; session: SessionRecord } | undefined {
    return this.sessionIndex.get(sessionId);
  }

  /** Rebuild the O(1) session index from the whole state (used after a full state load). */
  private rebuildSessionIndex(): void {
    this.sessionIndex.clear();
    for (const project of this.state.projects) {
      for (const session of project.sessions) {
        this.sessionIndex.set(session.id, { project, session });
      }
    }
  }

  private findProjectBySession(sessionId: string): ProjectRecord | undefined {
    return this.findSessionWithProject(sessionId)?.project;
  }

  navigateBack(): void {
    this.stepNav(-1);
  }

  navigateForward(): void {
    this.stepNav(1);
  }

  private stepNav(direction: 1 | -1): void {
    const id = this.nav.findNextValid(direction, (sid) => !!this.findProjectBySession(sid));
    if (!id) return;
    const project = this.findProjectBySession(id)!;
    this.nav.withSuppression(() => {
      const projectChanged = this.state.activeProjectId !== project.id;
      this.state.activeProjectId = project.id;
      project.activeSessionId = id;
      this.persist();
      if (projectChanged) this.emit('project-changed');
      this.emitSessionChanged({ sessionId: id, kind: 'activate' });
    });
  }

  on(event: EventType, cb: EventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  private emit(event: EventType, data?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  /** Every `session-changed` fan-out goes through here — see {@link SessionChangedPayload}. */
  private emitSessionChanged(payload: SessionChangedPayload): void {
    this.emit('session-changed', payload);
  }

  async load(): Promise<void> {
    let loaded: PersistedState | null = null;
    try {
      loaded = (await window.finevibe.store.load()) as PersistedState | null;
    } catch (err) {
      // A failed load must not leave loadedFlag false forever: every later
      // persist() would be dropped by the premature-persist guard and the
      // session would silently never save anything.
      console.error('[state] store.load() failed; starting from defaults', err);
    }
    if (loaded && loaded.version === 1) {
      this.state = loaded;
      hydrateLoadedState(this.state, defaultPreferences);
    }
    ensureProjectDefaults(this.state);
    // Everything below reads disk-backed state, so the state is loaded from
    // here on — including the launch-count persist just below.
    this.loadedFlag = true;

    if (!this.state.starPromptDismissed) {
      this.state.appLaunchCount = (this.state.appLaunchCount ?? 0) + 1;
      this.persist();
    }
    this.rebuildSessionIndex();
    this.emit('state-loaded');
    // PA-25: seed the archive gate's transcript flags for the tabs restored
    // from disk. Deliberately sequential and off the load path: the flag is
    // only read when a tab closes, so a parallel fan-out of main-side
    // stat/decompress probes during startup would buy nothing on the boot
    // critical path (see PA-01).
    void this.prefetchRestoredTranscriptFlags();
  }

  private persist(): void {
    // Persisting before load() would write the default in-memory state over the
    // real state.json, which is how saved preferences silently vanish. Reads
    // before load are fine — components initialize pre-load and re-apply on
    // `state-loaded` (see docs/ui-conventions.md) — writes are not, so the
    // write itself is dropped, not just warned about.
    if (!this.loadedFlag) {
      if (!this.warnedPrematurePersist) {
        this.warnedPrematurePersist = true;
        console.warn('[state] persist before appState.load() dropped; defaults would overwrite saved state');
      }
      return;
    }
    // PA-15: schedule the write on the coming frame instead of running it
    // inside the mutation that triggered it. Every persist serializes the
    // whole state and structured-clones it over IPC, and the old leading edge
    // paid that synchronously in the tab click / rename / cli-id adoption that
    // caused it — a burst cloned per mutation, and even ONE isolated mutation
    // cloned inside the interaction. Frame coalescing makes a burst (and an
    // isolated mutation) clone once per frame; `throttledWrite` keeps the
    // leading-edge 200 ms throttle, so a mutation lands at most one frame
    // after the action instead of a full throttle window (what a pure
    // trailing debounce would cost), and `flushPersist` — the beforeunload
    // hook in index.ts — keeps the quit-path flush semantics.
    if (this.persistFrameScheduled) return;
    this.persistFrameScheduled = true;
    const token = this.persistFrameToken;
    const run = (): void => {
      // flushPersist() bumped the token: this state is already on disk.
      if (token !== this.persistFrameToken) return;
      this.persistFrameScheduled = false;
      this.throttledWrite();
    };
    // S3-03: Chromium never runs animation-frame callbacks for a hidden
    // document — with the window minimized (the app's designed operating
    // mode for agent swarms: git-status and the discussions badge both
    // gate on document.hidden) the frame callback never fired, the latch
    // above never cleared, and ZERO state writes reached disk for the
    // whole hidden period; a crash then lost every session/rename/cost
    // change. Timers keep running while hidden: fall back to one on the
    // throttle window.
    if (typeof document !== 'undefined' && document.hidden) {
      setTimeout(run, AppState.PERSIST_THROTTLE_MS);
    } else {
      scheduleFrame(run);
    }
  }

  /**
   * The leading-edge 200 ms throttle, driven by the frame callback, by its own
   * trailing timer, and by nothing else: `persist()` is the only caller above
   * it, so the whole state is serialized at most once per frame.
   * Clamped at zero: a backwards wall-clock jump (resume-from-suspend NTP
   * correction, restored VM snapshot) makes `elapsed` negative, arming the
   * trailing save for `PERSIST_THROTTLE_MS - elapsed` — minutes/hours —
   * while the armed-timer guard below drops every write, so mutations stay
   * memory-only for that whole window. Clamping bounds the worst case to one
   * throttle window.
   */
  private throttledWrite(): void {
    const elapsed = Math.max(0, Date.now() - this.lastPersistAt);
    if (elapsed >= AppState.PERSIST_THROTTLE_MS && this.persistTimer === null) {
      this.writeStateNow();
      return;
    }
    if (this.persistTimer !== null) return; // trailing save already armed
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeStateNow();
    }, AppState.PERSIST_THROTTLE_MS - elapsed);
  }

  /** Serialize + ship right now; the only writer of the store. */
  private writeStateNow(): void {
    this.lastPersistAt = Date.now();
    window.finevibe.store.save(serializeForSave(this.state));
  }

  /**
   * Drop the pending frame and the armed trailing save, write immediately
   * (quit paths, tests). Cancelling the frame is what keeps the beforeunload
   * flush the LAST write: a frame callback that fired afterwards would arm a
   * trailing save for 200 ms past teardown.
   */
  flushPersist(): void {
    this.persistFrameToken++;
    this.persistFrameScheduled = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.writeStateNow();
  }

  /**
   * S1-03: the beforeunload flush. store:save's async write can lose the
   * race with process exit; saveSync blocks this renderer until main has
   * written state.json synchronously (store.saveStateSync), so the window
   * can only tear down after the write is on disk.
   */
  flushPersistSync(): void {
    this.persistFrameToken++;
    this.persistFrameScheduled = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.lastPersistAt = Date.now();
    window.finevibe.store.saveSync(serializeForSave(this.state));
  }

  /**
   * Coalesce high-frequency cost/context ticks into a single persist ~1s later.
   * Each tick costs a full serialize + structured clone over IPC; the 1s window
   * is short enough that a quit at any point loses at most ~1s of cost data
   * (the main-side store flushes on quit).
   */
  private scheduleCostFlush(): void {
    if (this.costFlushTimer !== null) return;
    this.costFlushTimer = setTimeout(() => {
      this.costFlushTimer = null;
      this.persist();
    }, 1000);
  }

  get projects(): ProjectRecord[] {
    return this.state.projects;
  }

  get activeProjectId(): string | null {
    return this.state.activeProjectId;
  }

  get activeProject(): ProjectRecord | undefined {
    return this.state.projects.find((p) => p.id === this.state.activeProjectId);
  }

  get activeSession(): SessionRecord | undefined {
    const project = this.activeProject;
    if (!project) return undefined;
    return project.sessions.find((s) => s.id === project.activeSessionId);
  }

  get sidebarWidth(): number | undefined {
    return this.state.sidebarWidth;
  }

  setSidebarWidth(width: number): void {
    this.state.sidebarWidth = width;
    this.persist();
  }

  get sidebarCollapsed(): boolean {
    return this.state.sidebarCollapsed ?? false;
  }

  toggleSidebar(): void {
    this.state.sidebarCollapsed = !this.sidebarCollapsed;
    this.persist();
    this.emit('sidebar-toggled');
  }

  get discussionsLastSeen(): string | undefined {
    return this.state.discussionsLastSeen;
  }

  setDiscussionsLastSeen(timestamp: string): void {
    this.state.discussionsLastSeen = timestamp;
    this.persist();
  }

  setTerminalPanelOpen(open: boolean): void {
    const project = this.activeProject;
    if (!project) return;
    project.terminalPanelOpen = open;
    this.persist();
    this.emit('terminal-panel-changed');
  }

  setTerminalPanelHeight(height: number): void {
    const project = this.activeProject;
    if (!project) return;
    project.terminalPanelHeight = height;
    this.persist();
  }

  get lastSeenVersion(): string | undefined {
    return this.state.lastSeenVersion;
  }

  setLastSeenVersion(version: string): void {
    this.state.lastSeenVersion = version;
    this.persist();
  }

  get appLaunchCount(): number {
    return this.state.appLaunchCount ?? 0;
  }

  get starPromptDismissed(): boolean {
    return this.state.starPromptDismissed ?? false;
  }

  dismissStarPrompt(): void {
    this.state.starPromptDismissed = true;
    this.persist();
  }

  /** True once load() has populated persisted state. */
  get loaded(): boolean {
    return this.loadedFlag;
  }

  get preferences(): Preferences {
    // Single accessor (P2-84): a persisted state file may omit
    // `preferences`; `load()` normalizes via `hydrateLoadedState`, and this
    // lazy fill covers reads before `load()` (pre-hydration defaults).
    // Callers that render from this re-apply on
    // `state-loaded`/`preferences-changed`.
    const prefs = this.state.preferences;
    if (prefs) return prefs;
    this.state.preferences = { ...defaultPreferences };
    return this.state.preferences;
  }

  /** Sidebar-section lookup with the default-on fallback baked in. */
  sidebarView(key: keyof SidebarViews): boolean {
    return this.preferences.sidebarViews?.[key] ?? true;
  }

  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.preferences[key] = value;
    this.persist();
    this.emit('preferences-changed');
  }

  /**
   * Apply many preference keys with ONE persist + ONE 'preferences-changed'
   * emit. The emit re-themes every live terminal (index.ts), so a settings
   * save that touches N keys must not fire it N times.
   */
  setPreferences(entries: Partial<Preferences>): void {
    const keys = Object.keys(entries) as (keyof Preferences)[];
    if (keys.length === 0) return;
    // Union-key per-entry assignment is untypeable; Object.assign applies
    // exactly the Partial<Preferences> pairs entries carries.
    Object.assign(this.preferences, entries);
    this.persist();
    this.emit('preferences-changed');
  }

  /** Convenience wrapper: persist + emit. Use this for UI locale switching. */
  setLocale(locale: Preferences['locale']): void {
    if (locale === undefined) return;
    this.setPreference('locale', locale);
  }

  setActiveProject(id: string | null): void {
    this.state.activeProjectId = id;
    const project = this.state.projects.find((p) => p.id === id);
    if (project?.activeSessionId) this.pushNav(project.activeSessionId);
    this.persist();
    this.emit('project-changed');
  }

  addProject(name: string, path: string, defaultProfileId?: string): ProjectRecord {
    const project: ProjectRecord = {
      id: crypto.randomUUID(),
      name,
      path,
      sessions: [],
      activeSessionId: null,
      layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
      board: createDefaultBoard(),
      defaultProfileId,
    };
    this.state.projects.push(project);
    this.state.activeProjectId = project.id;
    this.persist();
    this.emit('project-added', project);
    this.emit('project-changed');
    return project;
  }

  removeProject(id: string): void {
    const project = this.state.projects.find((p) => p.id === id);
    const sessions = project?.sessions ?? [];

    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    for (const s of sessions) {
      this.sessionIndex.delete(s.id);
      this.transcriptFlags.delete(s.id);
    }
    if (this.state.activeProjectId === id) {
      this.state.activeProjectId = this.state.projects[0]?.id ?? null;
    }
    this.persist();
    for (const session of sessions) {
      // `deferRender`: consumers that tear down a pane per session (split-layout)
      // skip their per-event layout render — the `project-changed` emit below
      // renders once for the whole batch, so removing N sessions costs 1 render, not N+1.
      this.emit('session-removed', { projectId: id, sessionId: session.id, deferRender: true });
    }
    this.emit('project-removed', id);
    this.emit('project-changed');
  }

  renameProject(id: string, name: string): void {
    const project = this.state.projects.find((p) => p.id === id);
    if (!project) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) return;
    project.name = trimmed.slice(0, MAX_PROJECT_NAME_LENGTH);
    this.persist();
    this.emit('project-changed');
  }

  addPlanSession(
    projectId: string,
    name: string,
    planMode: boolean = true,
    providerIdOverride?: ProviderId,
    profileId?: string,
    opts?: { activate?: boolean },
  ): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const providerId = resolvePlanProvider(project, this.preferences, providerIdOverride);
    const args = buildPlanSessionArgs(project, getProviderCapabilities(providerId), planMode);
    return this.addSession(projectId, name, args, providerId, profileId, undefined, opts);
  }

  addSession(projectId: string, name: string, args?: string, providerId?: ProviderId, profileId?: string, envVars?: string, opts?: { activate?: boolean }): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const cliProviderId = resolveCliProvider(this.preferences, providerId, project);
    // Pin the effective profile (explicit > project default > global default,
    // provider-matched) onto the session at creation so it stays sticky — resume
    // must reuse the same config dir even if a default changes later.
    const pinnedProfileId = resolveProfile({ profileId }, project, this.preferences, cliProviderId, this.profiles)?.id;
    const session = buildCliSession({
      name,
      providerId: cliProviderId,
      args: args ?? project.defaultArgs,
      profileId: pinnedProfileId,
      envVars: envVars ?? project.defaultEnv,
    });
    attachSessionToProject(project, session, { addToSwarm: true, activate: opts?.activate ?? true });
    this.commitNewSession(projectId, session, opts);
    return session;
  }

  private activateExistingSession(project: ProjectRecord, existing: SessionRecord): SessionRecord {
    if (project.activeSessionId !== existing.id) {
      project.activeSessionId = existing.id;
      this.pushNav(existing.id);
      this.persist();
      this.emitSessionChanged({ sessionId: existing.id, kind: 'activate' });
    }
    return existing;
  }

  private commitNewSession(projectId: string, session: SessionRecord, opts?: { activate?: boolean }): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (project) this.sessionIndex.set(session.id, { project, session });
    // History tracks CLI sessions from creation: a spawn shows in the history
    // panel immediately, and a close finalizes the entry in place.
    if (project && isCliSession(session) && this.preferences.sessionHistoryEnabled) {
      archiveSessionOnCreate(project, session);
      this.emit('history-changed', project.id);
    }
    // A background session (`activate: false`) must stay out of the nav ring —
    // Cmd+[ must not land on a tab the user never opened.
    if (opts?.activate !== false) this.pushNav(session.id);
    this.persist();
    this.emit('session-added', { projectId, session });
    this.emitSessionChanged({ sessionId: session.id, kind: 'add' });
  }

  addDiffViewerSession(projectId: string, filePath: string, area: string, worktreePath?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const existing = findExistingDiffViewer(project, filePath, area, worktreePath);
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildDiffViewerSession({ name: basename(filePath), filePath, area, worktreePath });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addRemoteSession(projectId: string, sessionId: string, hostSessionName: string, shareMode: ShareMode): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const session = buildRemoteSession({ id: sessionId, name: `Remote: ${hostSessionName}`, remoteHostName: hostSessionName, shareMode });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addBrowserTabSession(projectId: string, url?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (url) {
      const existing = findExistingBrowserTab(project, url);
      if (existing) return this.activateExistingSession(project, existing);
    }

    const session = buildBrowserTabSession({ name: browserTabNameFromUrl(url), url });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openProjectTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'project-tab');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildProjectTabSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openKanbanTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (!project.board) project.board = createDefaultBoard();

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'kanban');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildKanbanSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  openTeamTab(projectId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    if (this.state.activeProjectId !== projectId) this.setActiveProject(projectId);

    const existing = findExistingTabByType(project, 'team');
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildTeamSession({ projectName: project.name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  get team(): TeamData {
    if (!this.state.team) this.state.team = { members: [] };
    return this.state.team;
  }

  getTeamMembers(): TeamMember[] {
    return this.team.members;
  }

  getTeamMemberById(id: string): TeamMember | undefined {
    return this.team.members.find((m) => m.id === id);
  }

  addTeamMember(input: Omit<TeamMember, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): TeamMember | undefined {
    // C4TM-06: an oversize prompt dies in the CLI spawn (E2BIG class) — reject at the door.
    if (isSystemPromptOversize(input.systemPrompt)) return undefined;
    const member = buildNewMember(input);
    // C4TM-03: predefined ids arrive from upstream frontmatter (attacker-influenced);
    // a duplicate id makes one card's delete remove both members — suffix it.
    member.id = uniqueMemberId(this.team.members, member.id);
    this.team.members.push(member);
    this.emit('team-changed');
    if (member.installAsAgent) {
      void syncAgentInstallPure(window.finevibe.provider, this.team, member, () => this.persist());
    }
    return member;
  }

  updateTeamMember(id: string, patch: Partial<Omit<TeamMember, 'id' | 'createdAt'>>): TeamMember | undefined {
    // C4TM-06: same spawn E2BIG cap as addTeamMember.
    if (isSystemPromptOversize(patch.systemPrompt)) return undefined;
    const result = applyMemberPatch(this.team, id, patch);
    if (!result) return undefined;
    this.persist();
    this.emit('team-changed');
    // A rename/role edit changes the assignee badge on any board task assigned
    // to this member; board views key off board-changed, so announce it here.
    if (this.boardReferencesMember(id)) this.notifyBoardChanged();
    void reconcileAgentPure(window.finevibe.provider, this.team, result.before, result.after, () => this.persist());
    return result.after;
  }

  /** True when any project's board has a task assigned to the given member. */
  private boardReferencesMember(memberId: string): boolean {
    return this.state.projects.some((p) =>
      (p.board?.tasks ?? []).some((t) => t.assigneeId === memberId),
    );
  }

  removeTeamMember(id: string): void {
    const removed = removeMember(this.team, id);
    if (!removed) return;
    // Don't orphan board tasks assigned to the deleted member.
    let boardChanged = false;
    for (const project of this.state.projects) {
      for (const task of project.board?.tasks ?? []) {
        if (task.assigneeId === id) {
          task.assigneeId = undefined;
          boardChanged = true;
        }
      }
    }
    this.persist();
    this.emit('team-changed');
    if (boardChanged) this.notifyBoardChanged();
    if (removed.installAsAgent && removed.agentSlug) {
      fireAndForgetRemoveAgent(window.finevibe.provider, removed.agentSlug);
    }
  }

  setTeamPredefinedCache(suggestions: TeamMember[]): void {
    this.team.predefinedCache = { fetchedAt: Date.now(), suggestions };
    this.persist();
  }

  // --- CLI provider profiles ---

  get profiles(): Profile[] {
    if (!this.state.profiles) this.state.profiles = [];
    return this.state.profiles;
  }

  getProfile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  /**
   * Create a profile. Provisions its config dir in the main process first,
   * then records the resolved absolute path. Async because provisioning is IPC.
   */
  async addProfile(input: { name: string; providerId: ProviderId; customPath?: string }): Promise<Profile> {
    const id = crypto.randomUUID();
    const { configDir, managed } = await window.finevibe.profiles.provision(id, input.customPath, input.providerId);
    const profile: Profile = {
      id,
      name: input.name.trim(),
      providerId: input.providerId,
      configDir,
      managed,
      createdAt: Date.now(),
    };
    this.profiles.push(profile);
    this.persist();
    this.emit('profiles-changed');
    return profile;
  }

  updateProfile(id: string, patch: Partial<Pick<Profile, 'name'>>): Profile | undefined {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) return undefined;
    if (patch.name !== undefined) profile.name = patch.name.trim();
    this.persist();
    this.emit('profiles-changed');
    return profile;
  }

  /**
   * True while a live session references the profile. This gates the UI's
   * delete button (preferences/profiles-section.ts): a conversation must
   * never silently resume under a different account, so a profile with live
   * sessions is undeletable. Archived history rows deliberately do NOT count
   * (P3-4): counting them made a history-referenced profile permanently
   * undeletable while removeProfile's own cleanup loops could never run.
   * History entries have no conversation to resume — they drop the id.
   */
  isProfileInUse(id: string): boolean {
    return this.state.projects.some((project) =>
      project.sessions.some((session) => session.profileId === id)
    );
  }

  removeProfile(id: string): void {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return;
    this.profiles.splice(idx, 1);
    // Don't orphan references: any session/project/preference pointing at the
    // deleted profile falls back to the provider default config dir and
    // archived history rows drop the id (P3-4: the old isProfileInUse
    // early-return made the session/history loops below dead code).
    for (const project of this.state.projects) {
      if (project.defaultProfileId === id) project.defaultProfileId = undefined;
      for (const session of project.sessions) {
        if (session.profileId === id) session.profileId = undefined;
      }
      for (const archived of project.sessionHistory ?? []) {
        if (archived.profileId === id) archived.profileId = undefined;
      }
      for (const task of project.board?.tasks ?? []) {
        if (task.profileId === id) task.profileId = undefined;
      }
    }
    const defaultProfiles = this.preferences.defaultProfiles;
    if (defaultProfiles) {
      for (const providerId of Object.keys(defaultProfiles)) {
        if (defaultProfiles[providerId as ProviderId] === id) delete defaultProfiles[providerId as ProviderId];
      }
    }
    for (const member of this.team.members) {
      if (member.profileId === id) {
        member.profileId = undefined;
        member.updatedAt = Date.now();
      }
    }
    this.persist();
    this.emit('profiles-changed');
  }

  setProjectDefaultProfile(projectId: string, profileId: string | undefined): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    project.defaultProfileId = profileId || undefined;
    this.persist();
    this.emit('project-changed');
  }

  setProjectCodingDefaults(projectId: string, providerId: ProviderId | undefined, profileId?: string): void {
    const project = this.state.projects.find(p => p.id === projectId);
    if (!project) return;
    const effectiveProvider = providerId ?? this.preferences.defaultProvider ?? 'claude';
    project.defaultProvider = providerId;
    project.defaultProfileId = this.profiles.find(p => p.id === profileId && p.providerId === effectiveProvider)?.id;
    this.persist();
    this.emit('project-changed');
  }

  /** Set (or clear) the global default profile for one provider. */
  setProviderDefaultProfile(providerId: ProviderId, profileId: string | undefined): void {
    const map = { ...this.preferences.defaultProfiles };
    if (profileId) map[providerId] = profileId;
    else delete map[providerId];
    this.setPreference('defaultProfiles', map);
  }

  startTeamChat(
    projectId: string,
    member: TeamMember,
    overrideProviderId?: ProviderId,
    opts?: TeamChatOpts,
  ): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const activeSession = project.sessions.find((s) => s.id === project.activeSessionId);
    const backend = resolveTeamChatBackend(
      member,
      project,
      this.preferences,
      activeSession,
      this.profiles,
      overrideProviderId,
    );
    if (!backend) return undefined;

    // C4T-01: derive the ordinal from the member's names across the live tabs
    // and the state-wide session index — a live count reused closed tabs'
    // numbers and produced a name colliding with a surviving tab.
    const memberSessionNames = new Set<string>();
    for (const entry of this.sessionIndex.values()) {
      if (entry.session.teamMemberId === member.id) memberSessionNames.add(entry.session.name);
    }
    for (const s of project.sessions) {
      if (s.teamMemberId === member.id) memberSessionNames.add(s.name);
    }
    const session = buildTeamChatSession(project, member, backend.providerId, MAX_SESSION_NAME_LENGTH, backend.profileId, opts, memberSessionNames);
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  consumePendingSystemPrompt(projectId: string, sessionId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    const session = project?.sessions.find((s) => s.id === sessionId);
    if (!session?.pendingSystemPrompt) return undefined;
    const prompt = session.pendingSystemPrompt;
    delete session.pendingSystemPrompt;
    return prompt;
  }

  addFileReaderSession(projectId: string, filePath: string, lineNumber?: number): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const normalizedPath = resolveProjectFilePath(project, filePath);

    const existing = findExistingFileReader(project, normalizedPath);
    if (existing) {
      const lineChanged = existing.fileReaderLine !== lineNumber;
      const activating = project.activeSessionId !== existing.id;
      existing.fileReaderLine = lineNumber;
      if (activating) {
        project.activeSessionId = existing.id;
        this.pushNav(existing.id);
      }
      // Emit even when the tab is already active so renderLayout re-runs
      // setFileReaderLine and scrolls to the new position.
      if (activating || lineChanged) {
        this.persist();
        this.emitSessionChanged({ sessionId: existing.id, kind: 'activate' });
      }
      return existing;
    }

    const session = buildFileReaderSession({ name: basename(normalizedPath), filePath: normalizedPath, lineNumber });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  addMcpInspectorSession(projectId: string, name: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const session = buildMcpInspectorSession({ name });
    attachSessionToProject(project, session);
    this.commitNewSession(projectId, session);
    return session;
  }

  removeSession(projectId: string, sessionId: string, opts?: { exitReason?: string; exitCode?: number; exitSignal?: number; processId?: number; deferRender?: boolean }): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;

    // Archive CLI sessions before removing (cost data must be captured before session-removed triggers destroyTerminal)
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session && isCliSession(session)) {
      const transcriptAvailable = this.isArchivable(session);
      // A creation entry exists for every live CLI session (history-on-create);
      // finalize it on close even when there is no transcript — the row then
      // carries `transcriptAvailable: false` and offers no Resume.
      const hadCreateEntry = !!findCreateEntry(project, sessionId);
      if (this.preferences.sessionHistoryEnabled) {
        if (opts?.exitReason || transcriptAvailable || hadCreateEntry) {
          this.archiveSession(project, session, { ...opts, transcriptAvailable, finalize: hadCreateEntry });
        }
      } else if (hadCreateEntry) {
        // The row was created while the pref was on; closing with the pref
        // off must still finalize it, or the row stays "Running" forever.
        this.archiveSession(project, session, {
          ...opts,
          transcriptAvailable,
          finalize: true,
        });
      }
    }

    const closingIndex = project.sessions.findIndex((s) => s.id === sessionId);
    project.sessions = project.sessions.filter((s) => s.id !== sessionId);
    this.sessionIndex.delete(sessionId);
    // PA-25: the prefetched transcript flag dies with the tab.
    this.transcriptFlags.delete(sessionId);
    this.pruneNav(sessionId);
    if (project.activeSessionId === sessionId) {
      const newIndex = closingIndex > 0 ? closingIndex - 1 : 0;
      project.activeSessionId = project.sessions[newIndex]?.id ?? null;
      if (project.activeSessionId) this.pushNav(project.activeSessionId);
    }
    // Also remove from split/swarm panes
    project.layout.splitPanes = project.layout.splitPanes.filter((id) => id !== sessionId);
    // Group membership is persisted state, so it is pruned inline beside the
    // splitPanes filter — removeSession is the single funnel for every close
    // path (batch closes loop through it); a group below 2 members dissolves.
    pruneSessionFromTabGroups(project, sessionId);
    this.persist();
    // S3-06: batch closes (removeAllSessions et al., mirroring removeProject's
    // contract above) pass `deferRender` — consumers skip the per-event
    // rebuild and the batch emits exactly one trailing render kick.
    this.emit('session-removed', opts?.deferRender ? { projectId, sessionId, deferRender: true } : { projectId, sessionId });
    this.emitSessionChanged(opts?.deferRender ? { sessionId, kind: 'remove', deferRender: true } : { sessionId, kind: 'remove' });
  }

  /** Resolve the config dir backing a provider profile (for transcript lookup). */
  private profileConfigDir(providerId: ProviderId, profileId?: string): string | undefined {
    if (!profileId) return undefined;
    return this.profiles.find((p) => p.id === profileId && p.providerId === providerId)?.configDir;
  }

  /**
   * Whether a CLI session is worth keeping in history: only if its conversation
   * transcript actually exists on disk. A cliSessionId alone is NOT enough — it is
   * assigned at PTY spawn (SessionStart hook) before any user interaction, so a session
   * that was never prompted has an id but no transcript and would fail to resume.
   * PA-25: the answer is the flag prefetched at cli-id bind (see
   * {@link transcriptFlags}). This runs on the close path, where the old
   * `session:transcriptExistsSync` call blocked the whole renderer for a
   * main-side stat/decompress per archived close. An unknown flag means
   * PRESENT: archiving best-effort is the cheap direction — a Resume of a
   * transcript that is really gone is caught by `resumeFromHistorySafe`,
   * which re-checks asynchronously and drops the row.
   */
  private isArchivable(session: SessionRecord): boolean {
    if (!session.cliSessionId) return false;
    const providerId = session.providerId ?? 'claude';
    return this.transcriptFlags.get(session.id)?.get(`${providerId}|${session.cliSessionId}`) ?? true;
  }

  /**
   * PA-25: ask main — asynchronously — whether this session's transcript
   * exists, and cache the answer under the cli id it was measured for
   * ({@link transcriptFlags}). Idempotent per (session, cli id). Called when a
   * cli id is bound and for the tabs restored at load.
   */
  private prefetchTranscriptFlag(session: SessionRecord, project: ProjectRecord): Promise<void> {
    const cliSessionId = session.cliSessionId;
    if (!cliSessionId || !isCliSession(session)) return Promise.resolve();
    const providerId = session.providerId ?? 'claude';
    const key = `${providerId}|${cliSessionId}`;
    if (this.transcriptFlags.get(session.id)?.has(key)) return Promise.resolve();
    // One entry per session: the gate reads the CURRENT cli id only, so the id
    // a `/clear` replaced is dropped together with its flag.
    const flags = new Map<string, boolean>([[key, true]]);
    this.transcriptFlags.set(session.id, flags);
    const probe = window.finevibe.session.transcriptExists;
    if (typeof probe !== 'function') return Promise.resolve();
    return probe
      .call(
        window.finevibe.session,
        providerId,
        cliSessionId,
        project.path,
        this.profileConfigDir(providerId, session.profileId),
        // Pi/OMP transcripts live only in the exclusive per-launch dir.
        session.id,
      )
      .then((exists) => { flags.set(key, exists === true); })
      // A failed probe keeps the optimistic default; resume re-checks.
      .catch(() => {});
  }

  /**
   * PA-25: seed the flags for the CLI tabs restored from disk, one probe at a
   * time (see the call in load()).
   */
  private async prefetchRestoredTranscriptFlags(): Promise<void> {
    for (const project of this.state.projects) {
      for (const session of project.sessions) {
        if (!session.cliSessionId) continue;
        await this.prefetchTranscriptFlag(session, project);
      }
    }
  }

  private archiveSession(
    project: ProjectRecord,
    session: SessionRecord,
    opts?: {
      exitReason?: string;
      exitCode?: number;
      exitSignal?: number;
      processId?: number;
      transcriptAvailable?: boolean;
      finalize?: boolean;
    },
  ): void {
    archiveSessionPure(project, session, opts);
    this.emit('history-changed', project.id);
  }

  getSessionHistory(projectId: string): ArchivedSession[] {
    return getSessionHistoryPure(this.state.projects.find((p) => p.id === projectId));
  }

  removeHistoryEntry(projectId: string, archivedSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!removeHistoryEntryPure(project, archivedSessionId)) return;
    this.persist();
    this.emit('history-changed', projectId);
  }

  toggleBookmark(projectId: string, archivedSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!toggleBookmarkPure(project, archivedSessionId)) return;
    this.persist();
    this.emit('history-changed', projectId);
  }

  clearSessionHistory(projectId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    clearSessionHistoryPure(project);
    this.persist();
    this.emit('history-changed', projectId);
  }

  resumeFromHistory(projectId: string, archivedSessionId: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const archived = project.sessionHistory?.find((a) => a.id === archivedSessionId);
    if (!archived || !archived.cliSessionId) return undefined;
    if (archived.transcriptAvailable === false) return undefined;

    const existing = findCliSessionTab(project, archived.cliSessionId);
    if (existing) return this.activateExistingSession(project, existing);

    const session = buildResumedSession(archived);
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  /**
   * Resume from history, but first verify the transcript still exists on disk.
   * If it's gone (a stale entry, or the user deleted the transcript), silently
   * drop the history entry instead of spawning a session that would immediately
   * exit and auto-close. Preferred entry point for all UI resume actions.
   */
  async resumeFromHistorySafe(projectId: string, archivedSessionId: string): Promise<SessionRecord | undefined> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const archived = project.sessionHistory?.find((a) => a.id === archivedSessionId);
    if (!archived || !archived.cliSessionId) return undefined;
    if (archived.transcriptAvailable === false) return undefined;

    // A row whose tab is still running activates that tab; resuming a live
    // session would spawn a duplicate on the same CLI transcript.
    if (archived.state === 'active' && archived.liveSessionId) {
      const live = project.sessions.find((s) => s.id === archived.liveSessionId);
      if (live) {
        this.setActiveSession(projectId, live.id);
        return live;
      }
    }

    const exists = await window.finevibe.session.transcriptExists(
      archived.providerId,
      archived.cliSessionId,
      project.path,
      this.profileConfigDir(archived.providerId, archived.profileId),
      // Pi/OMP transcripts live only in the exclusive per-launch dir.
      archived.liveSessionId,
    );
    if (!exists) {
      // Preserve crash diagnostics even when the transcript disappeared, and
      // never drop the row of a tab that is still running.
      if (!archived.exitReason && archived.state !== 'active') this.removeHistoryEntry(projectId, archivedSessionId);
      return undefined;
    }

    return this.resumeFromHistory(projectId, archivedSessionId);
  }

  /** Open a CLI session by cliSessionId, bypassing FineVibe history. Used for cross-project deep search results. */
  openCliSession(projectId: string, cliSessionId: string, name: string, providerId: ProviderId = 'claude', profileId?: string): SessionRecord | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    const existing = findCliSessionTab(project, cliSessionId);
    if (existing) return this.activateExistingSession(project, existing);

    // Pin the profile the transcript was found under (provider-matched) so resume
    // reopens against the right config dir; ignore a stale/cross-provider id.
    const validProfileId = profileId && this.profiles.some((p) => p.id === profileId && p.providerId === providerId) ? profileId : undefined;
    const session = buildResumedSessionFromCliId(cliSessionId, name, providerId, validProfileId);
    attachSessionToProject(project, session, { addToSwarm: true });
    this.commitNewSession(projectId, session);
    return session;
  }

  async resumeWithProvider(
    projectId: string,
    source: { archivedSessionId?: string; sessionId?: string },
    targetProviderId: ProviderId,
  ): Promise<SessionRecord | undefined> {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return undefined;

    // Defense-in-depth: UI gates this by availability, but bail if the target
    // provider isn't actually installed so we don't create a broken session.
    const snapshot = getProviderAvailabilitySnapshot();
    if (snapshot && snapshot.availability.get(targetProviderId) === false) {
      return undefined;
    }

    const resolved = resolveResumeSource(project, source);
    if (!resolved) return undefined;

    // The source transcript lives under its profile's config dir (if any), so
    // pass it through to locate the right .jsonl when building the handoff.
    const sourceProfile = resolved.profileId ? this.profiles.find((p) => p.id === resolved.profileId && p.providerId === resolved.providerId) : undefined;
    const initialPrompt = await window.finevibe.session.buildResumeWithPrompt(
      resolved.providerId,
      resolved.cliSessionId ?? null,
      project.path,
      resolved.name,
      sourceProfile?.configDir,
      // Pi/OMP transcripts live only in the exclusive per-launch dir.
      resolved.liveSessionId,
    );

    const session: SessionRecord = {
      ...buildCliSession({ name: `${resolved.name} (↪ ${targetProviderId})`, providerId: targetProviderId }),
      pendingInitialPrompt: initialPrompt,
    };
    attachSessionToProject(project, session, { addToSwarm: true });
    // commitNewSession persist()s before emitting session-added; persist strips
    // the transient pendingInitialPrompt, but split-layout.onSessionAdded reads
    // it from in-memory state synchronously inside the emit.
    this.commitNewSession(projectId, session);
    return session;
  }

  consumePendingInitialPrompt(projectId: string, sessionId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    const session = project?.sessions.find((s) => s.id === sessionId);
    if (!session?.pendingInitialPrompt) return undefined;
    const prompt = session.pendingInitialPrompt;
    delete session.pendingInitialPrompt;
    return prompt;
  }

  setActiveSession(projectId: string, sessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    project.activeSessionId = sessionId;
    this.pushNav(sessionId);
    this.persist();
    this.emitSessionChanged({ sessionId, kind: 'activate' });
  }

  updateSessionCliId(projectId: string, sessionId: string, cliSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const session = project.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    // Both the statusLine and the SessionStart/UserPromptSubmit hooks re-report the
    // same id; each repeat costs a persist plus a `session-changed` fan-out.
    if (session.cliSessionId === cliSessionId) return;

    // If session already had a different cliSessionId (e.g., /clear was used),
    // archive the previous session (only if its transcript exists) and reset the tab name.
    // isArchivable is checked while session.cliSessionId still holds the OLD id.
    if (session.cliSessionId) {
      if (this.isArchivable(session)) {
        this.archiveSession(project, session);
      }
      session.name = defaultSessionName(project);
      session.userRenamed = false;
      this.emit('cli-session-cleared', { sessionId });
    }

    session.cliSessionId = cliSessionId;
    // PA-25: the archive gate for this tab must not pay a sync IPC at close,
    // so availability is probed now, when the id is bound.
    void this.prefetchTranscriptFlag(session, project);
    // Mirror the discovered id onto the active history entry (spawned before
    // the id existed) so the history row is resumable/live-linked immediately.
    if (this.preferences.sessionHistoryEnabled && syncCreateEntryCliId(project, sessionId, cliSessionId)) {
      this.emit('history-changed', project.id);
    }
    this.persist();
    this.emitSessionChanged({ sessionId, kind: 'metadata' });
  }

  hasSession(sessionId: string): boolean {
    return this.findSessionById(sessionId) !== undefined;
  }

  private findSessionById(sessionId: string): SessionRecord | undefined {
    return this.findSessionWithProject(sessionId)?.session;
  }

  updateSessionCost(sessionId: string, cost: CostInfo): void {
    const session = this.findSessionById(sessionId);
    if (!session) return;
    session.cost = { ...cost };
    this.scheduleCostFlush();
  }

  updateSessionContext(sessionId: string, context: ContextWindowInfo): void {
    const session = this.findSessionById(sessionId);
    if (!session) return;
    session.contextWindow = { ...context };
    this.scheduleCostFlush();
  }

  updateSessionBrowserTabUrl(sessionId: string, url: string): void {
    const session = this.findSessionById(sessionId);
    if (!session || session.browserTabUrl === url) return;
    session.browserTabUrl = url;
    this.persist();
  }

  setSessionBrowserIsolated(sessionId: string, isolated: boolean): void {
    const session = this.findSessionById(sessionId);
    if (!session) return;
    if ((session.browserIsolated ?? false) === isolated) return;
    session.browserIsolated = isolated || undefined;
    this.persist();
  }

  renameSession(projectId: string, sessionId: string, name: string, userRenamed?: boolean): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const session = project.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (session.type === 'kanban' || session.type === 'project-tab') return;
    session.name = name.slice(0, MAX_SESSION_NAME_LENGTH);
    if (userRenamed) session.userRenamed = true;
    // Keep history in sync. A live tab updates its own row (created at
    // spawn); rows closed earlier with the same cliSessionId are immutable
    // history. Restored tabs (no active row) keep the legacy shared-row sync.
    if (session.cliSessionId && project.sessionHistory) {
      const historyEntry = findCreateEntry(project, session.id)
        ?? project.sessionHistory.find((a) => a.cliSessionId === session.cliSessionId && a.state !== 'active');
      if (historyEntry) {
        historyEntry.name = session.name;
        this.emit('history-changed', project.id);
      }
    }
    this.persist();
    this.emitSessionChanged({ sessionId, kind: 'metadata' });
  }

  notifyBoardChanged(): void {
    this.persist();
    this.emit('board-changed');
  }

  toggleSplit(): void {
    this.toggleSwarm();
  }

  toggleSwarm(): void {
    const project = this.activeProject;
    if (!project) return;
    toggleSwarmMode(project);
    this.persist();
    this.emit('layout-changed');
  }

  cycleSession(direction: 1 | -1): void {
    const project = this.activeProject;
    if (!project) return;
    const next = cycleSessionId(project, direction);
    if (!next) return;
    project.activeSessionId = next;
    this.pushNav(next);
    this.persist();
    this.emitSessionChanged({ sessionId: next, kind: 'activate' });
  }

  gotoSession(index: number): void {
    const project = this.activeProject;
    if (!project) return;
    const next = sessionIdAtIndex(project, index);
    if (!next) return;
    project.activeSessionId = next;
    this.pushNav(next);
    this.persist();
    this.emitSessionChanged({ sessionId: next, kind: 'activate' });
  }

  removeAllSessions(projectId: string): void {
    this.batchRemoveSessions(projectId, 'all');
  }

  removeSessionsFromRight(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'right', sessionId);
  }

  removeSessionsFromLeft(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'left', sessionId);
  }

  removeOtherSessions(projectId: string, sessionId: string): void {
    this.batchRemoveSessions(projectId, 'others', sessionId);
  }

  private batchRemoveSessions(projectId: string, mode: 'all' | 'right' | 'left' | 'others', anchorSessionId?: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    const ids = collectRemovalIds(project, mode, anchorSessionId);
    if (ids.length === 0) return;
    // S3-06: every per-session close defers its consumer renders (same
    // contract removeProject uses); the single trailing `session-changed`
    // kick below is the batch's one render — closing N tabs costs N cheap
    // per-session teardowns + 1 render, not N rebuilds.
    for (const id of ids) this.removeSession(projectId, id, { deferRender: true });
    this.emitSessionChanged({ sessionId: ids[ids.length - 1], kind: 'remove' });
  }

  addInsightSnapshot(projectId: string, snapshot: InitialContextSnapshot): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    addInsightSnapshotPure(project, snapshot);
    this.persist();
    this.emit('insights-changed', projectId);
  }

  dismissInsight(projectId: string, insightId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    dismissInsightPure(project, insightId);
    this.persist();
    this.emit('insights-changed', projectId);
  }

  isInsightDismissed(projectId: string, insightId: string): boolean {
    return isInsightDismissedPure(this.state.projects.find((p) => p.id === projectId), insightId);
  }

  setProjectReadiness(projectId: string, result: ReadinessResult): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    setProjectReadinessPure(project, result);
    this.persist();
    this.emit('readiness-changed', projectId);
  }

  reorderProject(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.state.projects.length) return;
    if (toIndex < 0 || toIndex >= this.state.projects.length) return;
    const [project] = this.state.projects.splice(fromIndex, 1);
    this.state.projects.splice(toIndex, 0, project);
    this.persist();
    this.emit('project-changed');
  }

  setProjectOverviewLayout(projectId: string, layout: OverviewLayout): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    project.overviewLayout = layout;
    this.persist();
  }

  setGithubItemSeen(projectId: string, itemId: string, isoTimestamp: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!project.githubLastSeen) project.githubLastSeen = {};
    project.githubLastSeen[itemId] = isoTimestamp;
    pruneGithubLastSeen(project.githubLastSeen);
    this.persist();
    this.emit('github-unread-changed', projectId);
  }

  setGithubItemsSeenBulk(projectId: string, entries: Record<string, string>): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!project.githubLastSeen) project.githubLastSeen = {};
    let changed = false;
    for (const [id, ts] of Object.entries(entries)) {
      if (project.githubLastSeen[id] !== ts) {
        project.githubLastSeen[id] = ts;
        changed = true;
      }
    }
    if (!changed) return;
    pruneGithubLastSeen(project.githubLastSeen);
    this.persist();
    this.emit('github-unread-changed', projectId);
  }

  getGithubLastSeen(projectId: string, itemId: string): string | undefined {
    const project = this.state.projects.find((p) => p.id === projectId);
    return project?.githubLastSeen?.[itemId];
  }

  reorderSession(projectId: string, sessionId: string, toIndex: number): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!reorderSessionInProject(project, sessionId, toIndex)) return;
    this.persist();
    this.emitSessionChanged({ sessionId, kind: 'reorder' });
  }

  /** Center-zone tab drop: group the dragged tab (or its whole group) with the target. */
  groupSessions(projectId: string, draggedSessionId: string, targetSessionId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!groupTabsInProject(project, draggedSessionId, targetSessionId)) return;
    this.persist();
    this.emitSessionChanged({ sessionId: draggedSessionId, kind: 'reorder' });
  }

  renameTabGroup(projectId: string, groupId: string, name: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!renameTabGroupInProject(project, groupId, name.slice(0, MAX_SESSION_NAME_LENGTH))) return;
    this.persist();
    this.emitSessionChanged({ kind: 'metadata' });
  }

  ungroupTabGroup(projectId: string, groupId: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!ungroupInProject(project, groupId)) return;
    this.persist();
    this.emitSessionChanged({ kind: 'metadata' });
  }
}

export { createDefaultBoard };

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  (appState as any)['state'] = { version: 1, projects: [], activeProjectId: null, preferences: { ...defaultPreferences } };
  // Tests simulate post-load mutators: the premature-persist guard in
  // persist() would drop every write these tests assert on. The guard's own
  // behavior is covered explicitly (state.test.ts 'premature-persist guard').
  (appState as any)['loadedFlag'] = true;
  (appState as any)['warnedPrematurePersist'] = false;
  (appState as any)['listeners'] = new Map();
  (appState as any)['nav'] = new NavHistory();
  if ((appState as any)['costFlushTimer'] !== null) {
    clearTimeout((appState as any)['costFlushTimer']);
    (appState as any)['costFlushTimer'] = null;
  }
  if ((appState as any)['persistTimer'] !== null) {
    clearTimeout((appState as any)['persistTimer']);
    (appState as any)['persistTimer'] = null;
  }
  (appState as any)['lastPersistAt'] = 0;
  // PA-15: a frame scheduled in a previous case must not write into this one.
  (appState as any)['persistFrameToken']++;
  (appState as any)['persistFrameScheduled'] = false;
  (appState as any)['transcriptFlags'] = new Map();
  // startTeamChat's ordinal scan (C4T-01) reads the whole index: a previous
  // case's entries must not leak into this one.
  (appState as any)['sessionIndex'] = new Map();
}

export const appState = new AppState();
