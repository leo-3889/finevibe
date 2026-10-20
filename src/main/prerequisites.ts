import { execSync } from 'child_process';
// pi-lens-ignore: find-import-file-without-extension
import { isWin, setPythonBin } from './platform';

/**
 * Check whether Python is available on Windows (needed for hook scripts).
 * Returns null if OK or not on Windows, or a warning message if missing.
 * Probes the `python` alias first, then the `py -3` launcher: python.org
 * installs that skipped "Add to PATH" ship only the launcher, and the
 * App-Execution alias exits 9009 with "Python was not found".
 */
export function checkPythonAvailable(): string | null {
  if (!isWin) return null;
  const candidates = [['python --version', 'python'], ['py -3 --version', 'py -3']] as const;
  for (const [cmd, bin] of candidates) {
    try {
      execSync(cmd, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' });
      setPythonBin(bin);
      return null;
    } catch { /* this interpreter is missing; try the next candidate */ }
  }
  return (
    'Python not found.\n\n' +
    'Vibeyard uses Python on Windows for session tracking (cost, status, events).\n' +
    'These features will not work until Python is installed and available on PATH.\n\n' +
    'Install Python from https://www.python.org/downloads/ or via:\n' +
    '  winget install Python.Python.3\n'
  );
}
