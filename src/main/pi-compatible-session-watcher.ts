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
 * to the live conversation instead of freezing on the pre-clear one.
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
  knownFiles: Set<string>;
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
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(file));
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(ts) ? null : ts;
}

// A CLI writes the transcript a few ms after the UI session registers; a
// candidate stamped older than this window (minus tolerance) is an external
// run in the same project and must not be adopted.
const ADOPTION_TOLERANCE_MS = 5_000;

export function createCompatibleSessionWatcher(
  sessionsRootOf: (configDir?: string) => string,
  options: CompatibleSessionWatcherOptions = {}
): CompatibleSessionWatcher {
  const watchedSessions = new Map<string, WatchedSession>();
  const assignedIds = new Set<string>();

  const watchers: fs.FSWatcher[] = [];
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  // Case-insensitive on Windows and macOS (both default to
  // case-insensitive filesystems): drive-letter and path-case differences
  // must not block the match.
  const caseInsensitive = isWin || isMac;

  function cwdMatches(a: string, b: string): boolean {
    return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  function snapshotExistingFiles(sessionsRoot: string): Set<string> {
    const known = new Set<string>();
    let dirs: string[];
    try { dirs = fs.readdirSync(sessionsRoot); } catch { return known; }
    for (const dir of dirs) {
      const dirPath = path.join(sessionsRoot, dir);
      let files: string[];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (f.endsWith('.jsonl')) known.add(path.join(dirPath, f));
      }
    }
    return known;
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
    assignedIds.add(cand.sessionId);
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

    // Group by sessions root: one walk + one header read per root per scan,
    // not one per watched session.
    const byRoot = new Map<string, Array<[string, WatchedSession]>>();
    for (const [uiId, p] of watchedSessions) {
      const root = sessionsRootOf(p.configDir);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push([uiId, p]);
    }

    const candidates: Candidate[] = [];
    for (const [root] of byRoot) {
      let dirs: string[];
      try { dirs = fs.readdirSync(root); } catch { continue; }
      for (const dir of dirs) {
        const dirPath = path.join(root, dir);
        let files: string[];
        try { files = fs.readdirSync(dirPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(dirPath, f);
          const header = readSessionHeaderSync(full);
          if (!header || typeof header.cwd !== 'string') continue;
          if (assignedIds.has(header.id)) continue;
          candidates.push({ file: full, sessionId: header.id, cwd: header.cwd, root, fileTs: filenameTimestampMs(full) });
        }
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
          && !p.knownFiles.has(cand.file)
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
    // the currently-adopted file and carry a parseable timestamp.
    for (const cand of candidates) {
      const candTs = cand.fileTs;
      if (candTs === null) continue;
      const matches = (byRoot.get(cand.root) ?? []).filter(
        ([uiId, p]) => p.adoptedFile
          && !taken.has(uiId)
          && cand.file !== p.adoptedFile
          && !p.knownFiles.has(cand.file)
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
      knownFiles: snapshotExistingFiles(sessionsRootOf(configDir)),
      registeredAt: Date.now(),
    });
  }

  function unregister(sessionId: string): void {
    watchedSessions.delete(sessionId);
  }

  function start(): void {
    if (pollInterval) return;

    const onEvent = () => {
      if (watchedSessions.size > 0) scanForNewSessions();
    };
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
      if (win && !win.isDestroyed()) scanForNewSessions();
    }, 2000);
  }

  function watchDir(dir: string, onEvent: () => void): void {
    try {
      watchers.push(fs.watch(dir, onEvent));
    } catch {
      // Directory might not exist; polling covers it
    }
  }

  function stop(): void {
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    watchers.length = 0;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    watchedSessions.clear();
    assignedIds.clear();
  }

  return { start, registerPending, unregister, stop };
}
