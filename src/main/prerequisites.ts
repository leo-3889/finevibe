import { execFile } from 'child_process';
import { promisify } from 'util';
// pi-lens-ignore: find-import-file-without-extension
import { isWin, isMac, setPythonBin, POSIX_PYTHON_CANDIDATES, APPLE_CLT_SHIM_PATH } from './platform';
const execFileAsync = promisify(execFile);

/**
 * True when a toolchain is selected (`xcode-select -p` prints its root). The
 * CLT-shim gate of {@link checkPythonAvailable}; runs `sh`, never python.
 * UNVERIFIED-RUNTIME: CI has no CLT-less mac, so the non-zero exit this relies
 * on there is Apple's documented behavior, not an observed one — the tests
 * below mock it.
 */
async function commandLineToolsInstalled(): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', 'xcode-select -p >/dev/null 2>&1'], {
      timeout: 3000, windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether Python is available (needed for hook scripts) on every
 * platform. Returns null if OK, or a warning message if nothing answers —
 * the caller (main.ts) surfaces it as a non-fatal dialog; hook-install
 * fail-closed rules (P1-13/P2-53) are untouched.
 *
 * Windows: probes the `python` alias first, then the `py -3` launcher:
 * python.org installs that skipped "Add to PATH" ship only the launcher,
 * and the App-Execution alias exits 9009 with "Python was not found".
 *
 * POSIX: resolves the same candidates as platform.ts's module-load probe
 * (P2-23) in the same order. That probe pins `pythonBin` at import time but
 * keeps its failure to itself — on a box without python3 the hook commands
 * baked a dead `/usr/bin/python3` and every capture (cost, status, events,
 * titles) died silently. This async probe is what turns "no interpreter"
 * into the same visible warning Windows already shows.
 *
 * Row 78: the POSIX probe RESOLVES (`sh -c 'command -v <candidate>'`) instead
 * of executing `<candidate> --version`. `/usr/bin/python3` on a mac without the
 * Command Line Tools is Apple's installer shim, and running it pops the
 * "Install Command Line Developer Tools" dialog — this probe runs during boot,
 * so that modal appeared on every launch of the IDE. `command -v` is an sh
 * builtin (no interpreter starts) and prints the resolved absolute path, which
 * is the better thing to hand `setPythonBin` anyway.
 *
 * Row 78 follow-up: resolving the shim is not having a python3. On a CLT-less
 * mac `command -v` answers `/usr/bin/python3` for BOTH spellings, so the probe
 * went quiet while every hook died in the modal the warning was supposed to
 * prevent. Both darwin probes therefore gate that exact path behind
 * `xcode-select -p` (sh again — zero python executed); a refused shim keeps the
 * walk going and the warning reachable.
 *
 * PA-16: async (execFile + promisify). The execSync form blocked the main
 * thread for up to 2×3 s right after createWindow() — on first paint, every
 * Windows launch. execFile has no shell, so the Windows candidates are argv
 * pairs (`py -3` is launcher + flag, not a command name) and the POSIX locator
 * names `sh` explicitly; windowsHide mirrors execSync's default so the probes
 * never flash a console.
 */
export async function checkPythonAvailable(): Promise<string | null> {
  if (!isWin) {
    for (const candidate of POSIX_PYTHON_CANDIDATES) {
      try {
        const { stdout } = await execFileAsync('sh', ['-c', `command -v ${candidate}`], {
          encoding: 'utf-8', timeout: 3000, windowsHide: true,
        });
        const resolved = stdout.trim();
        if (!resolved) continue;
        if (isMac && resolved === APPLE_CLT_SHIM_PATH && !(await commandLineToolsInstalled())) continue;
        setPythonBin(resolved);
        return null;
      } catch { /* not on PATH and not an executable path; try the next candidate */ }
    }
    return (
      'Python not found.\n\n' +
      'FineVibe uses Python (python3) for session tracking (cost, status, events).\n' +
      'These features will not work until Python is installed and available on PATH.\n\n' +
      'Install it with your package manager, e.g.:\n' +
      '  Debian/Ubuntu: sudo apt install python3\n' +
      '  Fedora:        sudo dnf install python3\n' +
      '  macOS:         brew install python3\n'
    );
  }

  const candidates = [
    ['python', ['--version'], 'python'],
    ['py', ['-3', '--version'], 'py -3'],
  ] as const;
  for (const [cmd, args, bin] of candidates) {
    try {
      await execFileAsync(cmd, args, { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      setPythonBin(bin);
      return null;
    } catch { /* this interpreter is missing; try the next candidate */ }
  }
  return (
    'Python not found.\n\n' +
    'FineVibe uses Python on Windows for session tracking (cost, status, events).\n' +
    'These features will not work until Python is installed and available on PATH.\n\n' +
    'Install Python from https://www.python.org/downloads/ or via:\n' +
    '  winget install Python.Python.3\n'
  );
}
