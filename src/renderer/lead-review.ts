import { appState } from './state.js';
import { getTaskBySessionId, getTaskByCliSessionId, updateTask } from './board-state.js';
import { LEAD_REVIEW_HISTORY_MAX } from '../shared/types.js';
import { capLeadReviewSummary, normalizeLeadReview } from '../shared/lead-review.js';
import type { LeadReviewNote, ProjectRecord } from '../shared/types.js';

/** Team-lead review plumbing (team-lead-persona-plan M2, increment I2).
 *
 * The producer is I3 (main: the hidden on-complete review session). This module
 * owns ROUTING on the renderer side: validate (shape lives in
 * `shared/lead-review.ts`, cycle-free so the hydrate boundary shares it), route
 * to the surface, persist through the existing board write path. No spawn
 * logic here. */
export { capLeadReviewSummary, normalizeLeadReview };

/**
 * Land a verdict on its surface: the board card when the session has a task, the
 * project's inspector list when it has none (the plan's "board card / inspector
 * when no board"). `projectId` is REQUIRED — a note with no project must not
 * silently land on whichever project happens to be focused. Returns false when
 * the note is malformed or the project is unknown — the caller (I3) then logs,
 * the verdict is simply not shown.
 */
export function setLeadReview(raw: unknown, projectId: string): boolean {
  const note = normalizeLeadReview(raw);
  if (!note) return false;
  const project = appState.projects.find(p => p.id === projectId);
  if (!project) return false;

  // Live card first; after a restart the load normalization clears the card's
  // runtime sessionId, so a RESUMED session's card is matched by its CLI id
  // (persistence.ts) — without this the note would land boardless and the
  // card would silently show nothing. The note carries the APP session id
  // (main's contract), so resolve it to the CLI id before the lookup
  // (review 0be424ab: comparing app ids against task.cliSessionId never hits).
  const cliId = project.sessions.find(s => s.id === note.sessionId)?.cliSessionId;
  const task = getTaskBySessionId(note.sessionId, project.id) ?? (cliId ? getTaskByCliSessionId(cliId) : undefined);
  if (task) {
    // Value dedupe (session-cost idiom): a re-delivered identical verdict
    // (retry / repeated on-complete) must not churn updatedAt + persist.
    const prev = task.leadReview;
    if (prev && prev.createdAt === note.createdAt && prev.verdict === note.verdict && prev.summary === note.summary) {
      return true;
    }
    // updateTask -> notifyBoardChanged -> persist + card re-render.
    updateTask(task.id, { leadReview: note }, project.id);
    return true;
  }

  // One verdict per session: a newer review replaces the older note.
  const rest = (project.leadReviews ?? []).filter(r => r.sessionId !== note.sessionId);
  const head = project.leadReviews?.[0];
  if (head && head.sessionId === note.sessionId && head.createdAt === note.createdAt && head.verdict === note.verdict && head.summary === note.summary) {
    return true;
  }
  project.leadReviews = [note, ...rest].slice(0, LEAD_REVIEW_HISTORY_MAX);
  appState.notifyBoardChanged();
  return true;
}

/**
 * Subscribe to the main-side verdict producer (I3): one `lead:review` push per
 * reviewed session, routed through `setLeadReview` — the note is validated
 * again inside it, so a malformed producer cannot land a note. Returns nothing;
 * the subscription lives for the renderer's life, like every other
 * `window.finevibe.*` listener wired in index.ts.
 */
export function initLeadReviewChannel(): void {
  window.finevibe.lead.onReview((note, projectId) => {
    setLeadReview(note, projectId);
  });
}

/** The inspector's verdict for `sessionId` on a project whose sessions have no
 * board card. Cards carry their own `task.leadReview` and never appear here. */
export function getInspectorLeadReview(
  project: ProjectRecord | undefined,
  sessionId: string,
): LeadReviewNote | undefined {
  return project?.leadReviews?.find(r => r.sessionId === sessionId);
}
