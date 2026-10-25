// SSH host parsing for the per-session `ssh <host>` launch wrap.
// Pure JS (no Node APIs): the renderer validates for the UI, main re-validates
// before putting the value into `ssh` argv — a compromised value must not aim
// ssh at an option string (`-oProxyCommand=…`).
//
// Accepted forms: `host`, `user@host`. Rejected: whitespace, ports (`:22` —
// the port belongs to `ssh -p`, the prefix shows the host), `ssh://` URLs,
// leading `-` (option injection), characters outside the hostname/username
// grammars, length > 253.

export interface SshHostRef {
  /** Normalized `user@host` when a user is given, else `host`. */
  host: string;
  user?: string;
}

const MAX_HOST_LENGTH = 253;

/** RFC-1123-style hostname: labels alphanumeric with inner hyphens. */
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** POSIX-ish user names; rejects anything that could smuggle argv/quoting. */
const USERNAME = /^[A-Za-z0-9._-]+$/;

const PORT_SUFFIX = /:\d+$/;

/**
 * Parse a free-text SSH host (context-menu field, pty:create arg, detected
 * echo). Returns the normalized reference or null — never throws.
 */
export function parseSshHost(raw: string): SshHostRef | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.length > MAX_HOST_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  if (PORT_SUFFIX.test(trimmed)) return null;

  const at = trimmed.lastIndexOf('@');
  if (at === 0) return null; // `@host` has an empty user
  let user: string | undefined;
  let host: string;
  if (at > 0) {
    user = trimmed.slice(0, at);
    host = trimmed.slice(at + 1);
    if (!USERNAME.test(user)) return null;
  } else {
    host = trimmed;
  }
  if (!HOSTNAME.test(host)) return null;

  return user ? { host: `${user}@${host}`, user } : { host };
}
