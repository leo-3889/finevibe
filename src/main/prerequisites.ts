import { execFile } from 'child_process';
import { promisify } from 'util';
// pi-lens-ignore: find-import-file-without-extension
import { isWin, setPythonBin } from './platform';
const execFileAsync = promisify(execFile);

/**
 * Check whether Python is available on Windows (needed for hook scripts).
 * Returns null if OK or not on Windows, or a warning message if missing.
 * Probes the `python` alias first, then the `py -3` launcher: python.org
 * installs that skipped "Add to PATH" ship only the launcher, and the
 * App-Execution alias exits 9009 with "Python was not found".
 *
 * PA-16: async (execFile + promisify). The execSync form blocked the main
 * thread for up to 2×3 s right after createWindow() — on first paint, every
 * Windows launch. execFile has no shell, so the candidates are argv pairs
 * (`py -3` is launcher + flag, not a command name); windowsHide mirrors
 * execSync's default so the probes never flash a console.
 */
export async function checkPythonAvailable(): Promise<string | null> {
  if (!isWin) return null;
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
