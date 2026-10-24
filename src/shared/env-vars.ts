/**
 * Shared parsing for user-provided environment variables entered as raw
 * `KEY=VALUE` text (one pair per line). Used by the main process to build the
 * PTY environment and by the renderer to validate input before spawning, so
 * both agree on exactly which lines are kept and which are rejected.
 */

/** A non-blank line is valid when it has a `=` with at least one char before it. */
function splitEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx <= 0) return null;
  return { key: trimmed.slice(0, eqIdx).trim(), value: trimmed.slice(eqIdx + 1) };
}

/**
 * Parse raw `KEY=VALUE` text into an env map. The value is taken after the
 * first `=` only (so values may contain `=`); the surrounding line is trimmed,
 * which also strips a stray trailing `\r` from CRLF input. Blank lines and
 * lines without a valid `KEY=` are skipped — parsing never throws so a spawn is
 * never blocked by malformed input (the renderer surfaces those via
 * {@link findInvalidEnvLines}).
 */
export function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!text) return env;
  for (const line of text.split('\n')) {
    const parsed = splitEnvLine(line);
    if (parsed) env[parsed.key] = parsed.value;
  }
  return env;
}

/**
 * Return each non-blank line that is NOT a valid `KEY=VALUE` pair (missing `=`
 * or an empty key), so the UI can reject the input before spawning. Mirrors the
 * skip rule in {@link parseEnvVars} so what is rejected is exactly what would be
 * silently lost.
 */
export function findInvalidEnvLines(text: string): string[] {
  const invalid: string[] = [];
  if (!text) return invalid;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!splitEnvLine(line)) invalid.push(trimmed);
  }
  return invalid;
}

/**
 * Environment variables owned by a provider's profile isolation rather than by
 * the user.
 *
 * `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR` relocate a
 * CLI's entire config tree, `COPILOT_HOME` relocates Copilot's data tree
 * (config and the `session-state` transcripts), `PI_PROFILE` and
 * `OMP_PROFILE` select a native profile (the Pi/OMP resolvers honor them
 * over any relocated dir), and `CLAUDE_IDE_SESSION_ID` and
 * `FINEVIBE_SESSION_ID` key the per-session status files that the hooks and
 * the statusLine write (Claude uses the former, Codex/Copilot/Gemini the
 * latter). Allowing a session's own `envVars` to override any of these
 * would silently point that session at a different login's config, make it
 * write transcripts under a root the transcript readers never scan, or make
 * it write status under another session's key — defeating the pinned
 * profile with no visible signal.
 *
 * `PATH` is deliberately NOT listed: overriding it is a supported use case
 * ("user vars win").
 */
const PROVIDER_OWNED_ENV_KEYS: readonly string[] = [
  'CLAUDE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR',
  'PI_PROFILE',
  'OMP_PROFILE',
  'CLAUDE_IDE_SESSION_ID',
  'FINEVIBE_SESSION_ID',
  'COPILOT_HOME',
];

/**
 * What each owned key controls and where the user should set it instead,
 * keyed by canonical (uppercase) name. Used by the pre-spawn console warning
 * so a dropped variable is actionable rather than just named.
 */
const PROVIDER_OWNED_ENV_REASONS: Readonly<Record<string, string>> = {
  CLAUDE_CONFIG_DIR: 'relocates the Claude config tree — pick a profile instead',
  PI_CODING_AGENT_DIR: 'relocates the Pi config tree — pick a profile instead',
  PI_CONFIG_DIR: 'relocates the Pi config tree — pick a profile instead',
  COPILOT_HOME: 'relocates the Copilot data tree — pick a profile instead',
  PI_PROFILE: 'selects a Pi profile — pick it in the Profile field instead',
  OMP_PROFILE: 'selects an Oh my Pi profile — pick it in the Profile field instead',
  CLAUDE_IDE_SESSION_ID: 'keys the status files the Claude hooks write for this session',
  FINEVIBE_SESSION_ID: 'keys the status files the provider hooks write for this session',
};

/**
 * Reason for a user-typed key (any casing) naming what it controls and where
 * to set it; the canonical entry is matched case-insensitively so the message
 * is useful on POSIX too, where only the exact-case name is the real one.
 */
export function providerOwnedEnvReason(key: string): string {
  return PROVIDER_OWNED_ENV_REASONS[key.toUpperCase()] ?? 'owned by the pinned provider profile';
}

/**
 * Match of env keys against the provider-owned set. Mirrors
 * `findConflictingEnvKeys`: case-folding is Windows-only, because the POSIX
 * child env is case-sensitive, so `claude_config_dir=/x` is inert there and
 * must not be reported as a dropped override (S1-08).
 */
export function findProviderOwnedEnvKeys(
  env: Record<string, string>,
  isWindows: boolean,
): string[] {
  return Object.keys(env).filter((key) =>
    PROVIDER_OWNED_ENV_KEYS.includes(isWindows ? key.toUpperCase() : key),
  );
}

/** Windows environment names are case-insensitive even when object keys are not. */
export function removeEnvKey(env: Record<string, string>, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key];
  }
}

/**
 * Split parsed user env into the part that may be merged over the provider's
 * environment and the provider-owned keys that must not be, so the caller can
 * report what was dropped instead of losing it silently. `isWindows` follows
 * `findConflictingEnvKeys`: env names are case-insensitive on Windows, so
 * every casing variant is dropped there; on POSIX only the exact-case name
 * reaches the child, and an inert lowercase variant is left alone.
 */
export function partitionUserEnv(
  env: Record<string, string>,
  isWindows: boolean,
): { allowed: Record<string, string>; dropped: string[] } {
  const dropped = findProviderOwnedEnvKeys(env, isWindows);
  const droppedKeys = new Set(dropped);
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!droppedKeys.has(key)) allowed[key] = value;
  }
  return { allowed, dropped };
}
