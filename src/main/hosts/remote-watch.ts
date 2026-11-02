// Remote file watching (MH-1 Phase 4, plan §11): chokidar cannot watch over
// sftp, so a watched remote directory is POLLED — one interval per watch reads
// the dir via the ssh seam and diffs the entry set against the last snapshot;
// the delta is emitted on the same `fs:changed` channel the local
// file-watcher uses, so the renderer tree/reader need no new subscription.
//
// ponytail: fixed 5 s interval per dir (one sftp readdir each); the local
// watcher's chokidar events are event-driven because the OS gives them for
// free — over the wire, polling is the only option and batching all dirs into
// one shared tick is the upgrade path if watch counts ever grow.
//
// Caps (module-map governance): MAX_REMOTE_WATCHES bounds the watched-path
// set, MAX_REMOTE_WATCHED_HOSTS bounds the fan-out across registry hosts.
// Both evict FIFO via `evictOldest`, matching the file-watcher idiom. Teardown
// lives in {@link stopAllRemoteWatchers}, called from main.ts next to
// `stopAllFileWatchers` (window closed + quit cleanup).

import type { BrowserWindow } from 'electron';
import type { FsChange } from '../../shared/types';
import { sftpListDirEntries } from './ssh-client';
import { getHost } from './host-registry';
import { normalizeRemotePath } from './remote-fs';
import { evictOldest } from '../bounded-map';
import { LOCAL_HOST_ID } from '../../shared/types';

/** Poll period per watched remote directory, and the timeout of the one sftp
 * readdir each poll issues (a poll that outlives its own interval would
 * stack, so the two numbers are deliberately the same). Remote tree updates
 * are therefore up to this stale — the local watcher is event-driven because
 * the OS gives notifications for free; over the wire polling is the only
 * option, and 5 s is the latency/bandwidth trade (a 200-watch set is 40
 * readdir/s). */
export const REMOTE_POLL_MS = 5_000;

/** Watched-path cap (module-map governance for `watches`): the renderer
 * already caps its watched set per project (the file tree unwatches subtrees
 * on collapse); this is the global backstop. One entry = one interval + one
 * entry-name snapshot. FIFO-evicted, like file-watcher's MAX_FOLDER_WATCHES:
 * an evicted directory stops pushing `fs:changed` until it is re-opened. */
export const MAX_REMOTE_WATCHES = 200;

/** Distinct-host cap: the path cap bounds the poll rate, this bounds the
 * number of ssh connections the polls keep warm (a watch on 30 hosts is 30
 * connections for a handful of trees). Enforced against the `watches` map
 * itself — the host owning the oldest remaining watch loses ALL its watches,
 * so admitting one new host always frees a slot and no second collection (and
 * no second allowlist entry) is needed. */
export const MAX_REMOTE_WATCHED_HOSTS = 8;

interface RemoteWatch {
  hostId: string;
  dir: string;
  timer: ReturnType<typeof setInterval>;
  // entry name → `${isDir ? 'd' : 'f'}:${mtimeMs}` (dirs carry their own
  // mtime, which POSIX bumps when their children change — a child edit inside
  // a subdirectory therefore surfaces as a `change` on the subdirectory path).
  snapshot: Map<string, string>;
  errorWarned: boolean;
}

const watches = new Map<string, RemoteWatch>();
let currentWin: BrowserWindow | null = null;
let capWarned = false;

const watchKey = (hostId: string, dir: string): string => `${hostId}|${dir}`;
const hostOfKey = (key: string): string => key.slice(0, key.indexOf('|'));

function dropWatch(key: string): void {
  const watch = watches.get(key);
  if (watch) clearInterval(watch.timer);
  watches.delete(key);
}

/** Make room for one more watch: FIFO-drop the oldest polls past the path cap,
 * then evict the whole oldest host when `hostId` is new and the host set is
 * full (both are graceful degradations — an evicted watch re-arms on the next
 * `fs:watchDir`, exactly like an unwatched directory). */
function makeRoom(hostId: string): void {
  evictOldest(watches, MAX_REMOTE_WATCHES - 1, (oldest) => {
    dropWatch(oldest);
    warnCap(`MAX_REMOTE_WATCHES=${MAX_REMOTE_WATCHES}; evicted ${oldest}`);
  });
  const hosts = new Set<string>();
  for (const key of watches.keys()) hosts.add(hostOfKey(key));
  if (hosts.has(hostId) || hosts.size < MAX_REMOTE_WATCHED_HOSTS) return;
  // Set insertion order is Map insertion order, so the first host is the one
  // whose oldest watch is the oldest — the same FIFO candidate as above.
  const oldestHost = hosts.values().next().value as string;
  for (const key of [...watches.keys()]) {
    if (hostOfKey(key) === oldestHost) dropWatch(key);
  }
  warnCap(`MAX_REMOTE_WATCHED_HOSTS=${MAX_REMOTE_WATCHED_HOSTS}; evicted every watch on ${oldestHost}`);
}

function warnCap(message: string): void {
  if (capWarned) return;
  capWarned = true;
  console.warn(`[remote-watch] ${message}`);
}

export function setRemoteWatchWindow(win: BrowserWindow): void {
  currentWin = win;
}

async function pollOnce(watch: RemoteWatch, emitChanges = true): Promise<void> {
  const record = getHost(watch.hostId);
  if (!record) return; // host forgotten mid-watch
  let entries: Awaited<ReturnType<typeof sftpListDirEntries>>;
  try {
    entries = await sftpListDirEntries(record, watch.dir, { timeoutMs: REMOTE_POLL_MS });
  } catch (err) {
    if (!watch.errorWarned) {
      watch.errorWarned = true;
      console.warn(`remote watch failed [${watch.hostId}] ${watch.dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return; // transient failure: keep the last snapshot, retry next tick
  }
  if (entries === null) return; // dir vanished mid-watch: keep the snapshot
  const next = new Map<string, string>();
  for (const e of entries) next.set(e.name, `${e.isDirectory ? 'd' : 'f'}:${e.mtimeMs}`);
  const changes: FsChange[] = [];
  for (const [name, fingerprint] of next) {
    const prev = watch.snapshot.get(name);
    if (prev === undefined) {
      changes.push({
        path: `${watch.dir}/${name}`,
        dir: watch.dir,
        type: fingerprint.startsWith('d') ? 'addDir' : 'add',
      });
    } else if (prev !== fingerprint) {
      changes.push({ path: `${watch.dir}/${name}`, dir: watch.dir, type: 'change' });
    }
  }
  for (const name of [...watch.snapshot.keys()]) {
    if (next.has(name)) continue;
    const wasDir = (watch.snapshot.get(name) as string).startsWith('d');
    changes.push({
      path: `${watch.dir}/${name}`,
      dir: watch.dir,
      type: wasDir ? 'unlinkDir' : 'unlink',
    });
  }
  watch.snapshot = next;
  if (changes.length > 0 && emitChanges && currentWin && !currentWin.isDestroyed()) {
    currentWin.webContents.send('fs:changed', changes);
  }
}

/**
 * Begin polling `dirPath` on `hostId`. Idempotent per (host, dir).
 *
 * Audit R93 checked this lane for the tree rails' project containment and it
 * does not belong: the poll has NO stat call (one sftp readdir per tick), and a
 * directory listing is the ENUMERATE tier — the remote twin of the local
 * `fs:watchDir` gate (`isAllowedEnumeratePath`, projects + config trees + home),
 * whose consent on a registry host is the enrolled HostRecord (council R-1), the
 * same rule `hosts:listDirs` runs. The READ tier (`fs:listDir`/`fs:readFile`) and
 * the file-stat rails (`fs:exists`/`fs:stat`/`fs:isDirectory`) are the ones
 * narrowed to known projects.
 */
export function watchRemoteDir(hostId: string, dirPath: string): void {
  if (hostId === LOCAL_HOST_ID) return; // the local watcher owns local paths
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return;
  const key = watchKey(hostId, dir);
  if (watches.has(key)) return;
  makeRoom(hostId);
  const watch: RemoteWatch = {
    hostId,
    dir,
    timer: setInterval(() => void pollOnce(watch), REMOTE_POLL_MS),
    snapshot: new Map(),
    errorWarned: false,
  };
  watches.set(key, watch);
  // Seed the snapshot immediately — the initial listing is not a change, so
  // the seed poll computes it silently; later ticks diff against it.
  void pollOnce(watch, false);
}

export function unwatchRemoteDir(hostId: string, dirPath: string): void {
  if (hostId === LOCAL_HOST_ID) return;
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return;
  dropWatch(watchKey(hostId, dir));
}

/**
 * Teardown bound: clear every poll interval and every snapshot, and release
 * the window. Registered in main.ts beside {@link stopAllFileWatchers} — on
 * `mainWindow.on('closed')` (a re-opened window re-issues `fs:watchDir`, which
 * must re-point `fs:changed` at the NEW window instead of early-returning on
 * the existing watch with the destroyed one latched) and in quit cleanup, so
 * no interval outlives the window/app that started it.
 */
export function stopAllRemoteWatchers(): void {
  for (const key of [...watches.keys()]) dropWatch(key);
  capWarned = false;
  currentWin = null;
}

/** Test hook: current watch keys (also used by the renderer teardown tests). */
export function remoteWatchKeys(): string[] {
  return [...watches.keys()];
}
