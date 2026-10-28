// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { drainEarlyCrashes } from './early-crash';

// The served-page inline handler (injected by src/main/app-scheme.ts, audit
// row 16) fills window.__fvEarlyCrash before the bundle evaluates; index.ts
// drains it into reportRendererError. The drain's contract: take everything,
// leave the array empty (a second drain must never re-report), and never throw
// when the inline script never ran (page opened without the injection).

describe('drainEarlyCrashes', () => {
  beforeEach(() => {
    delete window.__fvEarlyCrash;
  });

  it('returns nothing when the pre-load handler recorded nothing', () => {
    expect(drainEarlyCrashes()).toEqual([]);
    window.__fvEarlyCrash = [];
    expect(drainEarlyCrashes()).toEqual([]);
  });

  it('takes ownership of the entries and clears the array', () => {
    window.__fvEarlyCrash = ['error: boom @ app://finevibe/index.js:1:2', 'rejection: TypeError: x'];
    expect(drainEarlyCrashes()).toEqual(['error: boom @ app://finevibe/index.js:1:2', 'rejection: TypeError: x']);
    expect(window.__fvEarlyCrash).toEqual([]);
    expect(drainEarlyCrashes()).toEqual([]);
  });

  it('survives a non-array global (tampered/absent handler)', () => {
    window.__fvEarlyCrash = 'not-an-array' as unknown as string[];
    expect(drainEarlyCrashes()).toEqual([]);
  });
});
