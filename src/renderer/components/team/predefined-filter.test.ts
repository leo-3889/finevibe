import { describe, it, expect } from 'vitest';
import type { TeamMember } from '../../../shared/types.js';
import { filterMembers } from './predefined-filter';

const make = (overrides: Partial<TeamMember>): TeamMember => ({
  id: overrides.id ?? 'x',
  name: overrides.name ?? 'X',
  role: overrides.role ?? 'Role',
  description: overrides.description,
  domain: overrides.domain,
  systemPrompt: overrides.systemPrompt ?? 'sp',
  source: 'predefined',
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const members: TeamMember[] = [
  make({ id: 'pd', name: 'Product Designer', role: 'Designer', description: 'flows and microcopy', domain: 'product-design' }),
  make({ id: 'be', name: 'Backend Engineer', role: 'Engineer', description: 'APIs and databases', domain: 'engineering-core' }),
  make({ id: 'fe', name: 'Frontend Engineer', role: 'Engineer', description: 'UI and components', domain: 'engineering-core' }),
  make({ id: 'sec', name: 'Security Engineer', role: 'Engineer', description: 'threat modeling', domain: 'ops-security-data' }),
  make({ id: 'misc', name: 'Misc', role: 'Other', description: undefined, domain: undefined }),
];

describe('filterMembers', () => {
  it('returns all members when query is empty and domain is all', () => {
    expect(filterMembers(members, '', 'all')).toHaveLength(members.length);
  });

  it('matches name case-insensitively', () => {
    const out = filterMembers(members, 'BACKEND', 'all');
    expect(out.map((m) => m.id)).toEqual(['be']);
  });

  it('matches role', () => {
    const out = filterMembers(members, 'designer', 'all');
    expect(out.map((m) => m.id)).toEqual(['pd']);
  });

  it('matches description', () => {
    const out = filterMembers(members, 'threat', 'all');
    expect(out.map((m) => m.id)).toEqual(['sec']);
  });

  it('does not match systemPrompt', () => {
    const withPrompt = [...members, make({ id: 'sp', name: 'A', role: 'B', systemPrompt: 'unique-prompt-token' })];
    expect(filterMembers(withPrompt, 'unique-prompt-token', 'all')).toEqual([]);
  });

  it('filters by domain', () => {
    const out = filterMembers(members, '', 'engineering-core');
    expect(out.map((m) => m.id).sort()).toEqual(['be', 'fe']);
  });

  it('treats missing domain as "other" when filter is other', () => {
    const out = filterMembers(members, '', 'other');
    expect(out.map((m) => m.id)).toEqual(['misc']);
  });

  it('combines query and domain (AND)', () => {
    const out = filterMembers(members, 'engineer', 'engineering-core');
    expect(out.map((m) => m.id).sort()).toEqual(['be', 'fe']);
    const empty = filterMembers(members, 'engineer', 'product-design');
    expect(empty).toEqual([]);
  });

  it('trims whitespace and normalizes case in query', () => {
    expect(filterMembers(members, '   FRONTEND   ', 'all').map((m) => m.id)).toEqual(['fe']);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterMembers(members, 'no-such-token', 'all')).toEqual([]);
  });
});
