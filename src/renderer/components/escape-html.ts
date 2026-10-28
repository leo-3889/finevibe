// PA-34: single home for escapeHtml. The original body was DOM-based
// (createElement/textContent/innerHTML); it was replaced by the regex body
// every live call site actually used — it also escapes quotes, which the DOM
// version left raw in attribute contexts. The duplicate bodies in
// dom-search-backend.ts and session-inspector-utils.ts now re-export this one
// (row 24, code-cleanup audit 2026-10-28).
// Renderer-local: src/shared is compiled by tsconfig.main (lib ES2024, no
// DOM), and PA-34's home convention keeps renderer helpers here.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
