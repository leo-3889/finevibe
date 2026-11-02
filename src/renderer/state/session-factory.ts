import { LEAD_CHARTER_MAX_BYTES, type ProjectLead, type ProjectRecord, type ProviderId, type SessionRecord } from '../../shared/types.js';
import type { ShareMode } from '../../shared/sharing-types.js';
import { t } from '../i18n.js';

interface BaseOpts {
  id?: string;
  createdAt?: string;
}

export function buildCliSession(opts: BaseOpts & { name: string; providerId: ProviderId; args?: string; profileId?: string; envVars?: string }): SessionRecord {
  const { name, providerId, args, profileId, envVars, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    providerId,
    ...(args ? { args } : {}),
    ...(profileId ? { profileId } : {}),
    ...(envVars ? { envVars } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildDiffViewerSession(opts: BaseOpts & { name: string; filePath: string; area: string; worktreePath?: string }): SessionRecord {
  const { name, filePath, area, worktreePath, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'diff-viewer',
    diffFilePath: filePath,
    diffArea: area,
    ...(worktreePath ? { worktreePath } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildRemoteSession(opts: BaseOpts & { id: string; name: string; remoteHostName: string; shareMode: ShareMode }): SessionRecord {
  const { id, name, remoteHostName, shareMode, createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'remote-terminal',
    remoteHostName,
    shareMode,
    cliSessionId: null,
    createdAt,
  };
}

export function buildBrowserTabSession(opts: BaseOpts & { name: string; url?: string }): SessionRecord {
  const { name, url, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'browser-tab',
    browserTabUrl: url,
    cliSessionId: null,
    createdAt,
  };
}

export function buildProjectTabSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Overview`,
    type: 'project-tab',
    cliSessionId: null,
    createdAt,
  };
}

export function buildKanbanSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Kanban`,
    type: 'kanban',
    cliSessionId: null,
    createdAt,
  };
}

export function buildTeamSession(opts: BaseOpts & { projectName: string }): SessionRecord {
  const { projectName, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name: `${projectName} - Team`,
    type: 'team',
    cliSessionId: null,
    createdAt,
  };
}

export function buildFileReaderSession(opts: BaseOpts & { name: string; filePath: string; lineNumber?: number }): SessionRecord {
  const { name, filePath, lineNumber, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'file-reader',
    fileReaderPath: filePath,
    ...(lineNumber !== undefined ? { fileReaderLine: lineNumber } : {}),
    cliSessionId: null,
    createdAt,
  };
}

export function buildMcpInspectorSession(opts: BaseOpts & { name: string }): SessionRecord {
  const { name, id = crypto.randomUUID(), createdAt = new Date().toISOString() } = opts;
  return {
    id,
    name,
    type: 'mcp-inspector',
    cliSessionId: null,
    createdAt,
  };
}

/** UTF-8 size of the charter text: the cap is a byte budget because it rides argv. */
function charterBytes(charter: string): number {
  return new TextEncoder().encode(charter).length;
}

/**
 * Compose the project lead charter into ONE launch's spawn parameters
 * (team-lead-persona-plan M1, P2 I1b). Called from the renderer's single spawn
 * choke point (terminal-pane `spawnTerminal`), so main needs no lead knowledge:
 * the charter rides the parameters the spawn lane already transports
 * (`systemPrompt` / `initialPrompt`, quoted by `systemPromptArg` on Windows,
 * POSIX-quoted by the SSH wrap for remote launches — argv discipline unchanged).
 *
 * - Providers with a system-prompt lane (`capabilities.systemPromptInjection`:
 *   Claude, Codex, Pi, Pi-Bolt, OMP) carry the charter on `systemPrompt`:
 *   verbatim when nothing else flows, fenced AFTER an existing prompt (a team
 *   member's persona, a queued plan prompt) when one does. The charter never
 *   replaces a prompt.
 * - Providers without one (`systemPromptInjection: false`: Copilot, Gemini) get
 *   the charter fenced onto the FRONT of `initialPrompt`. A launch with no
 *   queued prompt has no lane to carry the charter, so its argv stays
 *   byte-identical — pushing the charter alone would make the CLI act on it as
 *   a user request. Per-provider rows: docs/provider-contracts.md.
 *
 * Absent lead, disabled lead, or a blank charter returns both parameters
 * untouched (byte-identical argv, pinned by tests).
 *
 * Cap, never truncate: a charter over `LEAD_CHARTER_MAX_BYTES` is only
 * reachable from a hand-edited state.json (the settings dialog refuses the
 * write), and throws naming the cap — the caller surfaces it as the spawn
 * failure, so the launch is refused rather than shipping a clipped charter.
 */
export function composeLeadLaunch(opts: {
  lead?: ProjectLead;
  /** The provider's `capabilities.systemPromptInjection`. */
  systemPromptInjection: boolean;
  systemPrompt?: string;
  initialPrompt?: string;
}): { systemPrompt?: string; initialPrompt?: string } {
  const { lead, systemPrompt, initialPrompt } = opts;
  // `charter` is typed required, but state.json is user-editable: a record
  // missing it must stay the absent feature, not throw at spawn.
  if (!lead?.enabled || !(lead.charter ?? '').trim()) return { systemPrompt, initialPrompt };
  const bytes = charterBytes(lead.charter);
  if (bytes > LEAD_CHARTER_MAX_BYTES) {
    throw new Error(t('sidebar.projectSettings.leadCharterTooLong', { size: bytes, max: LEAD_CHARTER_MAX_BYTES }));
  }
  const fenced = `[Project lead - ${lead.name}]\n${lead.charter}\n[/Project lead]`;
  if (opts.systemPromptInjection) {
    return {
      systemPrompt: systemPrompt ? `${systemPrompt.trimEnd()}\n\n${fenced}` : lead.charter,
      initialPrompt,
    };
  }
  return { systemPrompt, initialPrompt: initialPrompt ? `${fenced}\n\n${initialPrompt}` : initialPrompt };
}

/**
 * Append a session to a project, mark it active (unless `activate: false`),
 * and (when in swarm mode) add it to the swarm panes. Does not call persist()
 * or emit events — those remain the caller's responsibility.
 */
export function attachSessionToProject(
  project: ProjectRecord,
  session: SessionRecord,
  opts: { addToSwarm?: boolean; activate?: boolean } = {},
): SessionRecord {
  project.sessions.push(session);
  if (opts.activate !== false) project.activeSessionId = session.id;
  if (opts.addToSwarm && project.layout.mode === 'swarm') {
    project.layout.splitPanes.push(session.id);
  }
  return session;
}
