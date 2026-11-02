import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { getProvider } from './providers/registry';
import { getGitFiles } from './git-status';
import { resolveLaunchSpec } from './pty-manager';
import { loadState, saveState } from './store';
import { sendToMainWindow } from './main-window';
import { evictOldest } from './bounded-map';
import { launchSessionDir, ensureLaunchSessionDir } from './launch-session-dir';
import { normalizeLeadReview } from '../shared/lead-review';
import { LEAD_CHARTER_MAX_BYTES, LOCAL_HOST_ID } from '../shared/types';
import type { LaunchSessionProvider } from './launch-session-dir';
import type { LoadedState } from './store';
import type {
  LeadReviewVerdict,
  Preferences,
  ProjectLead,
  ProjectRecord,
  ProviderId,
  SessionRecord,
} from '../shared/types';

/**
 * On-complete lead review (team-lead-persona-plan M2, increment I3) — the
 * accountable half of the per-project lead persona.
 *
 * When a LOCAL session in a lead-enabled project reaches `completed`, the
 * transcript poller (session-transcript-sync.ts) calls `requestLeadReview`,
 * which spawns ONE hidden headless run of the project's own provider binary —
 * no PTY, no tab, no renderer surface — carrying the lead charter + a session
 * digest on the provider's system-prompt lane, and asks for one verdict line.
 * The parsed verdict travels to the renderer on the single `lead:review`
 * channel, where `setLeadReview` (renderer/lead-review.ts, the I2 seam) routes
 * it to the board card / the inspector.
 *
 * Cost guards are the plan's (M2 "one review per session, none for swarm
 * members v1, kill-switch pref"):
 *   - one review per session EVER — `reviewedSessions` (FIFO-capped),
 *     claimed before the spawn, so a repeated `completed` emission is free;
 *   - never for a swarm/team-member session;
 *   - `preferences.leadReviewsEnabled === false` disables the whole path;
 *   - the project must carry `lead.enabled && lead.reviewMode === 'on-complete'`
 *     (an absent lead is the absent feature);
 *   - the exec is bounded by LEAD_REVIEW_TIMEOUT_MS (kill) and
 *     LEAD_REVIEW_OUTPUT_MAX_BYTES (output), and the digest by
 *     LEAD_REVIEW_DIGEST_MAX_BYTES.
 *
 * Unparseable output is dropped with one log line: no verdict is better than
 * an invented one, and the card/inspector simply stay unreviewed.
 */

/** Prompt/digest byte budget. The charter rides the same argv slot with its
 * own cap (LEAD_CHARTER_MAX_BYTES, 4 KiB), so the whole system-prompt argument
 * stays under ~20 KiB — well inside every platform argv budget. 16 KiB is
 * ~3-4k tokens of transcript tail: enough to judge "did the work land", too
 * small to matter on a provider bill next to the reviewed session itself. */
export const LEAD_REVIEW_DIGEST_MAX_BYTES = 16 * 1024;

/** Hard ceiling on one review run. A headless CLI that ignores its prompt and
 * sits in a TUI loop dies here (SIGKILL), so a review can never outlive the
 * session it judges. Generous because a real review is a full model turn. */
export const LEAD_REVIEW_TIMEOUT_MS = 120_000;

/** execFile output ceiling: a CLI that streams its whole transcript to stdout
 * must not grow the main process's heap. Past this the exec errors and the
 * verdict is dropped. */
export const LEAD_REVIEW_OUTPUT_MAX_BYTES = 256 * 1024;

/** Reviewed-session ledger bound. Keys are UI session ids (one per session
 * this process), so this only bounds the pathological case; FIFO like every
 * other src/main ledger (bounded-map.ts). */
export const LEAD_REVIEWED_SESSIONS_MAX = 500;

const LEAD_REVIEW_PROMPT =
  'Review the session per the charter. Reply with exactly one line: ' +
  'VERDICT: APPROVED or VERDICT: FLAGGED, then a one-line summary.';

/** Session ids claimed for a review (FIFO-capped by LEAD_REVIEWED_SESSIONS_MAX). */
const reviewedSessions = new Set<string>();

// Review 7c3238b9-3: reviews are billable CLI runs; a completion burst must
// not fan out. One in flight; the rest skip with a log (the claim already
// landed, so a skipped session stays skipped — v1 accepts the loss, the plan
// asks for cost discipline first).
export const LEAD_REVIEW_MAX_CONCURRENT = 1;
let inFlightReviews = 0;

/** @internal Test-only: drop the one-review-per-session ledger. */
export function _resetLeadReviewForTesting(): void {
  reviewedSessions.clear();
  inFlightReviews = 0;
}

/** What the transcript poller knows about the session it just saw complete —
 * the same tuple its sync entry carries, so the review resolves the very
 * transcript the poller read (profile dir + exclusive session dir included). */
export interface LeadReviewSessionRef {
  providerId: ProviderId;
  cliSessionId: string;
  cwd: string;
  configDir?: string;
  sessionDir?: string;
}

/** Everything the run needs, once every gate passed. */
export interface LeadReviewTarget {
  project: ProjectRecord;
  session: SessionRecord;
  lead: ProjectLead;
}

/** The plan's "none for swarm members v1": a session spawned as a team member
 * (`teamMemberId`), or a pane of a project in swarm layout (every pane of a
 * swarm is a member session; the plan's I1b note keeps them ordinary launches,
 * the verdict surface excludes them). */
export function isSwarmMemberSession(project: ProjectRecord, session: SessionRecord): boolean {
  if (session.teamMemberId) return true;
  const layout = project.layout;
  return layout?.mode === 'swarm' && (layout.splitPanes ?? []).includes(session.id);
}

/**
 * Every cost gate in one pure read of the state (no fs, no spawn), returning
 * the target or null with the skip reason for the log. `session.hostId` is the
 * local check: a registry-host session's project/provider live on another
 * machine, and v1 reviews local sessions only.
 */
export function resolveLeadReviewTarget(
  state: Pick<LoadedState, 'projects' | 'preferences'>,
  sessionId: string,
): { target: LeadReviewTarget | null; skip: string | null } {
  const preferences: Preferences | undefined = state.preferences;
  if (preferences?.leadReviewsEnabled === false) return { target: null, skip: 'kill-switch pref' };
  const project = state.projects.find((p) => p.sessions.some((s) => s.id === sessionId));
  const session = project?.sessions.find((s) => s.id === sessionId);
  if (!project || !session) return { target: null, skip: 'unknown session' };
  const lead = project.lead;
  if (!lead?.enabled || lead.reviewMode !== 'on-complete') {
    return { target: null, skip: 'lead review off for project' };
  }
  if (session.hostId && session.hostId !== LOCAL_HOST_ID) return { target: null, skip: 'remote session' };
  // Review 7c3238b9-6: a session under a REGISTRY-HOST project whose record
  // normalized to LOCAL_HOST_ID would execFile with cwd = a host path
  // (fails safe at ENOENT, but burns the one-time claim - skip at the gate).
  if (project.hostId && project.hostId !== LOCAL_HOST_ID) return { target: null, skip: 'remote project' };
  if (isSwarmMemberSession(project, session)) return { target: null, skip: 'swarm member' };
  if (!session.cliSessionId) return { target: null, skip: 'no cli session id' };
  // One review per session EVER survives restart (review 7c3238b9-2): the
  // in-memory Set is only the hot path; the record is the durable claim.
  if (session.leadReviewedAt) return { target: null, skip: 'already reviewed' };
  // Review 7c3238b9-5: the charter cap is enforced renderer-side on the
  // INJECTION paths (session-factory); main must not re-trust state.json.
  if (Buffer.byteLength(lead.charter, 'utf8') > LEAD_CHARTER_MAX_BYTES) {
    return { target: null, skip: `charter over ${LEAD_CHARTER_MAX_BYTES}-byte cap` };
  }
  return { target: { project, session, lead }, skip: null };
}

/**
 * Verdict line parser. The newest `VERDICT: APPROVED|FLAGGED` wins — a CLI that
 * echoes its prompt would put that echo BEFORE the model's answer, so scanning
 * backwards skips it. Summary = the rest of that line, else the next non-empty
 * line, else empty (the note stays valid; the cap lives in shared/lead-review).
 */
export function parseLeadVerdict(text: string): { verdict: LeadReviewVerdict; summary: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    // Review 7c3238b9-8: markdown-wrapped answers (`**VERDICT: APPROVED**`)
    // are common CLI output; the anchor stays line-start, the bold is eaten.
    const m = /^\s*\*{0,2}VERDICT:\s*(APPROVED|FLAGGED)\b\*{0,2}\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const verdict = m[1].toUpperCase() === 'APPROVED' ? 'approved' : 'flagged';
    let summary = m[2].trim().replace(/\*+$/, '');
    if (!summary) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          summary = lines[j].trim();
          break;
        }
      }
    }
    return { verdict, summary };
  }
  return null;
}

/** UTF-8 byte length. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Keep the LAST `maxBytes` of `text` (the newest transcript lines), cutting on
 * a char boundary so the cut cannot mint a replacement glyph. */
function truncateTailToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let start = buf.length - maxBytes;
  // Skip a UTF-8 continuation byte (0b10xxxxxx) run: land on a lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/** Keep whole lines from the FRONT until `maxBytes`, marking the dropped rest
 * with a lone `…` — a half-cut path would read as a real file. */
function fitLinesToBytes(lines: string[], maxBytes: number): string {
  if (maxBytes <= 4) return '';
  const out: string[] = [];
  let used = 0;
  // 4 bytes = the UTF-8 '…' (3) plus its separator newline (1): reserved up
  // front, so a list that fills its budget exactly cannot spill a byte past
  // the cap when the marker is appended.
  const limit = maxBytes - 4;
  for (const line of lines) {
    const next = used + (out.length ? 1 : 0) + byteLength(line);
    if (next > limit) {
      out.push('…');
      break;
    }
    out.push(line);
    used = next;
  }
  return out.join('\n');
}

/**
 * The digest the lead judges: files touched (the existing git-status lane, so
 * the same `git status --porcelain=v2` answer the Git panel shows) + the
 * transcript tail. The WHOLE digest is byte-capped by
 * LEAD_REVIEW_DIGEST_MAX_BYTES: the files list keeps the first paths that fit
 * (git's own order, whole lines only), the tail is trimmed from the FRONT (the
 * newest turns are the ones worth reading). A huge `git status` therefore
 * costs the transcript, never the cap.
 */
export function composeLeadDigest(filesTouched: string[], transcriptTail: string): string {
  const filesLabel = 'Files touched:\n';
  const tailLabel = '\n\nTranscript tail:\n';
  const files = filesTouched.length > 0
    ? fitLinesToBytes(filesTouched, Math.max(0, LEAD_REVIEW_DIGEST_MAX_BYTES - byteLength(filesLabel) - byteLength(tailLabel)))
    : '(none)';
  const header = `${filesLabel}${files}${tailLabel}`;
  return `${header}${truncateTailToBytes(transcriptTail, Math.max(0, LEAD_REVIEW_DIGEST_MAX_BYTES - byteLength(header)))}`;
}

/** Last LEAD_REVIEW_DIGEST_MAX_BYTES of the transcript the poller resolved.
 * Any fs failure is "no tail": the review still runs on the files list. */
function readTranscriptTail(ref: LeadReviewSessionRef): string {
  try {
    const provider = getProvider(ref.providerId);
    const path = provider.getTranscriptPath?.(ref.cliSessionId, ref.cwd, ref.configDir, ref.sessionDir);
    if (!path) return '';
    const fd = fs.openSync(path, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const read = Math.min(size, LEAD_REVIEW_DIGEST_MAX_BYTES);
      const buffer = Buffer.alloc(read);
      fs.readSync(fd, buffer, 0, read, Math.max(0, size - read));
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    console.warn(`[lead-review] transcript tail unreadable: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Spawn the hidden review run and land its verdict. Reuses the shipped launch
 * lane (`resolveLaunchSpec`) so argv/env/profile handling is EXACTLY the
 * provider's normal spawn — minus the PTY: `execFile` argv array, no shell,
 * stdin closed via `child.stdin.end()` so the CLI sees EOF and exits instead
 * of sitting in a TUI loop until the timeout kill. `planModeArg` (enforced by
 * the caller) puts the agent on the provider's read-only plan lane — the
 * review must never run with default write tools.
 */
async function runLeadReview(target: LeadReviewTarget, ref: LeadReviewSessionRef, planModeArg: string): Promise<void> {
  const { project, lead } = target;
  const files = await getGitFiles(project.path);
  const filesTouched = Array.from(new Set(files.map((f) => f.path)));
  const digest = composeLeadDigest(filesTouched, readTranscriptTail(ref));
  const reviewId = crypto.randomUUID();
  // Review 7c3238b9-4: every PTY launch pre-creates its session dir
  // (onSessionStarted/Resumed); a CLI that does not mkdir its own
  // --session-dir would die at startup with only "no verdict" visible.
  // The pi family owns that lane — cover exactly its providers.
  if (ref.providerId === 'pi' || ref.providerId === 'pi-bolt' || ref.providerId === 'omp') {
    ensureLaunchSessionDir(launchSessionDir(ref.providerId as LaunchSessionProvider, reviewId));
  }
  let spec;
  try {
    spec = resolveLaunchSpec({
      sessionId: reviewId,
      cliSessionId: null,
      isResume: false,
      extraArgs: '',
      providerId: ref.providerId,
      initialPrompt: LEAD_REVIEW_PROMPT,
      // The charter + digest ride the provider's system-prompt lane, verbatim
      // (buildArgs owns quoting / the Windows file spill).
      systemPrompt: `${lead.charter}\n\n${digest}`,
      envVars: '',
      configDir: ref.configDir,
    });
  } catch (err) {
    console.warn(`[lead-review] spawn refused for session ${target.session.id}: ${(err as Error).message}`);
    return;
  }

  // The in-flight slot (concurrency cap) spans the CHILD's life, not the
  // dispatch: resolve only from the execFile callback.
  await new Promise<void>((resolve) => {
    const child = execFile(
      spec.executable,
      // Read-only grant last in argv (flag-value pairs ride the provider's own
      // spelling, e.g. `--permission-mode plan`); CLIs accept flags after the
      // positional prompt.
      [...spec.argv, ...planModeArg.split(/\s+/).filter(Boolean)],
      {
        cwd: project.path,
        env: spec.env,
        timeout: LEAD_REVIEW_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: LEAD_REVIEW_OUTPUT_MAX_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        try {
          const label = `session ${target.session.id} (project ${project.id})`;
          if (err && (err as { killed?: boolean }).killed) {
            console.warn(`[lead-review] timed out after ${LEAD_REVIEW_TIMEOUT_MS} ms, killed: ${label}`);
            return;
          }
          // A non-zero exit with a verdict line still counts (a CLI can exit 1
          // after answering); only output is required.
          const parsed = parseLeadVerdict(`${stdout}\n${stderr}`);
          if (!parsed) {
            console.log(`[lead-review] no verdict in output, dropped: ${label}`);
            return;
          }
          const note = normalizeLeadReview({
            v: 1,
            sessionId: target.session.id,
            verdict: parsed.verdict,
            summary: parsed.summary,
            createdAt: Date.now(),
          });
          if (!note) {
            console.log(`[lead-review] verdict note rejected by shape gate: ${label}`);
            return;
          }
          sendToMainWindow('lead:review', note, project.id);
        } finally {
          resolve();
        }
      },
    );
    // EOF on stdin. Every provider binary is a TUI on this lane (no print-mode
    // flag exists in `buildArgs`), and an interactive CLI that is handed a prompt
    // on a pipe it never sees closed waits on input for the whole
    // LEAD_REVIEW_TIMEOUT_MS budget before the kill above ends it.
    child.stdin?.end();
  });
}

/**
 * The poller's on-complete hook. Synchronous and cheap: gates read the cached
 * state, the claim lands before any await, and every failure path is a log
 * line — a review must never break the status pipeline that called it.
 */
export function requestLeadReview(sessionId: string, ref: LeadReviewSessionRef): void {
  try {
    if (reviewedSessions.has(sessionId)) return;
    // The charter + digest ride the provider's system-prompt lane. A provider
    // without one (Copilot, Gemini) would receive the review question with no
    // charter at all, i.e. a verdict from a lead that was never told the rules
    // — so v1 reviews the lane-capable providers only (coverage gap:
    // docs/FEATURES.md §3 “On-complete lead review”).
    if (getProvider(ref.providerId).meta.capabilities.systemPromptInjection !== true) {
      console.log(`[lead-review] skipped (no system-prompt lane on ${ref.providerId}): ${sessionId}`);
      return;
    }
    // Review 7c3238b9-1 (plan mandate: "tools read-only by grant"): the
    // hidden agent is transcript-fed and UI-invisible, so v1 spawns ONLY on
    // the plan/read-only lane — a provider without a verified planModeArg
    // (the pi family today) is skipped, never run with default write tools.
    const planModeArg = getProvider(ref.providerId).meta.capabilities.planModeArg;
    if (!planModeArg) {
      console.log(`[lead-review] skipped (no read-only plan-mode grant on ${ref.providerId}): ${sessionId}`);
      return;
    }
    if (inFlightReviews >= LEAD_REVIEW_MAX_CONCURRENT) {
      console.log(`[lead-review] skipped (concurrency cap ${LEAD_REVIEW_MAX_CONCURRENT}): ${sessionId}`);
      return;
    }
    const { target, skip } = resolveLeadReviewTarget(loadState(), sessionId);
    if (!target) {
      // `lead review off for project` is the overwhelmingly common case —
      // logging it per completed session would spam every non-lead project.
      if (skip && skip !== 'lead review off for project' && skip !== 'kill-switch pref') {
        console.log(`[lead-review] skipped (${skip}): ${sessionId}`);
      }
      return;
    }
    reviewedSessions.add(sessionId);
    evictOldest(reviewedSessions, LEAD_REVIEWED_SESSIONS_MAX);
    // The durable claim (review 7c3238b9-2): the in-memory Set resets on
    // restart, the session record does not — a RESUMED completed session
    // must not re-bill a review.
    target.session.leadReviewedAt = Date.now();
    saveState(loadState());
    inFlightReviews++;
    void runLeadReview(target, ref, planModeArg)
      .catch((err) => {
        console.warn(`[lead-review] run failed: ${(err as Error).message}`);
      })
      .finally(() => {
        inFlightReviews--;
      });
  } catch (err) {
    console.warn(`[lead-review] skipped (gate threw): ${(err as Error).message}`);
  }
}
