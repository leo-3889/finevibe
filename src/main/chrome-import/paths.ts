import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isMac, isWin } from '../platform';

/** Returns the Chrome user-data directory for the current OS, or null if absent. */
export function chromeUserDataDir(): string | null {
  const home = os.homedir();
  let candidate: string;
  if (isMac) {
    candidate = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (isWin) {
    const localAppData = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    candidate = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  } else {
    candidate = path.join(home, '.config', 'google-chrome');
  }
  return fs.existsSync(candidate) ? candidate : null;
}

/** Returns the path to a specific profile inside the user-data dir. */
export function chromeProfileDir(userDataDir: string, profileId: string): string {
  return path.join(userDataDir, profileId);
}

/** Returns the path to the Local State JSON file. */
export function localStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'Local State');
}
