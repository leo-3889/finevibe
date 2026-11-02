import { appState } from './state.js';
import { getTaskBySessionId, updateTask } from './board-state.js';
import {
  LEAD_REVIEW_HISTORY_MAX,
  LEAD_REVIEW_SUMMARY_MAX_CHARS,
} from '../shared/types.js';
import type { LeadReviewNote, ProjectRecord } from '../shared/types.js';

/** Team-lead review plumbing (team-lead-persona-plan M2, increment I2).
 *
 * The producer is I3 (main: the hidden on-complete review session). This module
 * owns the note SHAPE handling on the renderer side: validate, cap, route to the
 * surface, persist through the existing board write path. No spawn logic here. */

/** Cap the summary at write time so the persisted note is always renderable. */
export function capLeadReviewSummary(summary: string): string {
  if (summary.length <= LEAD_REVIEW_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, LEAD_REVIEW_SUMMARY_MAX_CHARS - 1)}…`;
}

/** A verdict arrives as parsed CLI text (I3), i.e. untrusted: drop anything
 * malformed rather than render it. */
export function normalizeLeadReview(raw: unknown): LeadReviewNote | null {
  const n = raw as Partial<LeadReviewNote> | null | undefined;
  if (!n || typeof n !== 'object' || n.v !== 1) return null;
  if (typeof n.sessionId !== 'string' || !n.sessionId) return null;
  if (n.verdict !== 'approved' && n.verdict !== 'flagged') return null;
  if (typeof n.summary !== 'string') return null;
  if (typeof n.createdAt !== 'number' || !Number.isFinite(n.createdAt)) return null;
  return {
    v: 1,
    sessionId: n.sessionId,
    verdict: n.verdict,
    summary: capLeadReviewSummary(n.summary),
    createdAt: n.createdAt,
  };
}

/**
 * Land a verdict on its surface: the board card when the session has a task, the
 * project's inspector list when it has none (the plan's "board card / inspector
 * when no board"). Returns false when the note is malformed or no project is
 * loaded — the caller (I3) then logs, the verdict is simply not shown.
 */
export function setLeadReview(raw: unknown, projectId?: string): boolean {
  const note = normalizeLeadReview(raw);
  if (!note) return false;
  const project = resolveProject(projectId);
  if (!project) return false;

  const task = getTaskBySessionId(note.sessionId, project.id);
  if (task) {
    // updateTask -> notifyBoardChanged -> persist + card re-render.
    updateTask(task.id, { leadReview: note }, project.id);
    return true;
  }

  // One verdict per session: a newer review replaces the older note.
  const rest = (project.leadReviews ?? []).filter(r => r.sessionId !== note.sessionId);
  project.leadReviews = [note, ...rest].slice(0, LEAD_REVIEW_HISTORY_MAX);
  appState.notifyBoardChanged();
  return true;
}

/** The inspector's verdict for `sessionId` on a project whose sessions have no
 * board card. Cards carry their own `task.leadReview` and never appear here. */
export function getInspectorLeadReview(
  project: ProjectRecord | undefined,
  sessionId: string,
): LeadReviewNote | undefined {
  return project?.leadReviews?.find(r => r.sessionId === sessionId);
}

function resolveProject(projectId?: string): ProjectRecord | undefined {
  return projectId
    ? appState.projects.find(p => p.id === projectId)
    : appState.activeProject;
}
