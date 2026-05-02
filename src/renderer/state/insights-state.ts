import type { InitialContextSnapshot, ProjectRecord, ReadinessResult, ReadinessSnapshot } from '../../shared/types.js';

const SNAPSHOT_CAP = 50;
const READINESS_HISTORY_CAP = 30;

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
