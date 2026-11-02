import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubGlobal('window', {
  finevibe: { store: { load: vi.fn(), save: vi.fn() } },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` });

vi.mock('./session-cost.js', () => ({ getCost: vi.fn().mockReturnValue(null), restoreCost: vi.fn() }));
vi.mock('./session-context.js', () => ({ restoreContext: vi.fn() }));
vi.mock('./provider-availability.js', () => ({ getProviderCapabilities: vi.fn() }));

import { appState, _resetForTesting } from './state';
import { ensureProjectDefaults } from './state/persistence';
import { addTask, getTaskBySessionId, updateTask } from './board-state';
import {
  capLeadReviewSummary,
  normalizeLeadReview,
  setLeadReview,
  getInspectorLeadReview,
} from './lead-review';
import {
  LEAD_REVIEW_SUMMARY_MAX_CHARS,
  LEAD_REVIEW_HISTORY_MAX,
  type LeadReviewNote,
} from '../shared/types';

const note = (over: Partial<LeadReviewNote> = {}): LeadReviewNote => ({
  v: 1,
  sessionId: 'sess-1',
  verdict: 'approved',
  summary: 'Ship it.',
  createdAt: 1700000000000,
  ...over,
});

/** addTask drops sessionId (a runtime link), so tests attach it the way the app does. */
function makeTaskWithSession(sessionId: string) {
  const task = addTask({ title: 'T', prompt: 'p' });
  updateTask(task!.id, { sessionId });
  return task!;
}

function makeProject() {
  const project = appState.addProject('Test', '/test');
  project.board = {
    columns: [
      { id: 'col-inbox', title: 'Inbox', order: 0, behavior: 'inbox' as const },
      { id: 'col-active', title: 'Active', order: 1, behavior: 'active' as const },
    ],
    tasks: [],
  };
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(window.finevibe.store.save).mockClear();
  uuidCounter = 0;
  _resetForTesting();
});

describe('capLeadReviewSummary', () => {
  it('leaves a summary at the cap intact', () => {
    const s = 'x'.repeat(LEAD_REVIEW_SUMMARY_MAX_CHARS);
    expect(capLeadReviewSummary(s)).toBe(s);
  });

  it('truncates over the cap to the cap, with the ellipsis inside it', () => {
    const out = capLeadReviewSummary('x'.repeat(LEAD_REVIEW_SUMMARY_MAX_CHARS + 500));
    expect(out.length).toBe(LEAD_REVIEW_SUMMARY_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('normalizeLeadReview', () => {
  it('accepts a well-formed verdict and caps its summary', () => {
    const out = normalizeLeadReview(note({ summary: 'y'.repeat(9000) }));
    expect(out).not.toBeNull();
    expect(out!.summary.length).toBe(LEAD_REVIEW_SUMMARY_MAX_CHARS);
  });

  it.each([
    ['null', null],
    ['a string', 'approved'],
    ['a foreign shape version', note({ v: 2 as 1 })],
    ['a missing session id', { ...note(), sessionId: '' }],
    ['an unknown verdict', { ...note(), verdict: 'maybe' }],
    ['a non-string summary', { ...note(), summary: 42 }],
    ['a non-numeric timestamp', { ...note(), createdAt: 'now' }],
  ])('drops %s', (_label, raw) => {
    expect(normalizeLeadReview(raw)).toBeNull();
  });
});

describe('setLeadReview — board surface', () => {
  it('lands the note on the card for that session', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');

    expect(setLeadReview(note(), project.id)).toBe(true);
    const stored = getTaskBySessionId('sess-1', project.id)!.leadReview;
    expect(stored).toEqual(note());
  });

  it('persists additively: the note survives a save round-trip', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');
    setLeadReview(note({ verdict: 'flagged', summary: 'Missing tests.' }), project.id);

    const revived = JSON.parse(JSON.stringify(project)).board.tasks[0];
    expect(revived.leadReview).toEqual({
      v: 1,
      sessionId: 'sess-1',
      verdict: 'flagged',
      summary: 'Missing tests.',
      createdAt: 1700000000000,
    });
  });

  it('zero-delta: a card nobody reviewed serializes with no leadReview key', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');

    expect(JSON.stringify(project.board!.tasks[0])).not.toContain('leadReview');
    expect(project.leadReviews).toBeUndefined();
  });

  it('a newer verdict replaces the older one on the card', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');
    setLeadReview(note({ summary: 'first' }), project.id);
    setLeadReview(note({ verdict: 'flagged', summary: 'second', createdAt: 1700000009999 }), project.id);

    const task = getTaskBySessionId('sess-1', project.id)!;
    expect(task.leadReview).toEqual(note({ verdict: 'flagged', summary: 'second', createdAt: 1700000009999 }));
  });

  it('refuses a malformed verdict without touching the card', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');
    expect(setLeadReview({ ...note(), verdict: 'ship-it' }, project.id)).toBe(false);
    expect(getTaskBySessionId('sess-1', project.id)!.leadReview).toBeUndefined();
  });
});

describe('setLeadReview — inspector surface (no board card)', () => {
  it('lands on the project list when the session has no task', () => {
    const project = makeProject();
    expect(setLeadReview(note(), project.id)).toBe(true);
    expect(getInspectorLeadReview(project, 'sess-1')).toEqual(note());
    expect(JSON.stringify(project).length).toBeGreaterThan(0);
  });

  it('an empty board (no tasks) is the no-board path', () => {
    const project = makeProject();
    project.board = undefined;
    expect(setLeadReview(note({ sessionId: 'solo' }), project.id)).toBe(true);
    expect(getInspectorLeadReview(project, 'solo')!.verdict).toBe('approved');
  });

  it('keeps one verdict per session and caps history at LEAD_REVIEW_HISTORY_MAX', () => {
    const project = makeProject();
    for (let i = 0; i <= LEAD_REVIEW_HISTORY_MAX; i++) {
      setLeadReview(note({ sessionId: `sess-${i}`, createdAt: 1700000000000 + i }), project.id);
    }
    expect(project.leadReviews!.length).toBe(LEAD_REVIEW_HISTORY_MAX);
    // Newest first: the last write is kept, the oldest dropped.
    expect(project.leadReviews![0].sessionId).toBe(`sess-${LEAD_REVIEW_HISTORY_MAX}`);
    expect(project.leadReviews!.some(r => r.sessionId === 'sess-0')).toBe(false);

    // A re-review of a kept session replaces in place — no growth.
    setLeadReview(note({ sessionId: `sess-${LEAD_REVIEW_HISTORY_MAX}`, summary: 'again' }), project.id);
    expect(project.leadReviews!.length).toBe(LEAD_REVIEW_HISTORY_MAX);
    expect(project.leadReviews!.filter(r => r.sessionId === `sess-${LEAD_REVIEW_HISTORY_MAX}`)).toHaveLength(1);
  });

  it('zero-delta: an unreviewed project serializes with no leadReviews key', () => {
    const project = makeProject();
    expect(JSON.stringify(project)).not.toContain('leadReviews');
    expect(getInspectorLeadReview(project, 'sess-1')).toBeUndefined();
    expect(getInspectorLeadReview(undefined, 'sess-1')).toBeUndefined();
  });

  it('writes nothing when no project is loaded', () => {
    _resetForTesting();
    expect(setLeadReview(note(), 'no-such-project')).toBe(false);
  });
});

describe('review fixes (e609bc6a)', () => {
  it('caps in CODE POINTS: a surrogate pair at the boundary is not split', () => {
    const s = capLeadReviewSummary('a'.repeat(LEAD_REVIEW_SUMMARY_MAX_CHARS - 2) + '\ud83d\ude00tail');
    const cps = Array.from(s);
    expect(cps.length).toBe(LEAD_REVIEW_SUMMARY_MAX_CHARS);
    expect(cps.at(-1)).toBe('\u2026');
    // The char before the ellipsis is a COMPLETE code point, never a lone
    // high surrogate (the UTF-16 slice bug).
    const before = cps.at(-2)!;
    expect(/^[\ud800-\udbff]$/.test(before)).toBe(false);
  });

  it('drops a createdAt outside the JS Date range (Invalid Date tooltip)', () => {
    expect(normalizeLeadReview(note({ createdAt: 1e18 }))).toBeNull();
    expect(normalizeLeadReview(note({ createdAt: -1e18 }))).toBeNull();
    expect(normalizeLeadReview(note({ createdAt: 1700000000000 }))).not.toBeNull();
  });

  it('a re-delivered identical verdict is deduped: no persist churn', () => {
    const project = makeProject();
    makeTaskWithSession('sess-1');
    expect(setLeadReview(note(), project.id)).toBe(true);
    const savesAfterFirst = vi.mocked(window.finevibe.store.save).mock.calls.length;
    const task = getTaskBySessionId('sess-1', project.id)!;
    const updatedAt = task.updatedAt;
    expect(setLeadReview(note(), project.id)).toBe(true);
    expect(vi.mocked(window.finevibe.store.save).mock.calls.length).toBe(savesAfterFirst);
    expect(getTaskBySessionId('sess-1', project.id)!.updatedAt).toBe(updatedAt);
  });

  it('routes to the card by cliSessionId after a restart (sessionId cleared)', () => {
    const project = makeProject();
    const task = makeTaskWithSession('sess-1');
    updateTask(task.id, { cliSessionId: 'cli-9' });
    // Load normalization: the runtime link is gone; the CLI id survives.
    task.sessionId = undefined;
    expect(setLeadReview(note({ sessionId: 'cli-9' }), project.id)).toBe(true);
    expect(task.leadReview?.sessionId).toBe('cli-9');
    expect(project.leadReviews).toBeUndefined();
  });

  it('linking a new run clears the inherited verdict (and serializes zero-delta)', () => {
    const project = makeProject();
    const task = makeTaskWithSession('sess-1');
    setLeadReview(note(), project.id);
    expect(task.leadReview).toBeDefined();
    // The board-card link sites run exactly this write for a fresh run.
    updateTask(task.id, { sessionId: 'sess-2', leadReview: undefined });
    expect(task.leadReview).toBeUndefined();
    expect(JSON.stringify(task)).not.toContain('leadReview');
  });

  it('hydrate drops hand-edited notes (projects + cards), keeps valid ones', () => {
    const project = makeProject();
    const task = makeTaskWithSession('sess-1');
    project.leadReviews = [note({ sessionId: 'ok' }), { v: 1, sessionId: 'x', verdict: 'ship-it', summary: 's', createdAt: 1 } as never];
    task.leadReview = { v: 1, sessionId: 'sess-1', verdict: 'evil-class', summary: 's'.repeat(9999), createdAt: 1e18 };
    const state = { projects: [project] } as never;
    ensureProjectDefaults(state);
    expect(project.leadReviews).toHaveLength(1);
    expect(project.leadReviews![0].sessionId).toBe('ok');
    expect(task.leadReview).toBeUndefined();
  });
});
