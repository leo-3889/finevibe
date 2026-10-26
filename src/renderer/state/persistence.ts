import type { BoardColumn, BoardData, HostRecord, PersistedState, Preferences, ProjectRecord, SessionRecord, SidebarViews } from '../../shared/types.js';
import { LOCAL_HOST_ID } from '../../shared/types.js';
import { validateHostRecordShape } from '../../shared/ssh-host.js';
import { restoreCost } from '../session-cost.js';
import { restoreContext } from '../session-context.js';
import { buildKanbanSession } from './session-factory.js';
import { normalizeTabGroups } from './tab-group-state.js';

// PA-31 (docs/performance.md growth table "age-prune"): githubLastSeen gains
// one entry per viewed PR/issue, forever. Drop entries older than 90 days at load.
const GITHUB_SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function createDefaultBoard(): BoardData {
  const columns: BoardColumn[] = [
    { id: crypto.randomUUID(), title: 'Backlog', order: 0, behavior: 'inbox' },
    { id: crypto.randomUUID(), title: 'Ready',   order: 1, behavior: 'none' },
    { id: crypto.randomUUID(), title: 'Running', order: 2, behavior: 'active' },
    { id: crypto.randomUUID(), title: 'Done',    order: 3, behavior: 'terminal' },
  ];
  return { columns, tasks: [] };
}

/**
 * Apply forward-compat migrations and runtime priming to a freshly-loaded state.
 * Mutates `state` in place.
 */
export function hydrateLoadedState(state: PersistedState, defaultPreferences: Preferences): void {
  state.preferences = { ...defaultPreferences, ...state.preferences };
  // Hosts normalize once here too (multi-host Phase 1): entries the shared
  // validator rejects are dropped, never trusted (mirrors store.ts on main).
  const hosts: HostRecord[] = [];
  for (const host of state.hosts ?? []) {
    const validated = validateHostRecordShape(host);
    if (validated) hosts.push(validated);
  }
  state.hosts = hosts;
  // Per-host providers plan §2: pre-existing profiles and sessions carry no
  // hostId — normalize 'local' once at load, mirroring store.ts on main.
  for (const profile of state.profiles ?? []) {
    if (!profile.hostId) profile.hostId = LOCAL_HOST_ID;
  }
  for (const project of state.projects) {
    // Audit T2 #4: projects carry a hostId too (remote project-scope gates);
    // normalize once, mirroring store.ts on main.
    if (!project.hostId) project.hostId = LOCAL_HOST_ID;
    for (const session of project.sessions) {
      if (!session.hostId) session.hostId = LOCAL_HOST_ID;
    }
  }
  // Per-key merge: a save written before a new sidebar section existed must
  // inherit its default instead of leaving the key undefined (the shallow
  // spread above replaces the whole object).
  const defaultViews = defaultPreferences.sidebarViews;
  const savedViews = state.preferences.sidebarViews;
  if (defaultViews) {
    const views: SidebarViews = { ...defaultViews };
    for (const key of Object.keys(views) as (keyof SidebarViews)[]) {
      if (savedViews?.[key] !== undefined) views[key] = savedViews[key];
    }
    state.preferences.sidebarViews = views;
  }
  // Legacy: a single global default profile → per-provider map, keyed on the
  // profile's own provider. A dangling id is dropped (it would never resolve).
  const legacyDefault = (state.preferences as { defaultProfileId?: string }).defaultProfileId;
  if (legacyDefault) {
    const profile = (state.profiles ?? []).find((p) => p.id === legacyDefault);
    if (profile) {
      state.preferences.defaultProfiles = { ...state.preferences.defaultProfiles, [profile.providerId]: profile.id };
    }
    delete (state.preferences as { defaultProfileId?: string }).defaultProfileId;
  }
  // One clock for the whole hydrate: every project shares the PA-31 cutoff.
  const now = Date.now();
  for (const project of state.projects) {
    // C5R-01: remote-terminal tabs exist only inside a live share — the pane
    // instance is created by share-manager and split-layout skips creating
    // one for this type at hydration, so a resurrected session renders a
    // blank dead-end tab on every restart. Drop it at load; rejoining a
    // share goes through a fresh connection code.
    project.sessions = project.sessions.filter((s) => s.type !== 'remote-terminal');
    for (const session of project.sessions) {
      if (session.cost) restoreCost(session.id, session.cost);
      if (session.contextWindow) restoreContext(session.id, session.contextWindow);
    }
    if (project.sessionHistory) {
      const seenIds = new Set<string>();
      const liveIds = new Set(project.sessions.map((s) => s.id));
      for (const entry of project.sessionHistory) {
        if (seenIds.has(entry.id)) entry.id = crypto.randomUUID();
        seenIds.add(entry.id);
        // Pre-history-on-create entries are closed archives.
        if (!entry.state) entry.state = 'closed';
        // An 'active' entry whose live session did not survive the last quit
        // (crash / hard kill skipped removeSession): finalize it on load.
        // PA-06: finalizing crash-orphans also makes them cap-eligible —
        // enforceHistoryCap no longer exempts active rows without a live tab.
        if (entry.state === 'active' && !liveIds.has(entry.liveSessionId ?? '')) {
          entry.state = 'closed';
          entry.closedAt = entry.closedAt ?? new Date().toISOString();
        }
      }
    }
    // PA-31: age-prune githubLastSeen (see GITHUB_SEEN_RETENTION_MS). An
    // unparseable timestamp cannot be aged and is useless to the unread
    // logic, so drop it too (non-string values guarded; Date.parse never throws).
    const seen = project.githubLastSeen;
    if (seen) {
      const cutoff = now - GITHUB_SEEN_RETENTION_MS;
      const drop: string[] = [];
      for (const [key, ts] of Object.entries(seen)) {
        const time = typeof ts === 'string' ? Date.parse(ts) : NaN;
        if (Number.isNaN(time) || time < cutoff) drop.push(key);
      }
      if (drop.length) {
        for (const key of drop) delete seen[key];
        // Drop the empty map so serializeForSave does not write `{}` per project.
        if (Object.keys(seen).length === 0) delete project.githubLastSeen;
      }
    }
  }
}

/**
 * Ensure every project has a board, clear stale runtime sessionIds on board tasks,
 * and migrate the legacy `layout.mode === 'board'` to a kanban tab session.
 */
export function ensureProjectDefaults(state: PersistedState): void {
  for (const project of state.projects) {
    if (!project.board) project.board = createDefaultBoard();
    for (const task of project.board.tasks) task.sessionId = undefined;

    // Hydrate sanitising for tab groups: dead ids, cross-group duplicates and
    // broken contiguity from a hand-edited state.json never reach the strip.
    normalizeTabGroups(project);

    const legacyMode = (project.layout as { mode: string }).mode;
    if (legacyMode === 'board') {
      project.layout.mode = 'tabs';
      const existingKanban = project.sessions.find((s) => s.type === 'kanban');
      const kanbanSession = existingKanban ?? buildKanbanSession({ projectName: project.name });
      if (!existingKanban) project.sessions.push(kanbanSession);
      project.activeSessionId = kanbanSession.id;
    }
  }
}

/**
 * C4TM-07: the predefined-suggestion corpus (full prompt bodies, hundreds
 * of KiB) is a picker convenience, not user data. It must not live in
 * state.json forever: the persist path drops it once stale and caps the
 * array. The live in-memory cache keeps its session-lifetime picker use.
 */
export const PREDEFINED_CACHE_PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PREDEFINED_CACHE_PERSIST_MAX_SUGGESTIONS = 200;

/**
 * Strip fields that must never reach disk:
 * - transient in-flight prompts;
 * - per-session `envVars` (P2-101): the New-session box takes raw
 *   `KEY=VALUE` lines such as `ANTHROPIC_API_KEY=...`, and a verbatim
 *   copy in state.json is readable by any local user (the atomic writer
 *   is now 0600, but backups/syncs still fan the file out), by any peer
 *   on a read-write share, and by the git history of any dotfile repo
 *   the user symlinks it into.
 * `project.defaultEnv` is deliberately NOT stripped: the opt-in
 * "keep env" UX persists the value there on purpose so every later
 * session of that project inherits it (session-menu.ts, state.ts
 * addSession). Secrets at rest therefore shrink to the explicit,
 * project-scoped choice the user made.
 * A restarted session resumes without its typed env vars; that is the
 * accepted cost — the live in-memory record keeps them for the session's
 * lifetime (spawn, split-layout resume wiring reads the live object).
 */
export function serializeForSave(state: PersistedState): PersistedState {
  const out: PersistedState = {
    ...state,
    projects: state.projects.map((p: ProjectRecord) => ({
      ...p,
      sessions: p.sessions.map(({ pendingInitialPrompt, pendingSystemPrompt, envVars, ...rest }: SessionRecord) => rest as SessionRecord),
    })),
  };
  const cache = state.team?.predefinedCache;
  if (cache) {
    const team = { ...state.team! };
    // The picker treats a cache older than its 1 h fresh window as dead, so
    // a persisted one only ever serves the session that fetched it; 24 h is
    // the generous outer bound. An oversized corpus is truncated to the cap.
    if (Date.now() - cache.fetchedAt > PREDEFINED_CACHE_PERSIST_MAX_AGE_MS) {
      delete team.predefinedCache;
    } else if (cache.suggestions.length > PREDEFINED_CACHE_PERSIST_MAX_SUGGESTIONS) {
      team.predefinedCache = {
        ...cache,
        suggestions: cache.suggestions.slice(0, PREDEFINED_CACHE_PERSIST_MAX_SUGGESTIONS),
      };
    }
    out.team = team;
  }
  return out;
}
