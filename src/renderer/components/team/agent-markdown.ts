import type { TeamMember } from '../../../shared/types.js';

/**
 * Build the agent markdown body written to `~/.<cli>/agents/<slug>.md`.
 * Format mirrors the persona files in `personas/` — YAML frontmatter + body.
 * `name` is set to `slug` so filename and slash-command identifier agree.
 */
export function buildAgentMarkdown(slug: string, member: TeamMember): string {
  const description = [member.role, member.description].filter(Boolean).join(' — ');
  const lines = ['---', `name: ${slug}`];
  if (description) lines.push(`description: ${escapeYaml(description)}`);
  lines.push('---', '', member.systemPrompt.trimEnd(), '');
  return lines.join('\n');
}

function escapeYaml(value: string): string {
  if (/[:#\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
