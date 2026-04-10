import { execSync } from 'child_process';
import { getFullPath } from '../pty-manager';

let cached: { binaryPath: string; version: string | null } | null = null;

/**
 * Detect the installed Claude Code CLI version by running `<binary> --version`.
 * Returns a semver string (e.g. "2.1.89") or null if detection fails.
 * Cached per resolved binary path.
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

  cached = { binaryPath, version };
  return version;
}
