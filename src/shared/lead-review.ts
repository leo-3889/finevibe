import { LEAD_REVIEW_SUMMARY_MAX_CHARS } from './types.js';
import type { LeadReviewNote } from './types.js';

/** Lead-review note SHAPE — pure (types only), so both the renderer seam
 * (`src/renderer/lead-review.ts`) and the load boundary
 * (`state/persistence.ts` hydrate) can validate notes without an import
 * cycle through the app state. Review I2-1: notes are state.json content —
 * the write-time cap/verdict guarantees must be re-run on read. */

/** Cap the summary so the persisted note is always renderable. Counted in
 * CODE POINTS: a UTF-16 slice at the boundary split a surrogate pair into a
 * replacement glyph (row-129-class). */
export function capLeadReviewSummary(summary: string): string {
  const cps = Array.from(summary);
  if (cps.length <= LEAD_REVIEW_SUMMARY_MAX_CHARS) return summary;
  return `${cps.slice(0, LEAD_REVIEW_SUMMARY_MAX_CHARS - 1).join('')}…`;
}

/** A note arrives as parsed CLI text (I3) or as state.json content (hydrate),
 * i.e. untrusted both times: drop anything malformed rather than render it.
 * `createdAt` outside the JS Date range renders "Invalid Date" — drop too. */
export function normalizeLeadReview(raw: unknown): LeadReviewNote | null {
  const n = raw as Partial<LeadReviewNote> | null | undefined;
  if (!n || typeof n !== 'object' || n.v !== 1) return null;
  if (typeof n.sessionId !== 'string' || !n.sessionId) return null;
  if (n.verdict !== 'approved' && n.verdict !== 'flagged') return null;
  if (typeof n.summary !== 'string') return null;
  if (typeof n.createdAt !== 'number' || !Number.isFinite(n.createdAt) || Math.abs(n.createdAt) > 8.64e15) return null;
  return {
    v: 1,
    sessionId: n.sessionId,
    verdict: n.verdict,
    summary: capLeadReviewSummary(n.summary),
    createdAt: n.createdAt,
  };
}
