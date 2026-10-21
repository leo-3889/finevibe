import type { BoardColumn, BoardData, PersistedState, Preferences, ProjectRecord, SessionRecord, SidebarViews } from '../../shared/types.js';
import { restoreCost } from '../session-cost.js';
import { restoreContext } from '../session-context.js';
import { buildKanbanSession } from './session-factory.js';
import { normalizeTabGroups } from './tab-group-state.js';

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
  for (const project of state.projects) {
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
        if (entry.state === 'active' && !liveIds.has(entry.liveSessionId ?? '')) {
          entry.state = 'closed';
          entry.closedAt = entry.closedAt ?? new Date().toISOString();
        }
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
  return {
    ...state,
    projects: state.projects.map((p: ProjectRecord) => ({
      ...p,
      sessions: p.sessions.map(({ pendingInitialPrompt, pendingSystemPrompt, envVars, ...rest }: SessionRecord) => rest as SessionRecord),
    })),
  };
}
