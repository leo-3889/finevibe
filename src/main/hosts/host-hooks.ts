// On-host FineVibe hook block (per-host providers plan §3, enrollment 5.5).
//
// The host's provider settings.json gets FineVibe's status-writer hooks,
// marker-scoped the way authorized_keys is: every handler we own carries the
// `# finevibe-hook` marker in its command, so merge is strip-marked + append
// (idempotent) and unenroll removes exactly our block — never a foreign hook,
// never a foreign settings key.
//
// The block is POSIX sh writing the `~/.finevibe/run` sidecar on the HOST
// (same `<event>:<status>` payload as hook-commands.ts statusCmd, same
// tmp+mv atomicity), so no interpreter needs to exist on the host beyond sh.
//
// Pure string→string functions live here (table-tested); the I/O loop that
// applies them over the file plane lives in enrollment.ts.

import type { ProviderId } from '../../shared/types';

/** Marker carried in every FineVibe-owned hook command (claude-cli idiom). */
export const HOST_HOOK_MARKER = '# finevibe-hook';

/** One hook handler we install: an event name + the command to run. */
export interface HostHookEntry {
  event: string;
  command: string;
}

/** The host status sidecar dir (created at enrollment; hooks mkdir-guard). */
export const HOST_STATUS_DIR = '~/.finevibe/run';

/** Provider → host settings file, home-relative. pi and pi-bolt share one tree. */
export const HOST_SETTINGS_PATH: Partial<Record<ProviderId, string>> = {
  claude: '~/.claude/settings.json',
  pi: '~/.pi/agent/settings.json',
  'pi-bolt': '~/.pi/agent/settings.json',
  omp: '~/.omp/agent/settings.json',
};

/** The env var carrying the FineVibe session id into hooks, per provider. */
const SESSION_ID_VAR: Partial<Record<ProviderId, string>> = {
  claude: 'CLAUDE_IDE_SESSION_ID',
  codex: 'FINEVIBE_SESSION_ID',
  copilot: 'FINEVIBE_SESSION_ID',
  gemini: 'FINEVIBE_SESSION_ID',
  pi: 'FINEVIBE_SESSION_ID',
  'pi-bolt': 'FINEVIBE_SESSION_ID',
  omp: 'FINEVIBE_SESSION_ID',
};

/**
 * The events a remote session writes. The four every Claude-compatible hook
 * schema understands (no per-version capability probe runs on the host —
 * ponytail: an unsupported event is inert in the CLI's dispatcher, an
 * unsupported schema is not, and all four hosts speak it).
 */
const HOST_EVENTS: Record<string, string> = {
  UserPromptSubmit: 'working',
  PostToolUse: 'working',
  Stop: 'completed',
  PermissionRequest: 'input',
};

/**
 * One host-side status-writer command. Mirrors hook-commands.ts statusCmd
 * (POSIX branch): `mkdir -p` guard, echo `<event>:<status>` into a tmp file,
 * `mv` into place (atomic rename beats truncate-then-write on coarse-mtime
 * filesystems), session id read from the provider's env var at hook runtime,
 * trailing marker identifies the block. Paths are `$HOME`-relative so the
 * command survives any host user.
 */
export function hostStatusCmd(event: string, status: string, sessionIdVar: string): string {
  const dir = HOST_STATUS_DIR.replace('~', '$HOME');
  const inner =
    `mkdir -p "${dir}" && echo "${event}:${status}" > ` +
    `"${dir}/$${sessionIdVar}.status.tmp" && mv "${dir}/$${sessionIdVar}.status.tmp" ` +
    `"${dir}/$${sessionIdVar}.status" ${HOST_HOOK_MARKER}`;
  return `sh -c '${inner.replace(/'/g, `'\\''`)}'`;
}

/** The hook block for one provider: {event, command} per status event. */
export function hostHookEntries(providerId: ProviderId): HostHookEntry[] {
  const sessionIdVar = SESSION_ID_VAR[providerId] ?? 'FINEVIBE_SESSION_ID';
  return Object.entries(HOST_EVENTS).map(([event, status]) => ({
    event,
    command: hostStatusCmd(event, status, sessionIdVar),
  }));
}

/** A hook handler handler-shape minimal view: anything Claude-compatible nests. */
interface HookHandlerLike {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}
interface HookMatcherLike {
  matcher?: unknown;
  hooks?: HookHandlerLike[];
  [key: string]: unknown;
}
type HooksConfig = Record<string, HookMatcherLike[]>;

function isFineVibeHandler(h: HookHandlerLike): boolean {
  return typeof h.command === 'string' && h.command.includes(HOST_HOOK_MARKER);
}

/** Strip every FineVibe-marked handler; drop emptied matchers/events. */
function stripMarked(hooks: HooksConfig): HooksConfig {
  const out: HooksConfig = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) {
      out[event] = matchers;
      continue;
    }
    const keptMatchers = matchers
      .map((m) => (Array.isArray(m.hooks) ? { ...m, hooks: m.hooks.filter((h) => !isFineVibeHandler(h)) } : m))
      .filter((m) => !Array.isArray(m.hooks) || m.hooks.length > 0);
    if (keptMatchers.length > 0) out[event] = keptMatchers;
  }
  return out;
}

/** Parse a settings payload for rewrite; a missing file reads as `{}`; throw = corrupt. */
export function parseSettingsForRewrite(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('settings.json is not valid JSON; refusing to overwrite a corrupt config', { cause: err });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object; refusing to overwrite it');
  }
  const settings = parsed as Record<string, unknown>;
  // Shape gate (audit T2 #8): corrupt JSON is refused; a corrupt hooks SHAPE
  // must be too — `hooks: "x"` would Object.entries into char keys, and a
  // non-array event value would be silently replaced by our matcher array.
  const hooks = settings.hooks;
  if (hooks !== undefined) {
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
      throw new Error('settings.json hooks is not an object; refusing to overwrite it');
    }
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) {
        throw new Error(`settings.json hooks.${event} is not an array; refusing to overwrite it`);
      }
    }
  }
  return settings;
}

/**
 * Merge `entries` into settings text (null = the file does not exist).
 * Idempotent: any previously-installed FineVibe block is stripped first, so
 * re-running the merge is a no-op on content. Foreign hooks and every foreign
 * settings key survive verbatim. Returns `changed: false` (and the ORIGINAL
 * text) when the file already carries exactly this block — the caller skips
 * the write, keeping mtime stable for anything watching the file.
 * Throws on corrupt JSON (the file is left untouched).
 */
export function mergeHookBlock(existing: string | null, entries: HostHookEntry[]): { json: string; changed: boolean } {
  const settings = parseSettingsForRewrite(existing);
  const hooks = stripMarked((settings.hooks ?? {}) as HooksConfig);
  for (const { event, command } of entries) {
    const matchers = Array.isArray(hooks[event]) ? hooks[event] : [];
    matchers.push({ matcher: '', hooks: [{ type: 'command', command }] });
    hooks[event] = matchers;
  }
  settings.hooks = hooks;
  const json = JSON.stringify(settings, null, 2) + '\n';
  // Canonical comparison against the original: a file that already carries
  // exactly this block (possibly formatted differently) is "changed" only if
  // its parsed content differs, so a stable install writes once, never per
  // enrollment retry.
  const changed = existing === null || !sameContent(existing, json);
  return { json, changed };
}

/**
 * Remove exactly the FineVibe block. Returns `changed: false` when nothing
 * was marked (the caller skips the write); throws on corrupt JSON.
 */
export function stripHookBlock(existing: string): { json: string; changed: boolean } {
  const settings = parseSettingsForRewrite(existing);
  const hooks = (settings.hooks ?? {}) as HooksConfig;
  const stripped = stripMarked(hooks);
  const hadMarked = countHandlers(hooks) !== countHandlers(stripped);
  if (!hadMarked) return { json: existing, changed: false };
  if (Object.keys(stripped).length === 0) delete settings.hooks;
  else settings.hooks = stripped;
  return { json: JSON.stringify(settings, null, 2) + '\n', changed: true };
}

function countHandlers(hooks: HooksConfig): number {
  let n = 0;
  for (const matchers of Object.values(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) if (Array.isArray(m.hooks)) n += m.hooks.length;
  }
  return n;
}

/** Deep-equal of two JSON payloads (formatting-insensitive). */
function sameContent(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
}
