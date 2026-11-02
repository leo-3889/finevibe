import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getFullPath, getFullPathAsync } from '../pty-manager';

const execFileP = promisify(execFile);

/** The one successful probe per resolved binary path; failures are never stored. */
let cached: { binaryPath: string; version: string } | null = null;

/** In-flight async probe, shared so concurrent spawns don't fan out `--version`. */
let pending: { binaryPath: string; promise: Promise<string | null> } | null = null;

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

/**
 * Row 17: async twin of {@link getClaudeVersion} for the spawn lane. The sync
 * probe is a 3 s `execSync` of the CLI (plus the sync PATH probe it needs),
 * reached from `getKeychainIsolationStatus()` on every Claude profile spawn
 * whose verdict is still `unknown` — a multi-hundred-ms main-thread block
 * between the launch request and the PTY.
 *
 * Same cache and the same P2-53 rule (a failed probe is a miss, never stored);
 * concurrent callers share one in-flight probe (the sync lane could not have
 * two). `execFile` is shell-free: same binary, same single `--version` arg.
 */
export function getClaudeVersionAsync(binaryPath: string): Promise<string | null> {
  if (cached && cached.binaryPath === binaryPath) return Promise.resolve(cached.version);
  if (pending && pending.binaryPath === binaryPath) return pending.promise;
  const probe = (async (): Promise<string | null> => {
    let version: string | null = null;
    try {
      const { stdout } = await execFileP(binaryPath, ['--version'], {
        env: { ...process.env, PATH: await getFullPathAsync() },
        encoding: 'utf-8',
        timeout: 3000,
      });
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      if (m) version = m[1];
    } catch {
      version = null;
    }
    if (version) cached = { binaryPath, version };
    return version;
  })().finally(() => {
    // Path-guarded: a probe for another binary that finished in between owns
    // the slot and must keep its in-flight sharing.
    if (pending?.binaryPath === binaryPath) pending = null;
  });
  pending = { binaryPath, promise: probe };
  return probe;
}

/** @internal Test-only: drop the cached probe result (and any in-flight probe). */
export function resetClaudeVersionCache(): void {
  cached = null;
  pending = null;
}
