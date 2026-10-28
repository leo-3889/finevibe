import * as path from 'path';
import { FSWatcher } from 'chokidar';
import type { BrowserWindow } from 'electron';
import type { FsChange, FsChangeType } from '../shared/types';
import { evictOldest } from './bounded-map';

// Snappier than the old 500ms — live agent edits should feel near-instant — while
// still coalescing the burst from a tool writing many files into one renderer flush.
const DEBOUNCE_MS = 150;

// C5G-06: every watched directory is a live chokidar watcher (an OS file
// descriptor). The ref-counted set grew one entry per distinct directory ever
// opened for the app's lifetime — unbounded. Cap the live set (git-watcher's
// MAX_WATCHES idiom) and evict the least-recently-watched folder when full.
const MAX_FOLDER_WATCHES = 2000;
let capWarned = false;

// Watcher resilience: network mounts (UNC shares, \\wsl.localhost\ / wsl$)
// are where native fs notifications are known to stop reporting; chokidar's
// documented fallback is polling. Polling costs a stat pass per root per
// interval, so it is opt-in: on when a watched root is a network path, and
// latched on after ANY watcher 'error' — the watcher is global (every dir
// shares one chokidar instance), so an error invalidates native
// notifications for every root, not just the one that tripped.
const POLL_INTERVAL_MS = 2000;
let pollingLatched = false;
let watcherPolling = false;
let watcherErrorWarned = false;

/**
 * Directory-granular file watcher backed by a single chokidar instance.
 *
 * We watch *directories* (non-recursively, `depth: 0`) rather than individual
 * file inodes. Watching the parent dir survives atomic save/replace (write-temp
 * + rename), which silently kills a watch on the old inode — the bug the inode
 * approach suffered from. Consumers that care about a single file watch its
 * parent dir and filter incoming changes by path.
 *
 * Directories are ref-counted so multiple consumers (the file tree, an open
 * reader, an open viewer) can share one underlying watch.
 */

const refCounts = new Map<string, number>();
let watcher: FSWatcher | null = null;
let currentWin: BrowserWindow | null = null;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Keyed by `${type}:${path}` so distinct events on the same path within a window
// are preserved, while duplicate events collapse.
const pending = new Map<string, FsChange>();

function flush(): void {
  debounceTimer = null;
  if (pending.size === 0) return;
  const changes = [...pending.values()];
  pending.clear();
  if (currentWin && !currentWin.isDestroyed()) {
    currentWin.webContents.send('fs:changed', changes);
  }
}

function queueChange(type: FsChangeType, fullPath: string): void {
  pending.set(`${type}:${fullPath}`, { path: fullPath, dir: path.dirname(fullPath), type });
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
}

function ensureWatcher(): FSWatcher {
  if (watcher) return watcher;
  const usePolling = pollingLatched || [...refCounts.keys()].some(isNetworkRoot);
  const w = new FSWatcher({
    ignoreInitial: true, // don't replay existing entries when a dir is added
    depth: 0, // non-recursive: each added dir reports only its immediate children
    atomic: true, // collapse write-temp + rename into a single change event
    ignorePermissionErrors: true,
    persistent: true,
    usePolling,
    ...(usePolling ? { interval: POLL_INTERVAL_MS, binaryInterval: POLL_INTERVAL_MS } : {}),
  });
  const events: FsChangeType[] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir'];
  for (const ev of events) {
    w.on(ev, (p: string) => queueChange(ev, p));
  }
  // Dir deleted / unreadable is handled via the parent's unlinkDir — the
  // swallow stops at the FIRST real error: warn once with the code, then
  // rebuild in polling mode; native notifications are no longer trusted.
  w.on('error', (err: unknown) => onWatcherError(err as NodeJS.ErrnoException));
  watcherPolling = usePolling;
  watcher = w;
  return w;
}

/** UNC share / WSL mount: roots where native fs events are unreliable. */
function isNetworkRoot(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.startsWith('\\\\') || lower.includes('wsl.localhost') || lower.includes('wsl$');
}

function onWatcherError(err: NodeJS.ErrnoException): void {
  if (!watcherErrorWarned) {
    watcherErrorWarned = true;
    console.warn(`[file-watcher] watcher error (${err?.code ?? 'unknown'}): ${err?.message ?? String(err)}`);
  }
  if (!watcherPolling) restartWithPolling();
}

/** Rebuild the global watcher in polling mode and re-arm every live root. */
function restartWithPolling(): void {
  pollingLatched = true;
  const dirs = [...refCounts.keys()];
  void watcher?.close();
  watcher = null;
  const w = ensureWatcher();
  for (const dir of dirs) w.add(dir);
}

export function setFileWatcherWindow(win: BrowserWindow): void {
  currentWin = win;
}

/** Watch a directory's immediate children. Expects an already-resolved absolute path. */
export function watchDir(dir: string): void {
  const cur = refCounts.get(dir);
  if (cur) {
    // C5G-06: LRU touch — move to the Map tail so the eviction candidate is
    // always the least-recently-watched folder, not the first one ever added.
    refCounts.delete(dir);
    refCounts.set(dir, cur + 1);
    return;
  }
  // C5G-06: at the cap, evict the least-recently-watched folder (the Map head,
  // since the touch above keeps the tail most-recent) via the normal unwatch
  // path, releasing its chokidar watch + fd. Graceful degradation matches
  // git-watcher's MAX_WATCHES: an evicted folder stops pushing fs:changed
  // events until it is re-opened (watchDir re-arms it).
  evictOldest(refCounts, MAX_FOLDER_WATCHES - 1, (oldest) => {
    unwatchDir(oldest);
    if (!capWarned) {
      console.warn(
        `[file-watcher] reached MAX_FOLDER_WATCHES=${MAX_FOLDER_WATCHES}; evicted the least-recently-watched folder to admit ${dir}`
      );
      capWarned = true;
    }
  });
  refCounts.set(dir, 1);
  ensureWatcher().add(dir);
  // A network root admitted into a native-mode watcher: native events are
  // unreliable exactly there — rebuild in polling mode (idempotent latch).
  if (isNetworkRoot(dir) && !watcherPolling) restartWithPolling();
}

/** Drop a reference to a watched directory; closes the watch when the last ref goes. */
export function unwatchDir(dir: string): void {
  const cur = refCounts.get(dir);
  if (!cur) return;
  if (cur <= 1) {
    refCounts.delete(dir);
    watcher?.unwatch(dir);
  } else {
    refCounts.set(dir, cur - 1);
  }
}

export function stopAllFileWatchers(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending.clear();
  refCounts.clear();
  capWarned = false;
  pollingLatched = false;
  watcherPolling = false;
  watcherErrorWarned = false;
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  currentWin = null;
}
