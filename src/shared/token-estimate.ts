// Provider-agnostic rough token estimate. Used as a UI hint, not a budget check.
// Splits on whitespace and common punctuation; adds a char-based correction
// for long unbroken runs (URLs, base64, minified code) where the splitter
// undercounts. Expect ~5-15% error for typical text/code, more for non-Latin
// scripts. Always present the result prefixed with "~" in UI.

// Soft cap to keep the renderer responsive — skip counting on content beyond this.
export const TOKEN_COUNT_MAX_CHARS = 10 * 1024 * 1024;

const SPLIT_RE = /[\s\p{P}\p{S}]+/u;
const LONG_RUN_THRESHOLD = 12;
const CHARS_PER_TOKEN_IN_LONG_RUN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  for (const piece of text.split(SPLIT_RE)) {
    if (!piece) continue;
    if (piece.length <= LONG_RUN_THRESHOLD) {
      tokens += 1;
    } else {
      tokens += Math.ceil(piece.length / CHARS_PER_TOKEN_IN_LONG_RUN);
    }
  }

  const punctRuns = text.match(/[\p{P}\p{S}]+/gu);
  if (punctRuns) {
    for (const run of punctRuns) tokens += run.length;
  }

  return tokens;
}
