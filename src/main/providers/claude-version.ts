import { execSync } from 'child_process';
import { getFullPath } from '../pty-manager';

/** The one successful probe per resolved binary path; failures are never stored. */
let cached: { binaryPath: string; version: string } | null = null;

/**
 * Detect the installed Claude Code CLI version by running `<binary> --version`.
 * Returns a semver string (e.g. "2.1.89") or null if detection fails.
 * Successful probes are cached per resolved binary path.
 *
 * P2-53: a FAILED probe is deliberately NOT cached. `claude --version` blows
 * through its 3 s budget routinely under load (a heavy CLI launch competing
 * for CPU), and caching that null pinned the null version for the whole app
 * lifetime: the hook-event gate collapsed to the empty set, so hook
 * installation stripped the user's existing hooks and the settings guard had
 * nothing left to detect (P1-13). A failed probe is a miss — the next caller
 * re-runs it — so one slow launch costs a retry instead of every session in
 * the process.
 *
 * `execSync` blocks the event loop for the whole probe, so two callers can
 * never be inside it at once and there is no in-flight result to share: a
 * caller either reads the cached success or runs its own probe.
 */
export function getClaudeVersion(binaryPath: string): string | null {
  if (cached && cached.binaryPath === binaryPath) return cached.version;

  let version: string | null = null;
  try {
    const out = execSync(`"${binaryPath}" --version`, {
      env: { ...process.env, PATH: getFullPath() },
      encoding: 'utf-8',
      timeout: 3000,
    });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    if (m) version = m[1];
  } catch {
    version = null;
  }

  // Every consumer treats null as "undetectable" (safe empty hook set, no
  // keychain isolation), so a probe that yielded no version is a failure and
  // stays out of the cache.
  if (version) cached = { binaryPath, version };
  return version;
}

/** @internal Test-only: drop the cached probe result. */
export function resetClaudeVersionCache(): void {
  cached = null;
}
