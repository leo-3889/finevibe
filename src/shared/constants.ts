/** GitHub REST/Search API ceiling for `per_page`. Shared by main-process callers and the widget settings UI. */
export const GITHUB_MAX_PER_PAGE = 100;

/** Glob patterns for files to exclude from large-file scanning (readiness checks). */
export const DEFAULT_SCAN_IGNORE = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Gemfile.lock',
  'Cargo.lock',
  'composer.lock',
  'poetry.lock',
  'go.sum',
  'Pipfile.lock',
  'uv.lock',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',
  '*.generated.*',
];

/** Directories to exclude from large-file alerts (never worth splitting). */
export const EXCLUDED_DIRECTORIES = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
];

/** Extra glob patterns to exclude from large-file alerts (beyond DEFAULT_SCAN_IGNORE). */
export const EXTRA_ALERT_IGNORE = [
  '*.map',
  '*.wasm',
  '*.pb',
  '*.bundle.*',
];

/**
 * The key Claude Code sets on `tool_response.file` when a `Read` came back
 * truncated at the token cap. As of 2.1.238 such a read *succeeds* rather than
 * failing, so this flag is the only signal — the old
 * `exceeds maximum allowed tokens` error text no longer exists.
 *
 * This name is owned by Claude Code. Do not rename it to something friendlier;
 * it must match the payload exactly.
 */
export const TOKEN_TRUNCATION_KEY = 'truncatedByTokenCap';

/**
 * Prefix Vibeyard writes on the synthetic `.toolfailure` record it derives from
 * that flag, and which `large-file-detector.ts` matches on. Owned by us, so it
 * is safe to reword — kept separate from TOKEN_TRUNCATION_KEY precisely so a
 * reword cannot silently break the payload lookup.
 */
export const TOKEN_TRUNCATION_SENTINEL = 'read-truncated-by-token-cap';

/**
 * How long an in-flight-work signal is trusted before a session is completed
 * anyway, in ms.
 *
 * Used on both sides of the same guarantee, which is why it lives here: the
 * hook-side Stop writer ages out a stale `<sid>.subagents` counter with it
 * (STOP_STALE_MS), and the renderer arms a backstop with it whenever a Stop
 * resolves to 'working' (STOP_FALLBACK_MS). They must not drift.
 */
export const STOP_INFLIGHT_TRUST_MS = 600000;

/**
 * `pty:exit` exitReason sentinel for a session whose launch was REJECTED
 * before a PTY ever existed (unsupported launch flags/env, Claude profile
 * keychain isolation unavailable). `spawnPty` writes the actionable reason
 * into the pane with `pty:data` and then fires its exit callback, so the
 * renderer receives a message and an exit in the same turn: destroying the
 * terminal there makes the "remove these options" text unreadable, and
 * archiving the row renders a crash badge plus a desktop crash notification
 * for a process that never ran.
 *
 * Producer: `spawnPty` (src/main/pty-manager.ts), forwarded verbatim by the
 * `pty:create` exit callback. Consumer: the renderer's `pty:exit` handler,
 * which keeps the pane (no destroy, no crash archive, no crash notification)
 * when `isSpawnRejectedExitReason()` is true.
 */
export const SPAWN_REJECTED_EXIT_REASON = 'spawn-rejected';

/** True when a `pty:exit` reason marks a pre-spawn rejection, not a process exit. */
export function isSpawnRejectedExitReason(exitReason?: string): boolean {
  return exitReason === SPAWN_REJECTED_EXIT_REASON;
}
