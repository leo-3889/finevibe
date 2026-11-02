/**
 * macOS keychain credential-isolation guardrail for Claude profiles.
 *
 * Background: FineVibe "profiles" give each Claude Code session an isolated
 * `CLAUDE_CONFIG_DIR` so separate logins/licenses don't collide. On Linux and
 * Windows that isolation is automatic — credentials live in
 * `<configDir>/.credentials.json`. On macOS, Claude Code stores OAuth
 * credentials in the system Keychain instead, and ONLY recent versions
 * namespace the Keychain entry per config dir. Older builds (see
 * anthropics/claude-code#20553, reproduced on 2.1.19) reuse a single
 * `Claude Code-credentials` entry for every config dir, so logging into one
 * profile silently overwrites every other profile's token — the accounts bleed
 * into each other. That is a correctness and compliance problem, so we detect
 * it and block profile use on affected macOS installs.
 *
 * Detection is empirical first: a build that namespaces leaves a
 * `Claude Code-credentials-<hash>` entry in the Keychain, where `<hash>` is the
 * first 8 hex chars of sha256(configDir). If any such entry exists for a known
 * profile, the build supports isolation. When no namespaced entry exists yet
 * (e.g. no profile has been logged into), we fall back to the CLI version: only
 * versions at or below the last known un-namespaced release are declared
 * unsupported, so a newer-but-unconfirmed build is treated as `unknown` and is
 * never falsely blocked.
 */
import { createHash } from 'crypto';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { isMac } from './platform';
import { loadState } from './store';
import { getClaudeVersion, getClaudeVersionAsync } from './providers/claude-version';
import { resolveBinary, resolveBinaryAsync } from './providers/resolve-binary';
import { semverGte } from './claude-hook-versions';

const execFileP = promisify(execFile);

/** Keychain service prefix Claude Code uses for OAuth credentials on macOS. */
const BASE_SERVICE = 'Claude Code-credentials';

/**
 * Last Claude Code version known to share ONE keychain entry across all config
 * dirs (no per-config-dir namespacing). Builds at or below this are declared
 * unsupported when no namespaced keychain entry is observed. Reproduced on
 * macOS in anthropics/claude-code#20553 (reported on 2.1.19); the public
 * changelog never documents when namespacing shipped, so we keep this
 * conservative — only clearly-old builds are blocked, never newer unconfirmed
 * ones (those resolve to `unknown`).
 */
export const LAST_UNNAMESPACED_VERSION = '2.1.19';

type KeychainIsolationStatus = 'supported' | 'unsupported' | 'unknown';

interface KeychainStatusResult {
  /** Whether per-profile login isolation is in effect on this platform/build. */
  status: KeychainIsolationStatus;
  /** Detected Claude CLI version, or null if undetectable. */
  version: string | null;
}

/**
 * macOS Keychain service name Claude Code derives for a given config dir:
 * `Claude Code-credentials-<first 8 hex of sha256(configDir)>`. The config dir
 * is hashed verbatim (as passed via `CLAUDE_CONFIG_DIR`, no trailing slash).
 */
export function keychainServiceForConfigDir(configDir: string): string {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${BASE_SERVICE}-${hash}`;
}

/** True if a generic-password keychain item with this service name exists. */
function keychainEntryExists(service: string): boolean {
  try {
    // Metadata lookup only — never prompts to unlock (that needs `-w`/`-g`).
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', service], {
      stdio: 'ignore',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Async twin of {@link keychainEntryExists} (row 17 spawn lane). */
async function keychainEntryExistsAsync(service: string): Promise<boolean> {
  try {
    // ponytail (review 8dddea9a ℹ️8): the sync twin's stdio:'ignore' is
    // inexpressible in execFile's async typing (it always pipes into
    // maxBuffer=1 MB). `find-generic-password` without -g prints attribute
    // metadata only (kilobytes); ceiling is far above the real output.
    await execFileP('/usr/bin/security', ['find-generic-password', '-s', service], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** The known Claude profiles, or [] when the store is unreadable. */
function profileConfigDirs(): string[] {
  let profiles: { providerId: string; configDir: string }[] = [];
  try {
    profiles = loadState().profiles ?? [];
  } catch {
    return [];
  }
  return profiles
    .filter((p) => p.providerId === 'claude' && p.configDir)
    .map((p) => p.configDir);
}

/**
 * Empirically confirm the installed build namespaces credentials: probe the
 * keychain for the namespaced entry of every known Claude profile. A single hit
 * proves the build supports per-config-dir isolation.
 */
function anyProfileKeychainNamespaced(): boolean {
  for (const configDir of profileConfigDirs()) {
    if (keychainEntryExists(keychainServiceForConfigDir(configDir))) return true;
  }
  return false;
}

/** Async twin of {@link anyProfileKeychainNamespaced} (row 17 spawn lane):
 *  one `security` spawn per Claude profile, in the same short-circuit order. */
async function anyProfileKeychainNamespacedAsync(): Promise<boolean> {
  for (const configDir of profileConfigDirs()) {
    if (await keychainEntryExistsAsync(keychainServiceForConfigDir(configDir))) return true;
  }
  return false;
}

/**
 * Determine whether Claude profile login isolation works on this machine.
 *
 * - Non-macOS: always `supported` (isolation is file-based and version-agnostic).
 * - macOS: `supported` if any profile already has a namespaced keychain entry;
 *   else `unsupported` if the detected CLI version predates namespacing; else
 *   `unknown` (newer build, not yet confirmed — allowed, not blocked).
 */
// Persistent binary-path cache so repeated status checks don't re-walk PATH.
const binaryCache = { path: null as string | null };

// Process-lifetime memo. A definitive 'supported'/'unsupported' verdict cannot
// change at runtime (the CLI version is fixed for the process), so it is cached
// to keep the spawn hot path off the `security`/`--version` subprocesses. An
// 'unknown' verdict can still upgrade to 'supported' once the user logs into a
// profile (a namespaced keychain entry appears), so it is left uncached.
let cachedVerdict: KeychainStatusResult | null = null;

function computeStatus(): KeychainStatusResult {
  if (!isMac) {
    return { status: 'supported', version: null };
  }

  let version: string | null = null;
  try {
    version = getClaudeVersion(resolveBinary('claude', binaryCache));
  } catch {
    version = null;
  }

  if (anyProfileKeychainNamespaced()) {
    return { status: 'supported', version };
  }
  // semverGte(LAST, version) === (version <= LAST): builds at or below the last
  // un-namespaced release share one keychain login and can't isolate profiles.
  if (version && semverGte(LAST_UNNAMESPACED_VERSION, version)) {
    return { status: 'unsupported', version };
  }
  return { status: 'unknown', version };
}

export function getKeychainIsolationStatus(): KeychainStatusResult {
  if (cachedVerdict && cachedVerdict.status !== 'unknown') return cachedVerdict;
  cachedVerdict = computeStatus();
  return cachedVerdict;
}

/**
 * Row 17: async twin of {@link getKeychainIsolationStatus} for the PTY spawn
 * lane, where it gates every Claude profile session. The sync verdict runs
 * `resolveBinary` (`which`, 3 s cap), `claude --version` (`execSync`, 3 s) and
 * one `security find-generic-password` per Claude profile — and an `unknown`
 * verdict is deliberately NOT memoized (it can upgrade to `supported`), so a
 * macOS box in that state paid the whole probe chain synchronously on EVERY
 * profile launch. Same memo, same verdict rules; only the I/O moved.
 */
export async function getKeychainIsolationStatusAsync(): Promise<KeychainStatusResult> {
  if (cachedVerdict && cachedVerdict.status !== 'unknown') return cachedVerdict;
  if (!isMac) {
    cachedVerdict = { status: 'supported', version: null };
    return cachedVerdict;
  }
  let version: string | null = null;
  try {
    version = await getClaudeVersionAsync(await resolveBinaryAsync('claude', binaryCache));
  } catch {
    version = null;
  }
  if (await anyProfileKeychainNamespacedAsync()) {
    cachedVerdict = { status: 'supported', version };
    return cachedVerdict;
  }
  if (version && semverGte(LAST_UNNAMESPACED_VERSION, version)) {
    cachedVerdict = { status: 'unsupported', version };
    return cachedVerdict;
  }
  // 'unknown' stays uncached, exactly as the sync lane leaves it.
  return { status: 'unknown', version };
}

/** @internal Test-only: clear the memoized verdict and binary-path cache. */
export function _resetForTesting(): void {
  cachedVerdict = null;
  binaryCache.path = null;
}
