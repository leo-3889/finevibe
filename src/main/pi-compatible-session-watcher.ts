import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { writeCliSessionId } from './hook-status';
import { isWin, isMac } from './platform';
import { readSessionHeaderSync } from './providers/pi-compatible-transcripts';

/**
 * Shared session-id discovery watcher for Pi-compatible providers (Pi and
 * OMP). Neither has a hook system to report session IDs back to the host
 * app, so we watch the agent's sessions/ directory: every process creates a
 * new <ISO-timestamp>_<uuid>.jsonl whose head carries a session header with
 * the id and cwd (OMP prepends a `type:"title"` line in front of it). When
 * a new file appears for a pending UI session's project, we write a
 * .sessionid file so hook-status picks it up and forwards
 * session:cliSessionId — the same channel Codex uses. Providers whose CLI
 * self-titles or needs polled status (OMP, Pi) pass an onAdopted callback
 * to start mirroring via the merged session-transcript-sync module.
 *
 * A session is kept tracked after adoption (not dropped) so a later `/clear`
 * — which starts a brand-new transcript under a new id in the same cwd — is
 * re-adopted: the renderer's cliSessionId and the transcript-sync entry move
 * to the live conversation instead of freezing on the pre-clear one. That
 * re-adoption is bounded by CLEAR_ADOPTION_WINDOW_MS so an unrelated
 * external CLI run in the same directory can't hijack the tab.
 *
 * Event-driven scans are coalesced by scheduleScan(), so an actively
 * appending transcript cannot drive a full-tree scan per write; the
 * POLL_INTERVAL_MS poll stays the correctness guarantee.
 *
 * Parameterized only by the sessions-root resolver; Pi and OMP each get a
 * thin wrapper (pi-session-watcher.ts / omp-session-watcher.ts) with its
 * own registration state.
 */

export interface CompatibleSessionWatcherOptions {
  /** Called after a session id is adopted, for follow-up wiring (title sync). */
  onAdopted?: (uiSessionId: string, cliSessionId: string, projectPath: string, configDir?: string) => void;
}

export interface CompatibleSessionWatcher {
  start(): void;
  registerPending(sessionId: string, projectPath: string, configDir?: string): void;
  unregister(sessionId: string): void;
  stop(): void;
}

interface WatchedSession {
  projectPath: string;
  configDir?: string;
  /** Transcript files that existed at registration — never adopted. */
  knownGeneration: number;
  registeredAt: number;
  /**
   * Set once this session's transcript is adopted. Kept (not deleted) so a
   * later `/clear` — a newer transcript in the same cwd — can be
   * re-adopted, keeping the synced title/status on the live conversation
   * instead of the frozen pre-clear one.
   */
  adoptedFile?: string;
  adoptedCliId?: string;
  adoptedFileTs?: number | null;
}

interface Candidate {
  file: string;
  sessionId: string;
  cwd: string;
  /** Sessions root the file was found under — a candidate only matches
   *  pending sessions registered against the same root (profile scoping). */
  root: string;
  /** ISO timestamp parsed from the filename, or null when absent/unparseable. */
  fileTs: number | null;
}

/**
 * Filenames are <ISO-timestamp>_<uuid>.jsonl with ':' and '.' rewritten as
 * '-' (e.g. 2026-08-15T23-09-32-005Z). Returns the timestamp in ms, or null
 * when the filename doesn't start with one.
 */
function filenameTimestampMs(file: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(path.basename(file));
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ts) ? null : ts;
}

// A CLI writes the transcript a few ms after the UI session registers; a
// candidate stamped older than this window (minus tolerance) is an external
// run in the same project and must not be adopted.
const ADOPTION_TOLERANCE_MS = 5_000;

/**
 * How far back a `/clear` re-adoption may look (Pass 2).
 *
 * A genuine `/clear` writes its new transcript within milliseconds and the
 * watcher reacts within one scan — at most SCAN_MIN_SPACING_MS when the
 * event path is alive, otherwise one POLL_INTERVAL_MS tick — so a few
 * seconds suffice in the normal case. The window is deliberately generous
 * (60s ≈ 20x that) to survive a slow spawn, a missed watch event or a
 * busy main thread, while still rejecting the failure mode a stale
 * registration-time `knownFiles` snapshot allows: an unrelated `omp`/`pi`
 * run launched directly in the same project directory (minutes or hours
 * old, still appending) being adopted as this session's `/clear`, which
 * repoints the tab's id, title and polled status at a foreign conversation.
 *
 * The trade-off is a re-adoption first seen more than a minute after the
 * clear (only possible when scanning was starved, e.g. no window open) is
 * skipped and the tab keeps tracking the pre-clear transcript — the
 * pre-window behaviour for every non-clear case anyway.
 */
const CLEAR_ADOPTION_WINDOW_MS = 60_000;

/**
 * Event-driven scan pacing. A transcript is appended continuously during
 * an agent turn, so the root watcher plus every per-cwd subdir watcher
 * fire many times per second; scanning on each event re-reads the header
 * (open + 8KB read + JSON.parse) of every transcript in the tree.
 *
 *  - SCAN_DEBOUNCE_MS coalesces a burst into one scan. The timer is NOT
 *    re-armed while pending, so the window is measured from the burst's
 *    first event and a continuous stream can never starve discovery.
 *  - SCAN_MIN_SPACING_MS is the floor between consecutive event-driven
 *    scans, capping the steady-state rate at ~1/sec no matter how chatty
 *    the watchers are.
 *
 * The POLL_INTERVAL_MS fallback stays the correctness guarantee, so events
 * dropped by the coalescing cost at most one poll tick of latency.
 */
const SCAN_DEBOUNCE_MS = 250;
const SCAN_MIN_SPACING_MS = 1_000;
const POLL_INTERVAL_MS = 2_000;

export function createCompatibleSessionWatcher(
  sessionsRootOf: (configDir?: string) => string,
  options: CompatibleSessionWatcherOptions = {}
): CompatibleSessionWatcher {
  const watchedSessions = new Map<string, WatchedSession>();
  const assignedIds = new Set<string>();
  // A single registration history per root replaces one full Set per session.
  const histories = new Map<string, { generation: number; files: Map<string, number> }>();
  const directoryCache = new Map<string, { mtime: number; checked: number; names: string[] }>();
  const dirtyDirectories = new Set<string>();

  function readDirectory(dir: string, force = false): string[] {
    const cached = directoryCache.get(dir);
    let mtime = Number.NaN;
    try { mtime = fs.statSync(dir).mtimeMs; } catch { /* Fall back to enumeration. */ }
    if (!force && cached && cached.mtime === mtime && !dirtyDirectories.has(dir) && Date.now() - cached.checked < 30_000) return cached.names;
    try {
      const names = fs.readdirSync(dir);
      directoryCache.set(dir, { mtime, checked: Date.now(), names });
      dirtyDirectories.delete(dir);
      return names;
    } catch { directoryCache.delete(dir); return []; }
  }

  function refreshHistory(root: string, force = false): { generation: number; files: Map<string, number>; current: string[] } {
    let history = histories.get(root);
    if (!history) { history = { generation: 0, files: new Map() }; histories.set(root, history); }
    const current: string[] = [];
    for (const dir of readDirectory(root, force)) {
      const directory = path.join(root, dir);
      for (const name of readDirectory(directory, force)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(directory, name);
        if (!history.files.has(file)) history.files.set(file, ++history.generation);
        current.push(file);
      }
    }
    return { ...history, current };
  }

  // Bounded: the set exists to dedupe ids already adopted; evict oldest
  // (Sets preserve insertion order) so it can't grow for the app's lifetime.
  const MAX_ASSIGNED_IDS = 1000;
  function rememberAssignedId(id: string): void {
    if (assignedIds.size >= MAX_ASSIGNED_IDS) {
      const oldest = assignedIds.values().next().value;
      if (oldest !== undefined) assignedIds.delete(oldest);
    }
    assignedIds.add(id);
  }

  const watchers: fs.FSWatcher[] = [];
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Pending coalesced scan; non-null while a burst is being collapsed. */
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the last scan actually ran, so pacing sees poll scans too. */
  let lastScanAt = 0;

  // Case-insensitive on Windows and macOS (both default to
  // case-insensitive filesystems): drive-letter and path-case differences
  // must not block the match.
  const caseInsensitive = isWin || isMac;

  function cwdMatches(a: string, b: string): boolean {
    return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  }


  /**
   * Commit an adoption: publish the id to the renderer, mark it assigned,
   * record it on the watched session, and fire the follow-up wiring. A
   * failed id write leaves the session in its prior state so the next scan
   * retries (never crash the timer/watch callback).
   */
  function adopt(uiId: string, p: WatchedSession, cand: Candidate): boolean {
    try {
      writeCliSessionId(uiId, cand.sessionId);
    } catch {
      // Disk full / permissions — keep prior state, retry on the next scan.
      return false;
    }
    rememberAssignedId(cand.sessionId);
    p.adoptedFile = cand.file;
    p.adoptedCliId = cand.sessionId;
    p.adoptedFileTs = cand.fileTs;
    // Follow-up wiring (e.g. starting the transcript sync) must not undo an
    // adoption if the callback throws.
    try {
      options.onAdopted?.(uiId, cand.sessionId, p.projectPath, p.configDir);
    } catch { /* best-effort */ }
    return true;
  }

  function scanForNewSessions(): void {
    if (watchedSessions.size === 0) return;

    // One clock reading per scan so the scan floor and the Pass 2 clear
    // window agree with each other.
    const now = Date.now();
    // Oldest filename timestamp that can still matter this scan. Each
    // session contributes its own lower bound: an adopted one can only
    // re-adopt inside the clear window, an un-adopted one waits for its
    // first transcript — anything from registration on, clamped to the
    // clear window. The clamp is safe because a pending session can only
    // adopt a transcript created AFTER registration, and Pass 1's own
    // freshness check (cand.fileTs >= registeredAt - ADOPTION_TOLERANCE_MS)
    // already bounds adoption to recent files: a genuinely new transcript
    // is by definition recent, so once the registration is older than the
    // clear window the bound can tighten without losing any adoptable
    // candidate (for a fresh registration the clamp is a no-op, since
    // registeredAt is recent). Without it, an un-adopted session (e.g. a
    // resumed one whose knownFiles snapshot covers everything on disk)
    // would keep a hours-old floor and pay an 8KB header read for every
    // transcript in the tree on every tick.
    let floor = Number.POSITIVE_INFINITY;
    for (const p of watchedSessions.values()) {
      const lowerBound = p.adoptedFile
        ? now - CLEAR_ADOPTION_WINDOW_MS
        : Math.max(p.registeredAt - ADOPTION_TOLERANCE_MS, now - CLEAR_ADOPTION_WINDOW_MS);
      if (lowerBound < floor) floor = lowerBound;
    }

    // Group by sessions root: one walk + one header read per root per scan,
    // not one per watched session.
    const byRoot = new Map<string, Array<[string, WatchedSession]>>();
    for (const [uiId, p] of watchedSessions) {
      const root = sessionsRootOf(p.configDir);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push([uiId, p]);
    }

    const candidates: Candidate[] = [];
    for (const [root, sessions] of byRoot) {
      const history = refreshHistory(root);
      const oldestRegistration = Math.min(...sessions.map(([, session]) => session.knownGeneration));
      for (const full of history.current) {
        if ((history.files.get(full) ?? 0) <= oldestRegistration) continue;
        const fileTs = filenameTimestampMs(full);
        if (fileTs !== null && fileTs < floor) continue;
        const header = readSessionHeaderSync(full);
        if (!header || typeof header.cwd !== 'string' || assignedIds.has(header.id)) continue;
        candidates.push({ file: full, sessionId: header.id, cwd: header.cwd, root, fileTs });
      }
    }
    // Filenames start with an ISO timestamp — sort by name (plain string
    // compare) so simultaneous sessions in the same project pair in start
    // order, not readdir order.
    candidates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

    const taken = new Set<string>();

    // Pass 1 — fresh adoption: an un-adopted session claims its first
    // transcript. Pending sessions take priority over clear re-adoption so a
    // brand-new session in a project is never mistaken for another's clear.
    for (const cand of candidates) {
      const match = (byRoot.get(cand.root) ?? []).find(
        ([uiId, p]) => !p.adoptedFile
          && !taken.has(uiId)
          && (histories.get(cand.root)?.files.get(cand.file) ?? 0) > p.knownGeneration
          && (cand.fileTs === null || cand.fileTs >= p.registeredAt - ADOPTION_TOLERANCE_MS)
          && cwdMatches(p.projectPath, cand.cwd)
      );
      if (!match) continue;
      if (adopt(match[0], match[1], cand)) taken.add(match[0]);
    }

    // Pass 2 — `/clear` re-adoption: a NEWER unassigned transcript in the
    // same cwd is the adopted session's fresh start. Applied only when
    // exactly ONE adopted session maps to that (cwd, root): with several, a
    // new transcript can't be safely attributed, so we leave the existing
    // one (no worse than before). The candidate must be strictly newer than
    // the currently-adopted file, carry a parseable timestamp, and be
    // fresh — created inside CLEAR_ADOPTION_WINDOW_MS. The freshness bound
    // is what stops an unrelated `omp`/`pi` run in the same directory from
    // hijacking the tab: `knownFiles` is a snapshot taken at registration,
    // so it can't tell a genuine clear from an external transcript that
    // simply appeared later, but a genuine clear is always recent.
    for (const cand of candidates) {
      const candTs = cand.fileTs;
      if (candTs === null) continue;
      if (candTs < now - CLEAR_ADOPTION_WINDOW_MS) continue;
      // A candidate that Pass 1 already handed to a pending session is no
      // longer free. The candidate list is built before Pass 1 runs, so the
      // `assignedIds` filter applied during collection does not reflect
      // those adoptions — re-check here. Without this, Pass 2 can give an
      // already-adopted session the transcript that belongs to another:
      // two UI sessions sharing one cliSessionId resolve to the same
      // transcript, so every title that transcript publishes renames both
      // tabs on every surface.
      if (assignedIds.has(cand.sessionId)) continue;
      const matches = (byRoot.get(cand.root) ?? []).filter(
        ([uiId, p]) => p.adoptedFile
          && !taken.has(uiId)
          && cand.file !== p.adoptedFile
          && (histories.get(cand.root)?.files.get(cand.file) ?? 0) > p.knownGeneration
          && (p.adoptedFileTs == null || candTs > p.adoptedFileTs)
          && cwdMatches(p.projectPath, cand.cwd)
      );
      if (matches.length !== 1) continue;
      if (adopt(matches[0][0], matches[0][1], cand)) taken.add(matches[0][0]);
    }
  }

  function registerPending(sessionId: string, projectPath: string, configDir?: string): void {
    watchedSessions.set(sessionId, {
      projectPath,
      configDir,
      // Registration needs a fresh snapshot even on coarse-mtime filesystems.
      knownGeneration: refreshHistory(sessionsRootOf(configDir), true).generation,
      registeredAt: Date.now(),
    });
  }

  function unregister(sessionId: string): void {
    watchedSessions.delete(sessionId);
    const roots = new Set([...watchedSessions.values()].map(p => sessionsRootOf(p.configDir)));
    for (const root of histories.keys()) {
      if (roots.has(root)) continue;
      histories.delete(root);
      for (const dir of directoryCache.keys()) {
        if (dir === root || path.dirname(dir) === root) { directoryCache.delete(dir); dirtyDirectories.delete(dir); }
      }
    }
  }

  /**
   * Run one scan and record when it ran, so the event-driven pacing also
   * sees poll-driven scans: a poll that just ran means a following burst can
   * wait out its full spacing instead of scanning again immediately.
   */
  function runScan(): void {
    lastScanAt = Date.now();
    if (watchedSessions.size > 0) scanForNewSessions();
  }

  /**
   * Coalesce watch events into one scan (see SCAN_DEBOUNCE_MS /
   * SCAN_MIN_SPACING_MS). The pending timer is never re-armed, so a
   * continuous stream of events collapses to one scan per window rather
   * than one per event, and the window can never be pushed out
   * indefinitely — discovery is never starved.
   */
  function scheduleScan(): void {
    if (scanTimer) return;
    const delay = Math.max(
      SCAN_DEBOUNCE_MS,
      SCAN_MIN_SPACING_MS - (Date.now() - lastScanAt)
    );
    scanTimer = setTimeout(() => {
      scanTimer = null;
      runScan();
    }, delay);
  }

  function start(): void {
    if (pollInterval) return;

    // Every watcher (the root plus each per-cwd subdir) feeds one
    // coalescing queue: an active turn appends to the transcript
    // continuously, so scanning per event would re-walk the whole tree
    // many times per second.
    const onEvent = () => scheduleScan();
    const root = sessionsRootOf();
    watchDir(root, onEvent);
    // fs.watch is non-recursive on Windows/Linux and transcripts live one
    // level down in per-cwd subdirs — watch those too. A brand-new subdir
    // (first session in a project) is picked up by the polling fallback.
    let subdirs: string[] = [];
    try { subdirs = fs.readdirSync(root); } catch { /* no root yet */ }
    for (const d of subdirs) watchDir(path.join(root, d), onEvent);

    // Look the window up per tick — a window destroyed and recreated (macOS
    // dock re-activate) must not kill the polling fallback for good.
    pollInterval = setInterval(() => {
      if (watchedSessions.size === 0) return;
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) runScan();
    }, POLL_INTERVAL_MS);
  }

  function watchDir(dir: string, onEvent: () => void): void {
    try {
      watchers.push(fs.watch(dir, (event) => {
        if (event === 'rename') dirtyDirectories.add(dir);
        onEvent();
      }));
    } catch {
      // Directory might not exist; polling covers it
    }
  }

  function stop(): void {
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.length = 0;
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    lastScanAt = 0;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    watchedSessions.clear();
    histories.clear();
    directoryCache.clear();
    dirtyDirectories.clear();
    assignedIds.clear();
  }

  return { start, registerPending, unregister, stop };
}
