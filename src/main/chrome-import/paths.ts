import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isMac, isWin } from '../platform';
import { canonicalPath, canonicalRoot } from '../fs-utils';

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
    // P2-50: Linux packaging puts the user-data dir in several places —
    // distro Chrome (stable/beta/unstable), Debian's chromium, the
    // snap-confined chromium, and the Flatpak sandboxes. A chromium-only
    // machine used to report "Chrome not found". First existing candidate
    // wins; stable Chrome outranks Chromium so a Chrome install is
    // preferred when both exist.
    const candidates = [
      path.join(home, '.config', 'google-chrome'),
      path.join(home, '.config', 'google-chrome-beta'),
      path.join(home, '.config', 'google-chrome-unstable'),
      path.join(home, '.config', 'chromium'),
      path.join(home, 'snap', 'chromium', 'common', 'chromium'),
      path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome'),
      path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'),
    ];
    candidate = candidates.find((root) => fs.existsSync(root)) ?? candidates[0]!;
  }
  return fs.existsSync(candidate) ? candidate : null;
}

/** Returns the path to a specific profile inside the user-data dir. */
export function chromeProfileDir(userDataDir: string, profileId: string): string {
  // profileId is renderer-supplied import options: it must stay inside the
  // Chrome user-data dir (Chrome's own ids are 'Default' / 'Profile N').
  // P2-3: the old gate was a string prefix on the resolved path, so a
  // symlinked profile dir INSIDE the user-data dir passed it while the
  // import copied cookies from the link's canonical target - any cookie DB
  // on the machine. Compare canonical paths (fs-utils realpath chain),
  // keeping the root-identity allowance ('.' names the user-data dir).
  const dir = path.resolve(userDataDir, profileId);
  const rel = path.relative(canonicalRoot(userDataDir), canonicalPath(dir));
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
    throw new Error(`Invalid Chrome profile id: ${JSON.stringify(profileId)}`);
  }
  return dir;
}

/** Returns the path to the Local State JSON file. */
export function localStatePath(userDataDir: string): string {
  return path.join(userDataDir, 'Local State');
}
