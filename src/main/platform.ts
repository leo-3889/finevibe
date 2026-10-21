/**
 * Centralized platform detection and derived constants for the main process.
 *
 * Import `isWin`/`isMac`/`isLinux` from here instead of inlining
 * `process.platform === 'win32'` or redefining `isWin` locally. This keeps
 * platform-conditional logic discoverable and prevents drift across modules.
 */

import { execSync } from 'child_process';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/** PATH environment variable separator. */
export const pathSep = isWin ? ';' : ':';

/** Command used to resolve a binary on PATH. */
export const whichCmd = isWin ? 'where' : 'which';

/**
 * Locale vars that force a UTF-8 charset on spawned children. `LC_CTYPE=UTF-8`
 * is what Terminal.app sets when it can't map the region; `C.UTF-8` is always
 * present on glibc >= 2.27 and musl. Empty on Windows, which is not locale-env
 * driven.
 */
export const utf8LocaleEnv: Record<string, string> =
  isWin ? {} : isMac ? { LC_CTYPE: 'UTF-8' } : { LANG: 'C.UTF-8' };

/** Python interpreter used by hook scripts. On Windows this starts as the
 * bare `python` alias and is re-pointed by checkPythonAvailable() when only
 * the `py` launcher exists (python.org installs without PATH).
 *
 * P2-23: the same re-point exists on POSIX. `/usr/bin/python3` is NOT a
 * universal path — Homebrew, pyenv, conda, distro-python and user-local
 * installs put the interpreter elsewhere, and hooks then die silently in
 * exactly the installs the Windows re-point was built for. At module load we
 * probe the candidate spellings and pin the first that answers, mirroring
 * the Windows `pythonBin` binding shape. Exported as `let`: the bundler
 * keeps the live binding, so every hook command template reads the resolved
 * interpreter. */
export let pythonBin = isWin ? 'python' : '/usr/bin/python3';

// Probed once at module load (POSIX only; Windows defers to
// checkPythonAvailable()). `python3` first: PATH-resolved installs (brew,
// pyenv, asdf) are the common case on macOS/Linux; the absolute path is the
// distro default; bare `python` covers the few remaining POSIX setups.
if (!isWin) {
  for (const candidate of ['python3', '/usr/bin/python3', 'python']) {
    try {
      execSync(`${candidate} --version`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
      pythonBin = candidate;
      break;
    } catch { /* this interpreter is missing; try the next candidate */ }
  }
}

export function setPythonBin(bin: string): void {
  pythonBin = bin;
}
