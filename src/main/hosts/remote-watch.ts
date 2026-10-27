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
// Cap: MAX_REMOTE_WATCHES (module-map governance) — the renderer already caps
// its watched set per project (file-tree unwatchSubtree on collapse); this is
// the global backstop. FIFO eviction, matching the file-watcher idiom.

import type { BrowserWindow } from 'electron';
import type { FsChange } from '../../shared/types';
import { sftpListDirEntries } from './ssh-client';
import { getHost } from './host-registry';
import { normalizeRemotePath } from './remote-fs';
import { LOCAL_HOST_ID } from '../../shared/types';

const REMOTE_POLL_MS = 5_000;
export const MAX_REMOTE_WATCHES = 200;

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

const watchKey = (hostId: string, dir: string): string => `${hostId}|${dir}`;

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

/** Begin polling `dirPath` on `hostId`. Idempotent per (host, dir). */
export function watchRemoteDir(hostId: string, dirPath: string): void {
  if (hostId === LOCAL_HOST_ID) return; // the local watcher owns local paths
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return;
  const key = watchKey(hostId, dir);
  if (watches.has(key)) return;
  if (watches.size >= MAX_REMOTE_WATCHES) {
    const oldest = watches.keys().next();
    if (!oldest.done) {
      const evicted = watches.get(oldest.value);
      if (evicted) clearInterval(evicted.timer);
      watches.delete(oldest.value);
    }
  }
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
  const key = watchKey(hostId, dir);
  const watch = watches.get(key);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(key);
}

/** Test hook: current watch keys (also used by the renderer teardown tests). */
export function remoteWatchKeys(): string[] {
  return [...watches.keys()];
}
