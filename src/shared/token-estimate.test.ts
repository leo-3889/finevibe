import { describe, it, expect } from 'vitest';
import { estimateTokens } from './token-estimate';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts whitespace-separated words', () => {
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('the quick brown fox')).toBe(4);
  });

  it('counts each punctuation char as a token', () => {
    expect(estimateTokens('hello, world!')).toBe(4); // hello + , + world + !
  });

  it('handles code-like input', () => {
    // 'const x = 42;' -> const, x, =, 42, ; = 5
    expect(estimateTokens('const x = 42;')).toBe(5);
  });

  it('returns positive count for CJK text', () => {
    // No spaces in CJK; will count as one long run via the char-based correction.
    expect(estimateTokens('你好世界你好世界你好世界你好')).toBeGreaterThan(0);
  });

  it('handles a long unbroken token (minified) via char-based correction', () => {
    const longRun = 'a'.repeat(100);
    // 100 chars / 4 = 25 tokens for the run.
    expect(estimateTokens(longRun)).toBe(25);
  });

  it('produces roughly reasonable counts for a paragraph', () => {
    const para =
      'The estimateTokens function provides a rough, provider-agnostic count ' +
      'used as a UI hint, not for budget calculations.';
    const n = estimateTokens(para);
    // ~21 words + some punctuation. Sanity-check the range, not the exact value.
    expect(n).toBeGreaterThan(15);
    expect(n).toBeLessThan(40);
  });

  it('returns 0 for whitespace-only input', () => {
    expect(estimateTokens('   \n\t  ')).toBe(0);
  });
});
