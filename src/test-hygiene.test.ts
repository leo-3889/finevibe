// P1-6 regression: a console spy left un-restored by one test must not be
// alive for the rest of the file (and, fatally for `npm test`, for vitest's
// own teardown — the audit flake exited 1 with every test green while a
// stubbed console intercepted teardown-time console writes).
//
// Test 1 deliberately reproduces the leak shape (spy created, never restored).
// Test 2 pins the structural fix: `setupFiles: [test/console-guard.ts]` in
// vitest.config.ts restores every mocked console method in afterEach, so the
// spy cannot survive into the next test. Without the setup file test 2 fails;
// with it, both pass.
import { describe, it, expect, vi } from 'vitest';

describe('console-stub teardown hygiene (P1-6)', () => {
  it('leaks a console.warn spy when a test skips mockRestore', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(vi.isMockFunction(console.warn)).toBe(true);
    // No restore here — this is the leak, by design.
  });

  it('the console.warn leak is repaired before the next test runs', () => {
    expect(vi.isMockFunction(console.warn)).toBe(false);
  });
});
