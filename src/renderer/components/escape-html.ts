// PA-34: file-viewer.ts and quick-open.ts carried identical escapeHtml bodies.
// Renderer-local: the implementation needs `document`, and src/shared is
// compiled by tsconfig.main with lib ES2024 (no DOM).

export function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
