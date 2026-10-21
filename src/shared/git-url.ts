// Git checkout-URL detection for the Add-project "Checkout and create" flow.
// Pure JS (no Node APIs): the renderer detects for the UI, main re-validates
// before spawning `git clone` — a compromised renderer must not aim git at an
// arbitrary host or an option-parsing URL (`--upload-pack`, ext:: transport).

/** Hosts the checkout flow clones from; `www.` variants included. */
const CHECKOUT_HOSTS: Record<string, true> = {
  'github.com': true, 'www.github.com': true, 'codeberg.org': true, 'www.codeberg.org': true,
};

/** Folder-safe last URL segment: starts alphanumeric, then [A-Za-z0-9._-]. */
const SAFE_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface GitCheckoutTarget {
  /** The trimmed URL to hand to `git clone`. */
  url: string;
  /** Last path segment with `.git` stripped — project name and subfolder. */
  repoName: string;
}

/**
 * Detect a GitHub/Codeberg clone URL in a free-text field (the Add-project
 * path field doubles as a URL field). Accepts `https://host/owner/repo[.git][/]`,
 * the scp-style `git@host:owner/repo[.git]` and `ssh://git@host/owner/repo`.
 * Returns null for anything else — local paths, off-allowlist hosts,
 * credential- or port-bearing URLs, and last segments that are not safe
 * folder names (`..`, leading dot) so the derived subfolder stays inside the
 * default projects folder.
 */
export function detectGitCheckoutUrl(value: string): GitCheckoutTarget | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let host: string;
  let pathPart: string;
  const scp = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1].toLowerCase();
    pathPart = `/${scp[2]}`;
  } else if (/^(https?|ssh):\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    // A password, token, or non-`git` user embeds credentials in the clone
    // argv (logs, process lists); `git@` is the ssh transport user, not a
    // secret. A custom port leaves the allowlisted service.
    if (parsed.password || (parsed.username && parsed.username !== 'git') || parsed.port) return null;
    host = parsed.hostname.toLowerCase();
    pathPart = parsed.pathname;
  } else {
    return null;
  }

  if (!(host in CHECKOUT_HOSTS)) return null;

  const segments = pathPart.split('/').filter(s => s.length > 0);
  if (segments.length < 2) return null;
  let repoName = segments[segments.length - 1];
  if (repoName.toLowerCase().endsWith('.git')) repoName = repoName.slice(0, -4);
  if (!SAFE_REPO_NAME.test(repoName)) return null;

  return { url: trimmed, repoName };
}
