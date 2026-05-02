import type { ProjectRecord, ProviderId, SessionRecord, TeamData, TeamMember } from '../../shared/types.js';
import { ensureUniqueSlug, nameToSlug } from '../../shared/slug.js';
import { buildAgentMarkdown } from '../components/team/agent-markdown.js';
import { getTeamChatProviderMetas } from '../provider-availability.js';
import { isCliSession } from '../session-utils.js';
import { buildCliSession } from './session-factory.js';

export function getTeamData(team: TeamData | undefined, ensure: () => TeamData): TeamData {
  return team ?? ensure();
}

export function buildNewMember(
  input: Omit<TeamMember, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
): TeamMember {
  const now = Date.now();
  return {
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    role: input.role,
    description: input.description,
    systemPrompt: input.systemPrompt,
    source: input.source,
    sourceUrl: input.sourceUrl,
    installAsAgent: input.installAsAgent,
    agentSlug: input.agentSlug,
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply a patch to a member in place; returns a snapshot of the prior state, or undefined if not found. */
export function applyMemberPatch(
  team: TeamData,
  id: string,
  patch: Partial<Omit<TeamMember, 'id' | 'createdAt'>>,
): { before: TeamMember; after: TeamMember } | undefined {
  const member = team.members.find((m) => m.id === id);
  if (!member) return undefined;
  const before: TeamMember = { ...member };
  Object.assign(member, patch, { updatedAt: Date.now() });
  return { before, after: member };
}

/** Remove a member; returns the removed entry, or undefined if not found. */
export function removeMember(team: TeamData, id: string): TeamMember | undefined {
  const removed = team.members.find((m) => m.id === id);
  if (!removed) return undefined;
  team.members = team.members.filter((m) => m.id !== id);
  return removed;
}

/** Assign a unique agentSlug to a member if it doesn't already have one. Returns true if a slug was assigned. */
export function ensureAgentSlug(team: TeamData, member: TeamMember): boolean {
  if (member.agentSlug) return false;
  const taken = new Set(team.members.filter((m) => m !== member && m.agentSlug).map((m) => m.agentSlug!));
  member.agentSlug = ensureUniqueSlug(nameToSlug(member.name), taken);
  return true;
}

/**
 * Pick the provider for a team chat session: override → active CLI session's provider → default → claude,
 * filtered by which providers actually support team chat.
 */
export function pickTeamChatProvider(
  activeSession: SessionRecord | undefined,
  defaultProvider: ProviderId | undefined,
  override: ProviderId | undefined,
): ProviderId | undefined {
  const teamCapable = new Set(getTeamChatProviderMetas().map((p) => p.id));
  const candidates: (ProviderId | undefined)[] = [
    override,
    activeSession && isCliSession(activeSession) ? activeSession.providerId : undefined,
    defaultProvider,
    'claude',
  ];
  return candidates.find((id): id is ProviderId => !!id && teamCapable.has(id));
}

/** Build the SessionRecord for a team chat session, including the pendingSystemPrompt and teamMemberId. */
export function buildTeamChatSession(
  project: ProjectRecord,
  member: TeamMember,
  providerId: ProviderId,
  maxNameLength: number,
): SessionRecord {
  const sessionNum = project.sessions.filter((s) => s.teamMemberId === member.id).length + 1;
  const base = buildCliSession({
    name: `${member.name} - Session ${sessionNum}`.slice(0, maxNameLength),
    providerId,
    args: project.defaultArgs,
  });
  return {
    ...base,
    teamMemberId: member.id,
    pendingSystemPrompt: member.systemPrompt,
  };
}

export interface AgentApi {
  installAgent(slug: string, content: string): Promise<unknown>;
  removeAgent(slug: string): Promise<unknown>;
}

/**
 * Assign a slug if needed, then write the agent markdown to all installed providers.
 * `persistSlug` is invoked when a new slug is assigned so the caller can persist state.
 */
export async function syncAgentInstall(
  api: AgentApi,
  team: TeamData,
  member: TeamMember,
  persistSlug: () => void,
): Promise<void> {
  if (ensureAgentSlug(team, member)) persistSlug();
  try {
    await api.installAgent(member.agentSlug!, buildAgentMarkdown(member.agentSlug!, member));
  } catch (err) {
    console.warn('installAgent failed:', err);
  }
}

/** Apply the four-cell reconcile table: install / remove / rewrite. */
export async function reconcileAgent(
  api: AgentApi,
  team: TeamData,
  before: TeamMember,
  after: TeamMember,
  persistSlug: () => void,
): Promise<void> {
  const wasOn = !!before.installAsAgent;
  const isOn = !!after.installAsAgent;
  if (!wasOn && !isOn) return;
  if (!wasOn && isOn) {
    await syncAgentInstall(api, team, after, persistSlug);
    return;
  }
  if (wasOn && !isOn) {
    const slug = before.agentSlug;
    after.agentSlug = undefined;
    persistSlug();
    if (slug) {
      try { await api.removeAgent(slug); }
      catch (err) { console.warn('removeAgent failed:', err); }
    }
    return;
  }
  if (before.agentSlug && after.agentSlug && before.agentSlug === after.agentSlug) {
    const oldContent = buildAgentMarkdown(before.agentSlug, before);
    const newContent = buildAgentMarkdown(after.agentSlug, after);
    if (oldContent === newContent) return;
  }
  await syncAgentInstall(api, team, after, persistSlug);
}

export function fireAndForgetRemoveAgent(api: AgentApi, slug: string): void {
  void api.removeAgent(slug).catch((err) => {
    console.warn('removeAgent failed:', err);
  });
}
