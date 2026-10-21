import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Snapshots the Cookies DB from the Chrome profile dir into a unique temp
 * dir. Works while Chrome is running: tries fs.copyFileSync first, and on
 * EBUSY (Windows lock) retries via a buffered readFileSync + writeFileSync
 * pair which Chrome's shared-cache sqlite mode tolerates.
 *
 * `Login Data` is deliberately NOT copied (P2-46): the importer reads only
 * the cookie snapshot, so the credential DB was duplicated into a 0755
 * temp dir — with the readFileSync+writeFileSync fallback landing it 0644 —
 * for no reader.
 *
 * The SQLite `-journal` sidecars are deliberately NOT copied: a page copy
 * plus a mid-transaction journal makes SQLite treat the snapshot as an
 * interrupted transaction, and opening that copy readonly fails with
 * SQLITE_READONLY (import silently yields 0 rows). With only the main file,
 * the reader opens the copy read-write and recovers cleanly.
 *
 * Returns the temp dir; caller is responsible for cleanup().
 */
export interface Snapshot {
  dir: string;
  cookiesPath: string | null;
  cleanup: () => void;
}

const COOKIES_FILE = 'Cookies';

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
  const src = path.join(profileDir, COOKIES_FILE);
  const dest = path.join(dir, COOKIES_FILE);
  if (fs.existsSync(src) && copyOne(src, dest)) cookiesPath = dest;

  return {
    dir,
    cookiesPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
