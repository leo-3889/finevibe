import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Cap forks workers. The default pool spawns cores-1 workers, and on this
    // Windows host 7 of 173 workers timed out *at startup* (2026-10-18): those
    // files never ran, yet the run reported 166 passed. The cap is the fix;
    // raising testTimeout alone just hides the same startup timeout longer.
    // Vitest 4 removed `poolOptions`: nesting `maxWorkers` there is silently
    // ignored (it only prints a DEPRECATED warning), so the cap must be
    // top-level to have any effect.
    pool: 'forks',
    maxWorkers: 4,
    // 174 files run in parallel; the heaviest legitimate suites (jsdom
    // file-reader with 200k lines, sidebar module import) take 2-3s alone and
    // cross vitest's 5s default on a loaded Windows machine — they flip red
    // under contention without any regression. 15s keeps real hangs failing.
    testTimeout: 15_000,
    environment: 'node',
    // `.flake-tmp/` is a local snapshot scaffold (untracked, undeletable on
    // this host). Its copies of `src/**` are real `.test.ts` files: left in
    // discovery they double every path-filtered run's counts and re-report
    // stale sources as failures.
    exclude: ['**/node_modules/**', '**/.flake-tmp/**', '**/dist/**'],
    // P1-6: afterEach backstop restoring any leaked console spy before the
    // file tears down (see test/console-guard.ts).
    setupFiles: [fileURLToPath(new URL('./test/console-guard.ts', import.meta.url))],
    alias: {
      // CI installs with ELECTRON_SKIP_BINARY_DOWNLOAD=1, so importing the real
      // `electron` module throws ("Electron failed to install correctly").
      // Redirect it to a test stub for suites that transitively load a module
      // which value-imports from 'electron' (e.g. hook-status.ts).
      electron: fileURLToPath(new URL('./test/electron-stub.ts', import.meta.url)),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'src/main/**/*.ts',
        'src/preload/**/*.ts',
        // P2-12: the renderer component tree is the highest-risk unmeasured
        // surface (board/pane/modal state); widen the map even where tests
        // are thin — the report is expected to be noisy.
        'src/renderer/components/**',
      ],
      exclude: [
        'src/main/mcp-ipc-handlers.ts',
        'src/main/menu.ts',
        'src/main/mcp-client.ts',
        'src/renderer/index.ts',
        'src/renderer/keybindings.ts',
        'src/renderer/notification-sound.ts',
        'src/renderer/git-status.ts',
      ],
    },
  },
});
