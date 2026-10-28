import type { ArchivedSession, ProjectRecord, ProviderId, SessionRecord } from '../../shared/types.js';
import { buildResumedSession, buildResumedSessionFromCliId } from './session-archive.js';

export function getSessionHistory(project: ProjectRecord | undefined): ArchivedSession[] {
  return project?.sessionHistory ?? [];
}

/**
 * Remove a closed history entry.
 * @returns true when an entry was removed, false for a missing id and for the
 * row of a running tab. An `active` row is the record that tab's close
 * finalizes; deleting it makes the close archive a duplicate under a new id,
 * so a live row is removed by closing the tab (or never, for bookmarks).
 */
export function removeHistoryEntry(project: ProjectRecord, archivedSessionId: string): boolean {
  if (!project.sessionHistory) return false;
  const entry = project.sessionHistory.find((a) => a.id === archivedSessionId);
  if (!entry || entry.state === 'active') return false;
  project.sessionHistory = project.sessionHistory.filter((a) => a.id !== archivedSessionId);
  return true;
}

/** @returns true if a bookmark was toggled */
export function toggleBookmark(project: ProjectRecord, archivedSessionId: string): boolean {
  if (!project.sessionHistory) return false;
  const entry = project.sessionHistory.find((a) => a.id === archivedSessionId);
  if (!entry) return false;
  entry.bookmarked = !entry.bookmarked;
  return true;
}

/** Clear non-bookmarked, closed history entries. Running rows and bookmarks survive. */
export function clearSessionHistory(project: ProjectRecord): void {
  project.sessionHistory = project.sessionHistory?.filter((a) => a.bookmarked || a.state === 'active') ?? [];
}

/** Find a session tab in this project that already has the given cliSessionId. */
export function findCliSessionTab(project: ProjectRecord, cliSessionId: string): SessionRecord | undefined {
  return project.sessions.find((s) => s.cliSessionId === cliSessionId);
}

interface ResumeSourceData {
  providerId: ProviderId;
  cliSessionId: string | null | undefined;
  name: string;
  /** Source session's profile, so its transcript can be located in the right config dir. */
  profileId?: string;
  /** Live tab id, so Pi/OMP handoffs can resolve the exclusive per-launch transcript dir. */
  liveSessionId?: string;
}

/** Resolve a resume source from either an archived entry id or a live session id. */
export function resolveResumeSource(
  project: ProjectRecord,
  source: { archivedSessionId?: string; sessionId?: string },
): ResumeSourceData | undefined {
  if (source.archivedSessionId) {
    const archived = project.sessionHistory?.find((a) => a.id === source.archivedSessionId);
    if (!archived || !archived.providerId) return undefined;
    return { providerId: archived.providerId, cliSessionId: archived.cliSessionId, name: archived.name, profileId: archived.profileId, liveSessionId: archived.liveSessionId };
  }
  if (source.sessionId) {
    const existing = project.sessions.find((s) => s.id === source.sessionId);
    if (!existing || !existing.providerId) return undefined;
    return { providerId: existing.providerId, cliSessionId: existing.cliSessionId, name: existing.name, profileId: existing.profileId, liveSessionId: existing.id };
  }
  return undefined;
}

export { buildResumedSession, buildResumedSessionFromCliId };
