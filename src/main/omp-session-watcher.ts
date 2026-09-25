import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { writeCliSessionId } from './hook-status';
import { isWin, isMac } from './platform';
import { ompSessionsRoot, readFirstLineSync, parseSessionHeader } from './providers/omp-transcripts';

/**
 * OMP has no hook system to report session IDs back to the host app.
 * Instead, we watch the agent's sessions/ directory: every `omp` process
 * creates a new <ISO-timestamp>_<uuid>.jsonl whose first line is a session
 * header carrying the id and cwd. When a new file appears for a pending UI
 * session's project, we write a .sessionid file so hook-status picks it up
 * and forwards session:cliSessionId — the same channel Codex uses.
 */

interface PendingOmpSession {
  projectPath: string;
  configDir?: string;
  /** .jsonl files that already existed at registration — never candidates. */
  knownFiles: Set<string>;
}

interface Candidate {
  file: string;
  ompId: string;
  cwd: string;
  /** Sessions root the file was found under — a candidate only matches
   *  pending sessions registered against the same root (profile scoping). */
  root: string;
}

const pendingSessions = new Map<string, PendingOmpSession>();
const assignedOmpIds = new Set<string>();

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

function scanForNewSessions(): void {
  if (pendingSessions.size === 0) return;

  // Group by sessions root: one walk + one header read per root per scan,
  // not one per pending session.
  const byRoot = new Map<string, Array<[string, PendingOmpSession]>>();
  for (const [uiId, p] of pendingSessions) {
    const root = ompSessionsRoot(p.configDir);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push([uiId, p]);
  }

  const candidates: Candidate[] = [];
  for (const [root, group] of byRoot) {
    let dirs: string[];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const dir of dirs) {
      const dirPath = path.join(root, dir);
      let files: string[];
      try { files = fs.readdirSync(dirPath); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dirPath, f);
        const header = parseSessionHeader(readFirstLineSync(full));
        if (!header || typeof header.cwd !== 'string') continue;
        if (assignedOmpIds.has(header.id)) continue;
        candidates.push({ file: full, ompId: header.id, cwd: header.cwd, root });
      }
    }
  }
  // Filenames start with an ISO timestamp — sort by name so simultaneous
  // sessions in the same project pair in start order, not readdir order.
  candidates.sort((a, b) => a.file.localeCompare(b.file));

  const taken = new Set<string>();
  for (const cand of candidates) {
    const match = (byRoot.get(cand.root) ?? []).find(
      ([uiId, p]) => !taken.has(uiId) && !p.knownFiles.has(cand.file) && cwdMatches(p.projectPath, cand.cwd)
    );
    if (!match) continue;
    const [uiId] = match;
    try {
      writeCliSessionId(uiId, cand.ompId);
    } catch {
      // A failed write (disk full, permissions) must not crash the main
      // process from a timer/watch callback — keep the session pending so
      // the next scan retries the write.
      continue;
    }
    taken.add(uiId);
    assignedOmpIds.add(cand.ompId);
    pendingSessions.delete(uiId);
  }
}

export function registerPendingOmpSession(sessionId: string, projectPath: string, configDir?: string): void {
  pendingSessions.set(sessionId, {
    projectPath,
    configDir,
    knownFiles: snapshotExistingFiles(ompSessionsRoot(configDir)),
  });
}

export function unregisterOmpSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
}

export function startOmpSessionWatcher(): void {
  if (pollInterval) return;

  const onEvent = () => {
    if (pendingSessions.size > 0) scanForNewSessions();
  };
  const root = ompSessionsRoot();
  watchDir(root, onEvent);
  // fs.watch is non-recursive on Windows/Linux and transcripts live one
  // level down in per-cwd subdirs — watch those too. A brand-new subdir
  // (first OMP session in a project) is picked up by the polling fallback.
  let subdirs: string[] = [];
  try { subdirs = fs.readdirSync(root); } catch { /* no root yet */ }
  for (const d of subdirs) watchDir(path.join(root, d), onEvent);

  // Look the window up per tick — a window destroyed and recreated (macOS
  // dock re-activate) must not kill the polling fallback for good.
  pollInterval = setInterval(() => {
    if (pendingSessions.size === 0) return;
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

export function stopOmpSessionWatcher(): void {
  for (const w of watchers) {
    try { w.close(); } catch { /* already closed */ }
  }
  watchers.length = 0;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  pendingSessions.clear();
  assignedOmpIds.clear();
}
