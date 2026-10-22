import type { InitialContextSnapshot, ProjectRecord, ReadinessResult, ReadinessSnapshot } from '../../shared/types.js';

const SNAPSHOT_CAP = 50;
const READINESS_HISTORY_CAP = 30;
// C2R-17: dismissals are persisted with the project and their ids are never
// reused, so an uncapped list grows the state file forever.
const DISMISSED_CAP = 200;

function ensureInsights(project: ProjectRecord): NonNullable<ProjectRecord['insights']> {
  if (!project.insights) project.insights = { initialContextSnapshots: [], dismissed: [] };
  return project.insights;
}

export function addInsightSnapshot(project: ProjectRecord, snapshot: InitialContextSnapshot): void {
  const insights = ensureInsights(project);
  insights.initialContextSnapshots.push(snapshot);
  if (insights.initialContextSnapshots.length > SNAPSHOT_CAP) {
    insights.initialContextSnapshots = insights.initialContextSnapshots.slice(-SNAPSHOT_CAP);
  }
}

export function dismissInsight(project: ProjectRecord, insightId: string): void {
  const insights = ensureInsights(project);
  if (!insights.dismissed.includes(insightId)) insights.dismissed.push(insightId);
  if (insights.dismissed.length > DISMISSED_CAP) {
    insights.dismissed = insights.dismissed.slice(-DISMISSED_CAP);
  }
}

export function isInsightDismissed(project: ProjectRecord | undefined, insightId: string): boolean {
  return project?.insights?.dismissed.includes(insightId) ?? false;
}

export function setProjectReadiness(project: ProjectRecord, result: ReadinessResult): void {
  const snapshot: ReadinessSnapshot = {
    timestamp: result.scannedAt,
    overallScore: result.overallScore,
    categoryScores: Object.fromEntries(result.categories.map((c) => [c.id, c.score])),
  };
  const history = project.readinessHistory ?? [];
  project.readinessHistory = [...history, snapshot].slice(-READINESS_HISTORY_CAP);
  project.readiness = result;
}
