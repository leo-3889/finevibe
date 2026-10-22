import type { ArchivedSession, ProjectRecord, ProviderId, SessionRecord } from '../../shared/types.js';
import { getCost } from '../session-cost.js';

const HISTORY_CAP = 500;
// PA-06 (docs/performance.md growth table): bookmarks and active rows were
// exempt from the cap forever, so history grew without bound. Only the
// newest BOOKMARK_EXEMPT bookmarks stay exempt.
const BOOKMARK_EXEMPT = 50;
/**
 * Record a CLI session in history the moment it is created, so the history
 * panel reflects spawns immediately (not only at close). The entry is
 * finalized by `archiveSession` (with `finalize: true`) when the session
 * closes; until then it is `state: 'active'`, exempt from the history cap
 * only while its tab is live (PA-06) — a crash orphan falls back under the cap.
 */
export function archiveSessionOnCreate(project: ProjectRecord, session: SessionRecord): void {
  if (!project.sessionHistory) project.sessionHistory = [];
  if (project.sessionHistory.some((a) => a.liveSessionId === session.id)) return;
  project.sessionHistory.push({
    id: crypto.randomUUID(),
    liveSessionId: session.id,
    state: 'active',
    name: session.name,
    providerId: (session.providerId || 'claude') as ProviderId,
    cliSessionId: session.cliSessionId ?? null,
    createdAt: session.createdAt,
    teamMemberId: session.teamMemberId,
    profileId: session.profileId,
    cost: null,
  });
}

/** Active entry mirroring a live session, if one was recorded at creation. */
export function findCreateEntry(
  project: ProjectRecord,
  liveSessionId: string,
): ArchivedSession | undefined {
  return project.sessionHistory?.find((a) => a.liveSessionId === liveSessionId && a.state === 'active');
}

/** Mirror a live session's id (discovered after spawn) onto its active entry. */
export function syncCreateEntryCliId(
  project: ProjectRecord,
  liveSessionId: string,
  cliSessionId: string,
): boolean {
  const entry = findCreateEntry(project, liveSessionId);
  if (!entry || entry.cliSessionId === cliSessionId) return false;
  entry.cliSessionId = cliSessionId;
  return true;
}

/**
 * PA-06: enforce HISTORY_CAP with bounded exemptions. Walk newest-last
 * (highest index = newest) and exempt only: `active` rows while a live tab
 * with that `liveSessionId` exists (crash-orphans are cap-eligible; hydrate
 * already finalizes them — see persistence.ts), and the newest
 * BOOKMARK_EXEMPT bookmarked rows. Then drop the oldest non-exempt rows
 * (insertion order) until the cap is met. Survivors ≤ HISTORY_CAP plus, in
 * the pathological case, the exemption set — every row class is bounded
 * (bookmarks ≤ BOOKMARK_EXEMPT, active ≤ live tab count), so sessionHistory
 * can no longer grow without limit. Rows are keyed by their unique id
 * (hydrate dedupes ids at load, persistence.ts), so an id set is safe.
 */
function enforceHistoryCap(project: ProjectRecord): void {
  const history = project.sessionHistory;
  if (!history || history.length <= HISTORY_CAP) return;
  const liveIds = new Set(project.sessions.map((s) => s.id));
  const exempt = new Set<string>();
  let bookmarksSeen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const a = history[i];
    if (a.state === 'active' && a.liveSessionId && liveIds.has(a.liveSessionId)) exempt.add(a.id);
    if (a.bookmarked && bookmarksSeen < BOOKMARK_EXEMPT) { bookmarksSeen++; exempt.add(a.id); }
  }
  let toRemove = history.length - HISTORY_CAP;
  // Bookmarks beyond BOOKMARK_EXEMPT lose immunity and are pruned FIRST
  // (oldest of them), before plain rows: once the quota is exhausted,
  // "bookmarked" must not mean "the oldest rows survive while newer plain
  // rows die".
  const dropIds = new Set<string>();
  for (const a of history) {
    if (toRemove <= 0) break;
    if (a.bookmarked && !exempt.has(a.id)) { dropIds.add(a.id); toRemove--; }
  }
  project.sessionHistory = history.filter((a) => {
    if (dropIds.has(a.id)) return false;
    if (exempt.has(a.id)) return true;
    if (toRemove > 0) { toRemove--; return false; }
    return true;
  });
}

/**
 * Archive a session into project.sessionHistory. If a prior history entry
 * shares the same cliSessionId, update it in place; otherwise push a new one.
 * Caps history at 500 entries; `enforceHistoryCap` keeps only a bounded set
 * of exemptions live: the newest 50 bookmarks and rows with a live tab (PA-06).
 */
export function archiveSession(
  project: ProjectRecord,
  session: SessionRecord,
  opts?: {
    exitReason?: string;
    exitCode?: number;
    exitSignal?: number;
    processId?: number;
    transcriptAvailable?: boolean;
    /** Close path: finalize the entry created at spawn (matched by liveSessionId). */
    finalize?: boolean;
  },
): void {
  const costInfo = getCost(session.id);
  const archived: ArchivedSession = {
    id: crypto.randomUUID(),
    state: 'closed',
    name: session.name,
    providerId: (session.providerId || 'claude') as ProviderId,
    cliSessionId: session.cliSessionId,
    createdAt: session.createdAt,
    closedAt: new Date().toISOString(),
    teamMemberId: session.teamMemberId,
    profileId: session.profileId,
    cost: costInfo ? {
      totalCostUsd: costInfo.totalCostUsd,
      totalInputTokens: costInfo.totalInputTokens,
      totalOutputTokens: costInfo.totalOutputTokens,
      totalDurationMs: costInfo.totalDurationMs,
    } : null,
    ...(opts?.exitReason ? { exitReason: opts.exitReason } : {}),
    ...(opts?.exitReason && opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts?.exitReason && opts.exitSignal !== undefined ? { exitSignal: opts.exitSignal } : {}),
    ...(opts?.exitReason && opts.processId !== undefined ? { processId: opts.processId } : {}),
  };
  if (opts?.transcriptAvailable !== undefined) archived.transcriptAvailable = opts.transcriptAvailable;

  if (!project.sessionHistory) project.sessionHistory = [];
  // Close path: update in place the entry written at creation, keyed by the
  // live session id. A `/clear` archive (no `finalize`) must not touch it —
  // the tab stays live with a new conversation id.
  let existingIndex = opts?.finalize
    ? project.sessionHistory.findIndex((a) => a.liveSessionId === session.id)
    : -1;
  // Segment archives (e.g. `/clear`) attach to a CLOSED entry with the
  // same id; the tab's active entry keeps living with the new id.
  if (existingIndex === -1 && archived.cliSessionId) {
    existingIndex = project.sessionHistory.findIndex((a) => a.cliSessionId === archived.cliSessionId && a.state !== 'active');
  }
  if (existingIndex === -1) {
    project.sessionHistory.push(archived);
  } else {
    project.sessionHistory[existingIndex].closedAt = archived.closedAt;
    project.sessionHistory[existingIndex].state = 'closed';
    if (archived.cliSessionId) project.sessionHistory[existingIndex].cliSessionId = archived.cliSessionId;
    if (archived.cost) project.sessionHistory[existingIndex].cost = archived.cost;
    if (archived.name !== project.sessionHistory[existingIndex].name) {
      project.sessionHistory[existingIndex].name = archived.name;
    }
    if (archived.teamMemberId) {
      project.sessionHistory[existingIndex].teamMemberId = archived.teamMemberId;
    }
    // Always sync (not just when truthy) so clearing a session's profile is reflected.
    project.sessionHistory[existingIndex].profileId = archived.profileId;
    if (opts?.exitReason) {
      project.sessionHistory[existingIndex].exitReason = opts.exitReason;
      project.sessionHistory[existingIndex].exitCode = opts.exitCode;
      project.sessionHistory[existingIndex].exitSignal = opts.exitSignal;
      project.sessionHistory[existingIndex].processId = opts.processId;
    }
    if (opts?.transcriptAvailable !== undefined) {
      project.sessionHistory[existingIndex].transcriptAvailable = opts.transcriptAvailable;
    }
  }

  enforceHistoryCap(project);
}

/** Build a fresh SessionRecord that resumes a previously archived CLI session. */
export function buildResumedSession(archived: ArchivedSession): SessionRecord {
  return {
    id: crypto.randomUUID(),
    name: archived.name,
    providerId: archived.providerId,
    cliSessionId: archived.cliSessionId,
    createdAt: new Date().toISOString(),
    teamMemberId: archived.teamMemberId,
    profileId: archived.profileId,
  };
}

/** Build a fresh SessionRecord from a bare cliSessionId (no FineVibe history entry required). */
export function buildResumedSessionFromCliId(cliSessionId: string, name: string, providerId: ProviderId = 'claude', profileId?: string): SessionRecord {
  return {
    id: crypto.randomUUID(),
    name,
    providerId,
    cliSessionId,
    createdAt: new Date().toISOString(),
    ...(profileId ? { profileId } : {}),
  };
}
