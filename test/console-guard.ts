// Vitest setup file (registered via `setupFiles` in vitest.config.ts).
//
// P1-6: `npm test` flipped to exit 1 with every test green in ~1/5 runs. The
// suite spies on console (pty-manager.test.ts x6, git-watcher.test.ts,
// codex-session-watcher.test.ts, pi-compatible-session-watcher.test.ts,
// session-transcript-sync.test.ts) and restores each spy inline at the end of
// its own test. When an async path (watcher tick, PTY flush, stream close)
// writes to console after that inline restore — i.e. between the spy's
// `mockRestore()` and the end of the test file — vitest's per-file console
// interception hands the write to a stub that is no longer backed by an
// active mock, and the resulting error surfaces during worker teardown as an
// unhandled "console" error: the summary stays "all passed" while the process
// exits 1. There was no afterEach backstop, no `restoreMocks`, and no setup
// file; restoration was per-test convention, which is exactly the shape of a
// 1-in-5 race.
//
// This backstop makes restoration structural: after every test, any console
// method left as a mock/spy is restored to the native implementation, so a
// stub can never be alive while vitest tears the file down. It restores
// console only — spies on other targets keep their existing per-test
// discipline.
import { afterEach, vi } from 'vitest';

const CONSOLE_METHODS = ['log', 'warn', 'error', 'info', 'debug', 'trace'] as const;

afterEach(() => {
  for (const method of CONSOLE_METHODS) {
    const fn = console[method] as unknown;
    if (vi.isMockFunction(fn)) {
      fn.mockRestore();
    }
  }
});
