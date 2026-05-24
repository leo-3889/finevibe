import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Snapshots the Cookies and Login Data DBs (and their journals) from the
 * Chrome profile dir into a unique temp dir. Works while Chrome is running:
 * tries fs.copyFileSync first, and on EBUSY (Windows lock) retries via a
 * buffered readFileSync + writeFileSync pair which Chrome's shared-cache
 * sqlite mode tolerates.
 *
 * Returns the temp dir; caller is responsible for cleanup().
 */
export interface Snapshot {
  dir: string;
  cookiesPath: string | null;
  loginDataPath: string | null;
  cleanup: () => void;
}

const FILES_TO_COPY = ['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal'];

function copyOne(src: string, dest: string): boolean {
  try {
    fs.copyFileSync(src, dest);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    // EBUSY on Windows when Chrome holds an exclusive lock.
    try {
      const buf = fs.readFileSync(src);
      fs.writeFileSync(dest, buf);
      return true;
    } catch {
      return false;
    }
  }
}

export function snapshotProfile(profileDir: string): Snapshot {
  const uniq = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `vibeyard-chrome-import-${uniq}`);
  fs.mkdirSync(dir, { recursive: true });

  let cookiesPath: string | null = null;
  let loginDataPath: string | null = null;

  for (const fname of FILES_TO_COPY) {
    const src = path.join(profileDir, fname);
    const dest = path.join(dir, fname);
    if (!fs.existsSync(src)) continue;
    if (copyOne(src, dest)) {
      if (fname === 'Cookies') cookiesPath = dest;
      if (fname === 'Login Data') loginDataPath = dest;
    }
  }

  return {
    dir,
    cookiesPath,
    loginDataPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
