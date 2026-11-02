import { BoundedEventReader } from './bounded-event-reader';
import { FSWatcher } from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { isWin, pythonBin } from './platform';
import { STDIN_UTF8_GUARD } from '../shared/python';
import type { CliSessionStatus } from '../shared/types';
import { readProviderFileWindow } from './hosts/provider-fs';
import { evictOldest } from './bounded-map';

/**
 * The status-data directory (the watcher's root; every `.status`/`.cost`/
 * `.name`/… file lives here).
 *
 * POSIX suffixes the uid: `os.tmpdir()` is `/tmp` — world-writable and
 * shared by every user. A fixed `finevibe` name under mode 0700 means the
 * first user to launch FineVibe owns the directory and every other user's
 * hooks then fail to create/write their status files — cost, status, and
 * titles die silently, with no diagnostic beyond missing data. The uid
 * suffix gives each user a private, still-0700 directory. Windows keeps the
 * bare name: per-user %TEMP% already isolates users.
 *
 * Every producer/consumer (watcher, mkdirs, cleanup, and the Python
 * generators that embed the path at generation time) routes through this
 * helper via `STATUS_DIR` — one definition, no drift.
 */
export function getStatusDir(): string {
  const uid = !isWin && typeof process.getuid === 'function' ? process.getuid() : undefined;
  return path.join(os.tmpdir(), uid === undefined ? 'finevibe' : `finevibe-${uid}`);
}
export const STATUS_DIR = getStatusDir();
export const SCRIPT_DIR = path.join(os.homedir(), '.finevibe', 'run');
const STATUSLINE_SCRIPT = path.join(SCRIPT_DIR, isWin ? 'statusline.cmd' : 'statusline.sh');

// Status files any provider may write into STATUS_DIR, keyed by FineVibe's
// session id. This array drives cleanup, polling and resync generically.
//
// `.name` is a provider-facing channel, not Claude-private: write
// `{"name": "…", "session_id": "…"}` and the tab adopts that title. Claude
// fills it from its statusLine payload (see buildStatusLinePython); another
// provider can populate it from any source, the way codex-session-watcher.ts
// already writes `.sessionid` without hooks.
const KNOWN_EXTENSIONS = ['.status', '.sessionid', '.cost', '.name', '.toolfailure', '.events', '.subagents'];
let watcher: FSWatcher | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
const lastMtimes = new Map<string, number>();

/**
 * Push lane (row 18). STATUS_DIR changes arrive on the chokidar watcher, are
 * coalesced per filename over `PUSH_DEBOUNCE_MS`, then run through the SAME
 * `handleFileChange` the old sweep drove.
 *
 * The window exists because ONE logical write is several raw fs events: the
 * POSIX hooks echo to `<sid>.status.tmp` and `mv` it in (an event for the temp
 * name and one for the final name), and an in-place `open(w)` + write + close
 * reports modify *and* close. Before the window every write reached the
 * renderer twice. Within one window a filename is processed once, on its final
 * content; an append-only `.events` burst is read in a single pass (the reader
 * is offset-based, so coalescing loses no records).
 */
const pendingPushes = new Set<string>();
let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let rearmTimer: ReturnType<typeof setTimeout> | null = null;
let pushWindowWin: BrowserWindow | null = null;
const eventReaders = new Map<string, BoundedEventReader>();
const eventContinuations = new Map<string, ReturnType<typeof setTimeout>>();
const knownSessionIds = new Set<string>();

/**
 * Sessions whose provider runs on a registry host (per-host providers plan
 * §3): their status sidecar lives on the HOST (`~/.finevibe/run/<id>.status`,
 * written by the enrollment-merged host hooks), not in the local STATUS_DIR.
 * The poll loop reads them through the sftp seam — no fs.watch exists for a
 * remote file. Bounded by the session registry: every entry is added at PTY
 * spawn (registerRemoteStatus) and dropped by unregisterSession/cleanupAll,
 * exactly like knownSessionIds.
 */
const remoteStatuses = new Map<string, { hostId: string; last: string | null }>();

/**
 * Per-host cooldown after a failed remote read (audit T2 #2): a down host
 * costs one connect timeout, then goes quiet for REMOTE_HOST_COOLDOWN_MS —
 * every session on it used to re-pay the full connect budget every tick
 * (N sessions × ~11 s), starving the local STATUS_DIR sweep. FIFO-capped
 * at REMOTE_HOST_COOLDOWN_MAX (registry-scale; hosts churn far less than
 * sessions) and cleared wholesale by cleanupAll.
 */
const remoteHostCooldown = new Map<string, number>();
const REMOTE_HOST_COOLDOWN_MS = 30_000;
const REMOTE_HOST_COOLDOWN_MAX = 32;

function armHostCooldown(hostId: string): void {
  if (!remoteHostCooldown.has(hostId)) evictOldest(remoteHostCooldown, REMOTE_HOST_COOLDOWN_MAX - 1);
  remoteHostCooldown.set(hostId, Date.now() + REMOTE_HOST_COOLDOWN_MS);
}

export function registerSession(sessionId: string): void {
  knownSessionIds.add(sessionId);
}

/** Register a session whose status sidecar lives on `hostId` (remote poll). */
export function registerRemoteStatus(sessionId: string, hostId: string): void {
  registerSession(sessionId);
  // Same filename-injection gate as the local writers: the id becomes a
  // path segment in the sidecar read.
  if (!UI_SESSION_ID_RE.test(sessionId)) {
    console.warn(`Refusing remote status poll for unsafe session id: ${JSON.stringify(sessionId)}`);
    return;
  }
  remoteStatuses.set(sessionId, { hostId, last: null });
}

let statusDirEnsured = false;
/**
 * Create STATUS_DIR once per process. The write helpers below run on every
 * status/title/id change; re-mkdir-ing an already-existing dir each time
 * is a wasted syscall. installStatusLineScript/startWatching still mkdir
 * directly (they own their own one-time setup).
 */
function ensureStatusDir(): void {
  if (statusDirEnsured) return;
  fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  statusDirEnsured = true;
}

/**
 * A UI session id becomes a filename inside STATUS_DIR, so it must not be able
 * to escape that directory. Ids are `crypto.randomUUID()` in practice, so this
 * accepts exactly that shape with a small permissive margin, and rejects
 * anything carrying a path separator or `..`.
 *
 * An unsafe id is logged and skipped rather than thrown: every caller runs
 * inside a watcher or IPC callback, where an exception would take the status
 * pipeline down for every other session.
 */
const UI_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function statusFilePath(uiSessionId: string, ext: string): string | null {
  if (!UI_SESSION_ID_RE.test(uiSessionId)) {
    console.warn(
      `Refusing to write .${ext} for unsafe session id: ${JSON.stringify(uiSessionId)}`
    );
    return null;
  }
  return path.join(STATUS_DIR, `${uiSessionId}.${ext}`);
}

/**
 * Record the CLI session id a UI session resolved to. The STATUS_DIR watcher
 * forwards it as `session:cliSessionId`. Used by providers without hooks
 * (codex, pi) that discover the id from on-disk artifacts.
 */
export function writeCliSessionId(uiSessionId: string, cliSessionId: string): void {
  const filePath = statusFilePath(uiSessionId, 'sessionid');
  if (filePath === null) return;
  ensureStatusDir();
  fs.writeFileSync(filePath, cliSessionId);
}

/**
 * Provider-facing title channel (the same `.name` file Claude's statusLine
 * writes): the STATUS_DIR watcher forwards it as `session:sessionName`.
 * `cliSessionId` lets the renderer drop a title left over from a cleared
 * conversation. Callers write only when the title actually changed.
 */
export function writeCliSessionName(uiSessionId: string, name: string, cliSessionId: string): void {
  const filePath = statusFilePath(uiSessionId, 'name');
  if (filePath === null) return;
  ensureStatusDir();
  fs.writeFileSync(filePath, JSON.stringify({ name, session_id: cliSessionId }));
}

/**
 * Provider-facing status channel (the same `.status` file Claude's hooks
 * write): the STATUS_DIR watcher forwards it as `session:hookStatus`. Used
 * by providers without hooks (omp, pi) that derive status from their
 * transcript. Callers write only the `CliSessionStatus` values the renderer
 * understands; the poller re-emits on every transcript append (a repeated
 * identical status is a no-op in the renderer, and the re-emit is what
 * refreshes a post-interrupt 'waiting' when the user submits a new prompt).
 */
export function writeStatus(uiSessionId: string, status: CliSessionStatus): void {
  const filePath = statusFilePath(uiSessionId, 'status');
  if (filePath === null) return;
  ensureStatusDir();
  fs.writeFileSync(filePath, `Transcript:${status}`);
}


export function unregisterSession(sessionId: string): void {
  knownSessionIds.delete(sessionId);
  remoteStatuses.delete(sessionId);
}

function isKnownExtension(filename: string): boolean {
  return KNOWN_EXTENSIONS.some(ext => filename.endsWith(ext));
}

export function getStatusLineScriptPath(): string {
  return STATUSLINE_SCRIPT;
}

/**
 * Body of the statusLine helper, shared by the POSIX and Windows branches.
 *
 * Claude invokes the statusLine command on every render, piping it the session
 * JSON on stdin. We extract `cost`, `context_window`, `session_id` and
 * `session_name` and drop them into STATUS_DIR for the watcher to pick up.
 * The `.name` payload carries the CLI session id alongside the title so a
 * stale title can be told apart from the current conversation's.
 *
 * `.sessionid` and `.name` both go through `write_if_changed`, which writes only
 * when the content differs (and removes the file for an empty blob — how a
 * cleared `.name` is retracted; `.sessionid` never passes one). The statusLine
 * fires on every render, and each write reaches the renderer as an IPC that ends
 * in a `persist()` plus a full `renderLayout()` — which used to detach and
 * re-insert the terminal pane many times a second, blurring the in-pane find bar
 * and breaking mouse selection. `.cost` is exempt: its payload genuinely changes
 * on nearly every render, and it lands on a persist-only path with no re-render.
 *
 * Installed as a real `.py` file on every platform and invoked by path, never
 * inlined into the shell command — see the module docstring in
 * `hook-commands.ts` for why inlining Python is fragile here.
 *
 * `statusDir` is embedded via `JSON.stringify`, whose escapes (`\\`, `\"`,
 * `\uXXXX`) are all valid Python ones. A raw literal would break on an
 * apostrophe in the path — e.g. a Windows user named O'Brien — and a
 * SyntaxError here silently kills cost, context, sessionid and name at once.
 */
export function buildStatusLinePython(statusDir: string): string {
  return `import sys,json,os
${STDIN_UTF8_GUARD}try:
    d=json.load(sys.stdin)
except:
    sys.exit(0)
sid=os.environ.get('CLAUDE_IDE_SESSION_ID','')
if not sid:
    sys.exit(0)
status_dir=${JSON.stringify(statusDir)}
cost=d.get('cost',{})
ctx=d.get('context_window',{})
model=d.get('model',{}).get('display_name','')
if cost or ctx or model:
    payload={'cost':cost,'context_window':ctx}
    if model:
        payload['model']=model
    with open(os.path.join(status_dir,sid+'.cost'),'w') as f:
        json.dump(payload,f)
def write_if_changed(path,blob):
    prev=''
    try:
        with open(path) as f:
            prev=f.read()
    except:
        pass
    if prev==blob:
        return
    try:
        if blob:
            with open(path,'w') as f:
                f.write(blob)
        else:
            os.remove(path)
    except:
        pass
claude_sid=d.get('session_id','')
if claude_sid:
    write_if_changed(os.path.join(status_dir,sid+'.sessionid'),claude_sid)
name=str(d.get('session_name') or '').strip()
write_if_changed(os.path.join(status_dir,sid+'.name'),json.dumps({'name':name,'session_id':claude_sid}) if name else '')
`;
}

export function installStatusLineScript(): void {
  fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SCRIPT_DIR, { recursive: true, mode: 0o700 });

  const pyPath = path.join(SCRIPT_DIR, 'statusline.py');
  fs.writeFileSync(pyPath, buildStatusLinePython(STATUS_DIR), { mode: 0o755 });

  // Use forward slashes — backslashes inside double-quoted .cmd strings can
  // interfere with cmd.exe's >> redirection parsing on some Windows versions.
  const logPath = `${STATUS_DIR.replace(/\\/g, '/')}/statusline.log`;
  const script = isWin
    ? `@echo off\r\n${pythonBin} -X utf8 "${pyPath}" 2>>"${logPath}"\r\n`
    : `#!/bin/sh\n${pythonBin} "${pyPath}" 2>>"${logPath}"\n`;

  fs.writeFileSync(STATUSLINE_SCRIPT, script, { mode: 0o755 });
}

function extractSessionId(filename: string): string {
  if (filename.endsWith('.toolfailure')) {
    const base = filename.replace('.toolfailure', '');
    const lastDash = base.lastIndexOf('-');
    if (lastDash === -1) return base;
    return base.slice(0, lastDash);
  }
  for (const ext of KNOWN_EXTENSIONS) {
    if (filename.endsWith(ext)) return filename.slice(0, -ext.length);
  }
  return '';
}

function handleFileChange(win: BrowserWindow, filename: string): void {
  const extractedId = extractSessionId(filename);
  if (extractedId && !knownSessionIds.has(extractedId)) return;

  // In-flight subagent counter — hook-internal only, never forwarded to the
  // renderer. Included in KNOWN_EXTENSIONS solely for cleanup.
  if (filename.endsWith('.subagents')) return;

  if (filename.endsWith('.status')) {
    const sessionId = filename.replace('.status', '');
    const filePath = path.join(STATUS_DIR, filename);

    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      // Format: "HookEvent:status" (e.g. "PostToolUse:working") or legacy plain status
      const colonIdx = raw.indexOf(':');
      const hookName = colonIdx === -1 ? '' : raw.slice(0, colonIdx);
      const content = colonIdx === -1 ? raw : raw.slice(colonIdx + 1);
      if (content === 'working' || content === 'waiting' || content === 'completed' || content === 'input') {
        if (!win.isDestroyed()) {
          win.webContents.send('session:hookStatus', sessionId, content, hookName);
        }
      } else if (content) {
        // Out-of-set status (a future CliSessionStatus member the renderer
        // has not learned yet): dropping it silently made the tab sit on a
        // stale status with no trace. Log the drop.
        console.warn(`[hook-status] Dropped unknown session status "${content}" for session ${sessionId}`);
      }
    } catch {
      // File may have been deleted between watch event and read
    }
  } else if (filename.endsWith('.sessionid')) {
    const sessionId = filename.replace('.sessionid', '');
    const filePath = path.join(STATUS_DIR, filename);

    try {
      const cliSessionId = fs.readFileSync(filePath, 'utf-8').trim();
      if (cliSessionId && !win.isDestroyed()) {
        win.webContents.send('session:cliSessionId', sessionId, cliSessionId);
      }
    } catch {
      // File may have been deleted between watch event and read
    }
  } else if (filename.endsWith('.cost')) {
    const sessionId = filename.replace('.cost', '');
    const filePath = path.join(STATUS_DIR, filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const costData = JSON.parse(content);
      if (!win.isDestroyed()) {
        win.webContents.send('session:costData', sessionId, costData);
      }
    } catch {
      // File may have been deleted or contain invalid JSON
    }
  } else if (filename.endsWith('.name')) {
    const sessionId = extractedId;
    const filePath = path.join(STATUS_DIR, filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const { name, session_id: cliSessionId } = JSON.parse(content);
      if (typeof name === 'string' && name && !win.isDestroyed()) {
        // cliSessionId lets the renderer drop a title left over from a
        // conversation that has since been cleared — resyncAllSessions
        // re-reads every file, so a stale .name would otherwise re-title
        // the freshly reset tab.
        win.webContents.send(
          'session:sessionName',
          sessionId,
          name,
          typeof cliSessionId === 'string' ? cliSessionId : '',
        );
      }
    } catch {
      // File may have been deleted or contain invalid JSON (partial write)
    }
  } else if (filename.endsWith('.toolfailure')) {
    const sessionId = extractedId;
    const filePath = path.join(STATUS_DIR, filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      const data = JSON.parse(content);
      if (!win.isDestroyed()) {
        win.webContents.send('session:toolFailure', sessionId, data);
      }
    } catch {
      // File may have been deleted or contain invalid JSON
    }
    // Always attempt cleanup — each failure is a one-shot event
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    // PA-23: the file is gone, so its tracked mtime is dead weight — the poll
    // re-adds it only if the name comes back.
    lastMtimes.delete(filename);
  } else if (filename.endsWith('.events')) {
    const sessionId = filename.replace('.events', '');
    const filePath = path.join(STATUS_DIR, filename);
    // Watch notifications and continuations share a reader and never duplicate offsets.
    let reader = eventReaders.get(sessionId);
    if (!reader) { reader = new BoundedEventReader(); eventReaders.set(sessionId, reader); }
    try {
      const { events, more } = reader.read(filePath);
      if (events.length && !win.isDestroyed()) win.webContents.send('session:inspectorEvents', sessionId, events);
      if (more && !eventContinuations.has(sessionId) && !win.isDestroyed()) {
        eventContinuations.set(sessionId, setTimeout(() => {
          eventContinuations.delete(sessionId);
          if (knownSessionIds.has(sessionId) && !win.isDestroyed()) handleFileChange(win, filename);
        }, 0));
      }
    } catch { /* File removed or temporarily unreadable. */ }
  }
}

let pollInFlight = false;

/**
 * Lane cadences (row 18: the STATUS_DIR lane is push-first).
 *
 * `PUSH_DEBOUNCE_MS` — coalescing window of the push lane (see pendingPushes).
 * Normal-case delivery latency is fs-notification latency (ms) + this window.
 *
 * `SAFETY_NET_POLL_MS` — the SLOW sweep that catches what a push lane
 * structurally cannot see: dropped inotify handles (EMFILE exhaustion, and the
 * up-to-5 s gap while a dead watcher is rebuilt), a STATUS_DIR on a network
 * mount where native notifications stop reporting, and a write whose mtime
 * lands in the same tick as the previous write on a coarse-mtime filesystem
 * (1 s tmpfs, HFS+) — the case `statAndDeliver`'s `!==` gate documents.
 * 30 s is the DOCUMENTED worst-case staleness on those paths, never the normal
 * path. It costs 15x less than the 2 s sweep it replaces and sits far inside
 * the only latency number the status contract pins: the renderer's 10 min
 * `STOP_FALLBACK_MS` completion backstop (HOOKS.md), keyed on renderer silence
 * rather than on file freshness.
 *
 * `WATCHER_DOWN_POLL_MS` — PA-09 fallback: with NO watcher there is no push
 * lane, so the sweep goes back to the fast 2 s cadence until the restart lands.
 *
 * The sweep is skipped outright while no session is registered, and the
 * per-file stats run in bounded batches.
 */
export const PUSH_DEBOUNCE_MS = 150;
export const SAFETY_NET_POLL_MS = 30_000;
export const WATCHER_DOWN_POLL_MS = 2_000;
/** Remote sidecar cadence (audit T2 #2 lane): the 30 s local safety net must
 * NOT pace the remote sweep — pre-row-18 the sidecar kicked every sweep tick
 * (2 s poll) behind a 15 s per-host cooldown; 30 s was a silent 2x regression
 * (review a922ffa0). Its own timer, same 15 s effective rate. */
export const REMOTE_SIDECAR_POLL_MS = 15_000;
const STAT_CONCURRENCY = 16;
let pollMs = SAFETY_NET_POLL_MS;

async function pollForChanges(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  if (pollInFlight) return;
  // PA-09: with an empty registry `handleFileChange` drops every file, so the
  // readdir is pure waste. An idle app now touches STATUS_DIR zero times —
  // docs/performance.md already claimed every poller "is a no-op while its
  // registry is empty"; for this one the claim was false.
  if (knownSessionIds.size === 0) return;
  // (Row 18 review a922ffa0: the sidecar kick moved OUT of this tick — it
  // rides REMOTE_SIDECAR_POLL_MS on its own timer so the 30 s safety net does
  // not halve the remote cadence. It never shared work with this sweep beyond
  // the tick, and still runs on its own in-flight flag (audit T2 #2).)
  pollInFlight = true;

  try {
    const files = await fs.promises.readdir(STATUS_DIR);
    // PA-23 sweep: drop tracked mtimes for files that disappeared. `.name` is
    // retracted on /clear and every extension is unlinked on release; without
    // this the map only ever shrank through the two targeted deletes.
    const present = new Set(files);
    for (const filename of lastMtimes.keys()) {
      if (!present.has(filename)) lastMtimes.delete(filename);
    }
    const names = files.filter(isKnownExtension);
    // The loop used to `await stat` one file at a time: 50 tabs × 7
    // extensions ≈ 350 sequential round trips per tick. Stats are independent,
    // so they run in batches (bounded, so a huge dir can't open 10k fds).
    for (let i = 0; i < names.length; i += STAT_CONCURRENCY) {
      await Promise.all(
        names.slice(i, i + STAT_CONCURRENCY).map((filename) => statAndDeliver(win, filename))
      );
    }
  } catch {
    // Directory may not exist yet
  } finally {
    pollInFlight = false;
  }
}

/** One file's share of a poll: stat it, and deliver only on an mtime change. */
async function statAndDeliver(win: BrowserWindow, filename: string): Promise<void> {
  const filePath = path.join(STATUS_DIR, filename);
  try {
    const stat = await fs.promises.stat(filePath);
    const mtime = stat.mtimeMs;
    const prev = lastMtimes.get(filename);
    // `!==`, not `>`: `.name` is deleted and rewritten on /clear, and a
    // recreated file can carry a coarser, non-increasing timestamp.
    // `prev === undefined` means the file appeared between polls (or the
    // poll loop just started) — process it like any other change; a file
    // created and last-written inside one interval would otherwise be
    // recorded and never delivered. The poll cadence is the debounce.
    if (prev !== mtime) {
      lastMtimes.set(filename, mtime);
      handleFileChange(win, filename);
    }
  } catch {
    // File may have been deleted between readdir and stat
  }
}

/** One remote sweep: sequential per session (one shared connection), with
 * the per-host cooldown deciding participation. Never awaited by the local
 * sweep — see pollForChanges. */
let remoteSweepInFlight = false;
async function sweepRemoteStatuses(win: BrowserWindow): Promise<void> {
  if (remoteSweepInFlight || win.isDestroyed()) return;
  remoteSweepInFlight = true;
  try {
    const now = Date.now();
    for (const [sessionId, entry] of remoteStatuses) {
      const until = remoteHostCooldown.get(entry.hostId);
      if (until !== undefined) {
        if (until > now) continue;
        remoteHostCooldown.delete(entry.hostId); // expired: this tick probes again
      }
      let raw: string | null;
      try {
        // Windowed tail read (audit T2 #7): the payload is `<event>:<status>`
        // — a fat sidecar file must never be slurped whole.
        raw = await readProviderFileWindow(entry.hostId, `.finevibe/run/${sessionId}.status`, 4096, { fromEnd: true });
      } catch {
        // Connect/op failure: the whole host goes quiet for the cooldown
        // window (every session on it shares the same dead connection).
        armHostCooldown(entry.hostId);
        continue;
      }
      if (raw === null) continue;
      const content = raw.trim();
      if (content === entry.last) continue;
      entry.last = content;
      deliverRemoteStatus(win, sessionId, content);
    }
  } finally {
    remoteSweepInFlight = false;
  }
}

/** Same content gate as the local `.status` branch of handleFileChange. */
function deliverRemoteStatus(win: BrowserWindow, sessionId: string, raw: string): void {
  const colonIdx = raw.indexOf(':');
  const hookName = colonIdx === -1 ? '' : raw.slice(0, colonIdx);
  const content = colonIdx === -1 ? raw : raw.slice(colonIdx + 1);
  if (content === 'working' || content === 'waiting' || content === 'completed' || content === 'input') {
    if (!win.isDestroyed()) {
      win.webContents.send('session:hookStatus', sessionId, content, hookName);
    }
  } else if (content) {
    console.warn(`[hook-status] Dropped unknown remote session status "${content}" for session ${sessionId}`);
  }
}

function startPolling(win: BrowserWindow): void {
  stopPolling();
  pollMs = watcher ? SAFETY_NET_POLL_MS : WATCHER_DOWN_POLL_MS;
  pollInterval = setInterval(() => { void pollForChanges(win); }, pollMs);
}

/**
 * Re-arm the interval at the cadence the watcher's state implies (PA-09).
 * Deliberately does NOT go through stopPolling: the mtime bookkeeping must
 * survive a cadence switch, or every file would be re-delivered at once.
 */
let sidecarInterval: ReturnType<typeof setInterval> | null = null;

function startSidecarLane(win: BrowserWindow): void {
  stopSidecarLane();
  sidecarInterval = setInterval(() => {
    if (win.isDestroyed() || remoteStatuses.size === 0) return;
    void sweepRemoteStatuses(win);
  }, REMOTE_SIDECAR_POLL_MS);
  sidecarInterval.unref?.();
}

function stopSidecarLane(): void {
  if (sidecarInterval) clearInterval(sidecarInterval);
  sidecarInterval = null;
}

function applyPollCadence(win: BrowserWindow): void {
  const want = watcher ? SAFETY_NET_POLL_MS : WATCHER_DOWN_POLL_MS;
  if (!pollInterval || want === pollMs) return;
  pollMs = want;
  clearInterval(pollInterval);
  pollInterval = setInterval(() => { void pollForChanges(win); }, pollMs);
}

function stopPolling(): void {
  stopSidecarLane();
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  lastMtimes.clear();
}

/** Remote sidecar bookkeeping lives entirely in unregisterSession (the status
 * file itself is the host's own state; unenroll cleans the sidecar dir). */

/**
 * Push-lane entry point: one watch event for one STATUS_DIR filename.
 *
 * Trailing coalescing (the `file-watcher.ts` idiom): the event's filename is
 * queued and `PUSH_DEBOUNCE_MS` after the LAST event in a burst, each queued
 * filename runs through `handleFileChange` once, on its final content. The
 * flush is per filename, not per renderer frame, so a burst across 30 files
 * costs 30 deliveries — the coalescing is what kills the tmp+mv double event,
 * not a way to skip files.
 */
function queuePush(win: BrowserWindow, changedPath: string): void {
  const filename = path.basename(changedPath);
  // Cheap gate before the queue: `.status.tmp` (the POSIX atomic-write temp
  // name) and any other stray file matches no KNOWN_EXTENSIONS, so it must not
  // cost a timer at all. `.subagents` DOES match and is queued on purpose —
  // handleFileChange suppresses it before reading, which is the contract the
  // status-mapping suite pins.
  if (!isKnownExtension(filename)) return;
  pushWindowWin = win;
  pendingPushes.add(filename);
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(flushPush, PUSH_DEBOUNCE_MS);
}

function flushPush(): void {
  pushDebounceTimer = null;
  const win = pushWindowWin;
  // Destroyed window: KEEP the queue (bounded by filename count) — the next
  // push from the new window flushes it and the safety-net sweep covers the
  // gap. Consuming it here would silently drop the delivery (a922ffa0).
  if (!win || win.isDestroyed()) return;
  const names = [...pendingPushes];
  pendingPushes.clear();
  for (const filename of names) {
    handleFileChange(win, filename);
    // Record what the push delivered (a922ffa0): without this the sweep's
    // mtime gate sees a stale prev and re-delivers the same content. A write
    // landing between delivery and this stat is push-delivered by its own
    // event, so recording the post-delivery stat cannot strand a change.
    void fs.promises
      .stat(path.join(STATUS_DIR, filename))
      .then((st) => { lastMtimes.set(filename, st.mtimeMs); })
      .catch(() => { /* vanished between delivery and stat: PA-23 sweep drops it */ });
  }
}

/** Teardown: a flush armed inside the debounce window must not fire after quit
 * and re-deliver into a destroyed window (or recreate STATUS_DIR). */
function clearPushLane(): void {
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = null;
  pendingPushes.clear();
  pushWindowWin = null;
}

function closeWatcher(): void {
  if (!watcher) return;
  const w = watcher;
  watcher = null;
  void w.close().catch(() => { /* already closed */ });
}

function restartWatcher(win: BrowserWindow): void {
  closeWatcher();
  clearPushLane();

  fs.mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 });

  // Directory-granular watch, the `file-watcher.ts` idiom: watching the DIR
  // (depth 0, non-recursive) rather than file inodes survives the atomic
  // tmp+mv the POSIX status hooks use — an inode watch dies on the rename.
  const w = new FSWatcher({
    ignoreInitial: true, // existing files are replayed by resyncAllSessions
    depth: 0,            // STATUS_DIR is flat: one file per session per channel
    atomic: true,        // collapse write-temp + rename into a single change
    ignorePermissionErrors: true,
    persistent: true,
  });
  w.on('all', (_eventType, changedPath) => queuePush(win, changedPath));
  // Every watcher in main attaches 'error'; without it an emitted
  // FSWatcher error (EMFILE, unmounted volume) is an uncaught exception
  // that takes down the process — and with it every live PTY.
  w.on('error', () => {
    void w.close().catch(() => { /* already closed */ });
    // Only drop the slot when this watcher is still the incumbent.
    if (watcher === w) watcher = null;
    // The safety-net sweep keeps the pipeline alive; restart the watch for
    // next time. PA-09: with no push lane to lean on, the sweep goes back to
    // its fast 2 s cadence until the restart below lands.
    applyPollCadence(win);
    // Tracked (a922ffa0): an untracked re-arm survived cleanupAll and rebuilt
    // the watcher — and STATUS_DIR — after quit.
    if (rearmTimer) clearTimeout(rearmTimer);
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      if (!watcher && !win.isDestroyed()) restartWatcher(win);
    }, 5000);
    rearmTimer.unref?.();
  });
  watcher = w;
  w.add(STATUS_DIR);

  startPolling(win);
  startSidecarLane(win);
}

export function resyncAllSessions(win: BrowserWindow): void {
  if (win.isDestroyed()) return;

  try {
    const files = fs.readdirSync(STATUS_DIR);
    for (const filename of files) {
      if (isKnownExtension(filename)) {
        handleFileChange(win, filename);
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

export function restartAndResync(win: BrowserWindow): void {
  restartWatcher(win);
  resyncAllSessions(win);
}

export function startWatching(win: BrowserWindow): void {
  restartWatcher(win);
}

export function cleanupSessionStatus(sessionId: string): void {
  // sessionId arrives from the renderer (session:release); the same guard the
  // writers use keeps `..`-shaped ids from unlinking outside STATUS_DIR.
  if (!UI_SESSION_ID_RE.test(sessionId)) {
    console.warn(`Refusing to clean up unsafe session id: ${JSON.stringify(sessionId)}`);
    return;
  }
  for (const ext of KNOWN_EXTENSIONS) {
    const filename = `${sessionId}${ext}`;
    lastMtimes.delete(filename);
    try {
      fs.unlinkSync(path.join(STATUS_DIR, filename));
    } catch {
      // Already gone
    }
  }
  // P2-20: the toolfailure writer emits `${sessionId}-${6 random}.toolfailure`,
  // never the plain name the loop above covers - a record pending at session
  // close used to survive until the quit-time sweep (or forever after a crash,
  // where resyncAllSessions replays it into a restored tab). Enumerate and
  // unlink the suffixed variants too.
  try {
    for (const name of fs.readdirSync(STATUS_DIR)) {
      if (name.startsWith(`${sessionId}-`) && name.endsWith('.toolfailure')) {
        lastMtimes.delete(name);
        try {
          fs.unlinkSync(path.join(STATUS_DIR, name));
        } catch {
          // Raced with another unlink
        }
      }
    }
  } catch {
    // Directory gone - the plain-name unlinks above already ENOENTed.
  }
  eventReaders.delete(sessionId);
  clearTimeout(eventContinuations.get(sessionId));
  eventContinuations.delete(sessionId);
  unregisterSession(sessionId);
}

export function cleanupAll(): void {
  for (const timer of eventContinuations.values()) clearTimeout(timer);
  eventContinuations.clear();
  eventReaders.clear();
  stopPolling();
  clearPushLane();
  knownSessionIds.clear();
  remoteStatuses.clear();
  remoteHostCooldown.clear();
  closeWatcher();
  cleanupDir(STATUS_DIR, isKnownExtension);
  // SCRIPT_DIR is intentionally kept — scripts are idempotent and reinstalled
  // on launch. Deleting them races with CLI processes that outlive the app.
}

function cleanupDir(dir: string, shouldUnlink: (filename: string) => boolean): void {
  try {
    for (const file of fs.readdirSync(dir)) {
      if (shouldUnlink(file)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* already gone */ }
      }
    }
    try { fs.rmSync(dir, { recursive: true }); } catch { /* may not be empty */ }
  } catch {
    // Directory may not exist
  }
}
