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

/** Sole producer of the import temp-dir prefix: the sweep below matches it. */
export const IMPORT_TEMP_PREFIX = 'finevibe-chrome-import-';

/** Mirrors SCREENSHOT_MAX_AGE_MS (ipc-handlers finevibe-screenshots prune). */
export const IMPORT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * P2-47: quit/crash mid-import used to leave the cookie snapshot in the OS
 * temp dir for the machine's life — `cleanup()` only runs if the import
 * reaches its finally block. Sweeps stale `finevibe-chrome-import-*` dirs,
 * mirroring the finevibe-screenshots prune: age bound on mtime, swallow per
 * entry (a locked dir stays for the next boot), directories only.
 *
 * Returns the number of dirs removed. `maxAgeMs: 0` sweeps every match
 * regardless of age — the after-import call site, where the snapshot of the
 * import that just ended is dead the moment the handler returns.
 * `tmpDir` is a test seam; production sweeps os.tmpdir().
 */
export function sweepImportTempDirs(
  opts: { maxAgeMs?: number; tmpDir?: string } = {},
): number {
  const maxAgeMs = opts.maxAgeMs ?? IMPORT_TEMP_MAX_AGE_MS;
  const base = opts.tmpDir ?? os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(IMPORT_TEMP_PREFIX)) continue;
    const full = path.join(base, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      // The bound is the in-flight-import guarantee: a fresh dir (a live
      // import on this machine) is NEVER deleted by the age sweep.
      if (maxAgeMs > 0 && now - st.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Unreadable entry, vanished dir, Windows file lock: leave it, sweep on.
    }
  }
  return removed;
}

export function snapshotProfile(profileDir: string): Snapshot {
  const uniq = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), `${IMPORT_TEMP_PREFIX}${uniq}`);
  // The snapshot is the full cookie DB and used to land world-readable:
  // a plain recursive mkdir gives the dir the tmpdir-default 0755 (the
  // buffered EBUSY fallback then wrote Cookies 0644). `mode` on a recursive
  // mkdir applies only to the final segment and is masked by umask, so
  // mkdir 0700 + explicit chmod is the only portable way to pin it.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  let cookiesPath: string | null = null;
  const src = path.join(profileDir, COOKIES_FILE);
  const dest = path.join(dir, COOKIES_FILE);
  if (fs.existsSync(src) && copyOne(src, dest)) {
    cookiesPath = dest;
    // copyFileSync inherits the source's modes; the fallback lands 0644.
    // Pin 0600 (Windows emulates chmod — the mode call is a benign no-op
    // there; exotic filesystems without POSIX perms must not fail the copy).
    try {
      fs.chmodSync(dest, 0o600);
    } catch {
      // the 0700 dir still gates access on POSIX
    }
  }

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
