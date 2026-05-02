import type { TeamMember } from '../../../shared/types.js';
import type { TeamDomain } from '../../../shared/team-config.js';

export type DomainFilter = TeamDomain | 'all';

export function filterMembers(
  members: TeamMember[],
  query: string,
  domain: DomainFilter,
): TeamMember[] {
  const q = query.trim().toLowerCase();
  return members.filter((m) => {
    if (domain !== 'all' && (m.domain ?? 'other') !== domain) return false;
    if (!q) return true;
    const haystack = `${m.name} ${m.role} ${m.description ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}
