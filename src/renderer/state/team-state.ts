import type { Preferences, Profile, ProjectRecord, ProviderId, SessionRecord, TeamData, TeamMember } from '../../shared/types.js';
import { ensureUniqueSlug, nameToSlug } from '../../shared/slug.js';
import { buildAgentMarkdown } from '../components/team/agent-markdown.js';
import { getTeamCapableProviderIds } from '../provider-availability.js';
import { isCliSession } from '../session-utils.js';
import { resolveProfile } from './specialized-sessions.js';
import { profileHost } from '../../shared/profile-keys.js';
import { buildCliSession } from './session-factory.js';

/**
 * C4TM-06: hard cap on a member's system prompt. The prompt ships to the
 * CLI as a spawn argument, and an oversized one dies in `spawn E2BIG`
 * (argv-size class); 64 KiB sits well under the conservative OS argv
 * budgets and far above any legitimate persona.
 */
export const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;

/** UTF-8 encoded size of a system prompt (the argv budget is bytes, not UTF-16 length). */
export function systemPromptByteLength(prompt: string): number {
  return new TextEncoder().encode(prompt).length;
}

/** True when a present system prompt exceeds MAX_SYSTEM_PROMPT_BYTES. */
export function isSystemPromptOversize(prompt: string | undefined): boolean {
  return prompt !== undefined && systemPromptByteLength(prompt) > MAX_SYSTEM_PROMPT_BYTES;
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
    profileId: input.profileId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * C4TM-03: predefined-member ids come from upstream frontmatter, so they
 * are attacker-influenced; two members sharing an id make one card's
 * delete remove both. Suffix a colliding id on add: `id-2`, `id-3`, …
 * (the first free slot; a fresh random id never collides).
 */
export function uniqueMemberId(members: readonly TeamMember[], id: string): string {
  const taken = new Set(members.map((m) => m.id));
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
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
  const teamCapable = getTeamCapableProviderIds();
  const candidates: (ProviderId | undefined)[] = [
    override,
    activeSession && isCliSession(activeSession) ? activeSession.providerId : undefined,
    defaultProvider,
    'claude',
  ];
  return candidates.find((id): id is ProviderId => !!id && teamCapable.has(id));
}

/**
 * The Profile a member is pinned to, but only when that profile's provider is
 * team-capable (installed + supports system-prompt injection). Returns undefined
 * for an unpinned member, a dangling pin, or a pin on a provider that can't run
 * team personas. Shared by the backend resolution and the Chat controls, which
 * hide the provider chevron when the pin already fixes the backend.
 */
export function resolvePinnedTeamProfile(
  member: TeamMember,
  profiles: Profile[],
  hostId?: string,
): Profile | undefined {
  if (!member.profileId) return undefined;
  const pinned = profiles.find((p) => p.id === member.profileId);
  if (!pinned) return undefined;
  // A profile is a directory on ONE machine (Phase 1 rule): a launch on a
  // remote project can never run a local profile's config dir, so a
  // cross-host pin resolves to no-pin - exactly what startTeamChat spawns.
  if (hostId && profileHost(pinned) !== hostId) return undefined;
  return getTeamCapableProviderIds().has(pinned.providerId) ? pinned : undefined;
}

/**
 * Resolve the backend (provider + profile) a team chat session runs on.
 *
 * A pinned member profile wins outright: the provider comes *from* the profile, so
 * a member can never end up on a provider that contradicts its pin. If the pin is
 * missing or targets a provider that isn't team-capable, fall back to the normal
 * provider pick plus the project → global profile chain (same as a plain session).
 * Returns undefined when no team-capable provider exists at all.
 */
export function resolveTeamChatBackend(
  member: TeamMember,
  project: ProjectRecord,
  prefs: Preferences,
  activeSession: SessionRecord | undefined,
  profiles: Profile[],
  overrideProviderId: ProviderId | undefined,
): { providerId: ProviderId; profileId?: string } | undefined {
  const pinned = resolvePinnedTeamProfile(member, profiles, project.hostId);
  if (pinned) return { providerId: pinned.providerId, profileId: pinned.id };
  const providerId = pickTeamChatProvider(activeSession, prefs.defaultProvider, overrideProviderId ?? project.defaultProvider);
  if (!providerId) return undefined;
  const profile = resolveProfile(undefined, project, prefs, providerId, profiles, project.hostId);
  return { providerId, profileId: profile?.id };
}

/** New-session-modal fields forwarded onto a team-chat session record. */
export interface TeamChatOpts {
  name?: string;
  args?: string;
  envVars?: string;
}

/**
 * C4T-01: the next `'<name> - Session N'` ordinal — one past the highest N
 * among the member's existing session names. Counting live sessions reused
 * a number as soon as a tab closed, and the new tab collided with a
 * surviving `Session N` name. Truncated/foreign names simply do not match
 * the `'<name> - Session <digits>'` pattern.
 */
export function nextSessionOrdinal(baseName: string, existingNames: Iterable<string>): number {
  const prefix = `${baseName} - Session `;
  let max = 0;
  for (const name of existingNames) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * Build the SessionRecord for a team chat session, including the pendingSystemPrompt and teamMemberId.
 * `opts` carries the New Session modal's fields: an explicit `name` (blank keeps the
 * member-derived "Name - Session N", derived by nextSessionOrdinal from
 * `existingNames` — the member's sessions incl. the state-wide session
 * index — when the caller supplies them, falling back to this project's
 * live tabs), an explicit `args` — a present key wins even when
 * undefined, so clearing the field clears the args; an absent key keeps the project
 * default — and `envVars`.
 */
export function buildTeamChatSession(
  project: ProjectRecord,
  member: TeamMember,
  providerId: ProviderId,
  maxNameLength: number,
  profileId?: string,
  opts?: TeamChatOpts,
  existingNames?: Iterable<string>,
): SessionRecord {
  const names = existingNames
    ?? project.sessions.filter((s) => s.teamMemberId === member.id).map((s) => s.name);
  const sessionNum = nextSessionOrdinal(member.name, names);
  const base = buildCliSession({
    name: (opts?.name?.trim() || `${member.name} - Session ${sessionNum}`).slice(0, maxNameLength),
    providerId,
    args: opts && 'args' in opts ? opts.args : project.defaultArgs,
    profileId,
    envVars: opts?.envVars,
  });
  return {
    ...base,
    teamMemberId: member.id,
    pendingSystemPrompt: member.systemPrompt,
  };
}

export interface AgentApi {
  installAgent(slug: string, content: string, configDir?: string): Promise<unknown>;
  removeAgent(slug: string): Promise<unknown>;
}

/**
 * Assign a slug if needed, then write the agent markdown to all installed providers.
 * `persistSlug` is invoked when a new slug is assigned so the caller can persist state.
 * `configDir` (P2-116) is the member's pinned profile config dir - a profiled
 * Claude run reads agents from CLAUDE_CONFIG_DIR, so the install must target
 * that tree, not the hardcoded ~/.claude/agents.
 */
export async function syncAgentInstall(
  api: AgentApi,
  team: TeamData,
  member: TeamMember,
  persistSlug: () => void,
  configDir?: string,
): Promise<void> {
  if (ensureAgentSlug(team, member)) persistSlug();
  try {
    await api.installAgent(member.agentSlug!, buildAgentMarkdown(member.agentSlug!, member), configDir);
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
  configDir?: string,
): Promise<void> {
  const wasOn = !!before.installAsAgent;
  const isOn = !!after.installAsAgent;
  if (!wasOn && !isOn) return;
  if (!wasOn && isOn) {
    await syncAgentInstall(api, team, after, persistSlug, configDir);
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
