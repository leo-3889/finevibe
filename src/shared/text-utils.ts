// PA-34: single home for small text helpers that were duplicated across
// components (favorite-sessions-widget / sessions-widget carried identical
// formatRelativeDate bodies). Renderer-only DOM helpers (escapeHtml) live in
// src/renderer/components/escape-html.ts — tsconfig.main compiles src/shared
// with lib ES2024, no DOM.

/** Compact "x ago" timestamp; '' for an invalid ISO date, locale date past a week. */
export function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
