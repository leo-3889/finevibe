import type { CliProviderCapabilities, Preferences, ProjectRecord, ProviderId, SessionRecord } from '../../shared/types.js';

/** Resolve the provider id for a plan session: override → active session's → default → claude. */
export function resolvePlanProvider(
  project: ProjectRecord,
  prefs: Preferences,
  override: ProviderId | undefined,
): ProviderId {
  const activeSession = project.sessions.find((s) => s.id === project.activeSessionId);
  return override ?? activeSession?.providerId ?? prefs.defaultProvider ?? 'claude';
}

/** Build the args string for a plan session: project default args + plan-mode flag (if enabled). */
export function buildPlanSessionArgs(
  project: ProjectRecord,
  caps: CliProviderCapabilities | null | undefined,
  planMode: boolean,
): string | undefined {
  const planArg = planMode ? (caps?.planModeArg ?? '') : '';
  const base = project.defaultArgs ?? '';
  return [base, planArg].filter(Boolean).join(' ').trim() || undefined;
}

/** Resolve the providerId used when creating a plain CLI session. */
export function resolveCliProvider(prefs: Preferences, override: ProviderId | undefined): ProviderId {
  return override ?? prefs.defaultProvider ?? 'claude';
}

export function findExistingDiffViewer(
  project: ProjectRecord,
  filePath: string,
  area: string,
  worktreePath: string | undefined,
): SessionRecord | undefined {
  return project.sessions.find(
    (s) => s.type === 'diff-viewer' && s.diffFilePath === filePath && s.diffArea === area && s.worktreePath === worktreePath,
  );
}

export function findExistingBrowserTab(project: ProjectRecord, url: string): SessionRecord | undefined {
  return project.sessions.find((s) => s.type === 'browser-tab' && s.browserTabUrl === url);
}

export function findExistingFileReader(project: ProjectRecord, filePath: string): SessionRecord | undefined {
  return project.sessions.find((s) => s.type === 'file-reader' && s.fileReaderPath === filePath);
}

export function findExistingTabByType(
  project: ProjectRecord,
  type: 'project-tab' | 'kanban' | 'team',
): SessionRecord | undefined {
  return project.sessions.find((s) => s.type === type);
}

/** Try to derive a tab title from a URL hostname; fall back to the raw URL or 'Browser'. */
export function browserTabNameFromUrl(url: string | undefined): string {
  if (!url) return 'Browser';
  try { return new URL(url).hostname || url; } catch { return url; }
}
