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
 * resolve the candidate spellings and pin the first that exists, mirroring
 * the Windows `pythonBin` binding shape. Exported as `let`: the bundler
 * keeps the live binding, so every hook command template reads the resolved
 * interpreter. */
export let pythonBin = isWin ? 'python' : '/usr/bin/python3';

/**
 * POSIX interpreter spellings, probed in this order: PATH-resolved installs
 * (brew, pyenv, asdf) first, then the distro default, then the few remaining
 * bare-`python` setups. Shared with `checkPythonAvailable()` (prerequisites.ts)
 * so its boot warning walks the same list in the same order.
 */
export const POSIX_PYTHON_CANDIDATES = ['python3', '/usr/bin/python3', 'python'];

// Resolved once at module load (POSIX only; Windows defers to
// checkPythonAvailable()). Row 78: the probe asks the shell where the
// interpreter is (`command -v`, a builtin) instead of running
// `<candidate> --version`. On a mac without the Command Line Tools,
// /usr/bin/python3 is Apple's installer shim and EXECUTING it pops the
// "Install Command Line Developer Tools" dialog — which this module-load probe
// was doing on every boot. `command -v` prints the PATH-resolved path (or the
// argument itself when it is an executable path) and never starts an
// interpreter, so `pythonBin` ends up holding an absolute path.
if (!isWin) {
  for (const candidate of POSIX_PYTHON_CANDIDATES) {
    try {
      const resolved = execSync(`command -v ${candidate}`, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).trim();
      if (!resolved) continue;
      pythonBin = resolved;
      break;
    } catch { /* not on PATH and not an executable path; try the next candidate */ }
  }
}

export function setPythonBin(bin: string): void {
  pythonBin = bin;
}

/**
 * GPU escape hatch (audit row 85). On Mesa/gfx1201 boards the Electron GPU
 * process (ANGLE → Vulkan → RADV) faults on `ring gfx_0.0.0`, and every kernel
 * soft-recovery stalls the whole desktop ~10 s because GNOME shares that ring
 * (f0d9e19e forensics). `FINEVIBE_DISABLE_GPU=1` drops GL for the whole app;
 * Linux-only because that fault path is Mesa-specific — the Windows/macOS
 * runs are unverified against the flag, so they ignore it. `platform` is a
 * parameter so the boot wiring in main.ts stays a one-liner and the decision
 * stays unit-testable; it defaults to the process platform (main.ts must not
 * inline a platform comparison — that is this module's job).
 */
export function shouldDisableHardwareAcceleration(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): boolean {
  return platform === 'linux' && env.FINEVIBE_DISABLE_GPU === '1';
}
