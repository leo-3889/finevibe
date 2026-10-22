// PA-34: team-widget.ts, member-card.ts and predefined-picker.ts carried
// identical initials() bodies.

/** Up-to-two uppercase initials from a name; '?' when it has no words. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
