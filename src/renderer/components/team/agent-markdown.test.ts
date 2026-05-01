import { describe, expect, it } from 'vitest';
import { buildAgentMarkdown } from './agent-markdown';
import type { TeamMember } from '../../../shared/types';

function member(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'id-1',
    name: 'CMO',
    role: 'Chief Marketing Officer',
    description: 'Strategic marketing leadership',
    systemPrompt: 'You are the CMO.\nLead with positioning.',
    source: 'custom',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('buildAgentMarkdown', () => {
  it('emits frontmatter with slug as name and a body', () => {
    expect(buildAgentMarkdown('cmo', member())).toBe(
      [
        '---',
        'name: cmo',
        'description: Chief Marketing Officer — Strategic marketing leadership',
        '---',
        '',
        'You are the CMO.\nLead with positioning.',
        '',
      ].join('\n'),
    );
  });

  it('omits description when both role and description are empty', () => {
    const out = buildAgentMarkdown('agent', member({ role: '', description: undefined }));
    expect(out).toBe(['---', 'name: agent', '---', '', 'You are the CMO.\nLead with positioning.', ''].join('\n'));
  });

  it('quotes description when it contains YAML-special characters', () => {
    const out = buildAgentMarkdown('a', member({ role: 'a:b', description: undefined }));
    expect(out).toContain('description: "a:b"');
  });

  it('strips trailing whitespace from systemPrompt to keep file ending clean', () => {
    const out = buildAgentMarkdown('a', member({ systemPrompt: 'hi\n\n\n' }));
    expect(out.endsWith('hi\n')).toBe(true);
  });
});
