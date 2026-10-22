import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { isWin } from './platform';
import { getFullPath, withUtf8Locale } from './pty-manager';
import type { AgentmemoryLog, AgentmemoryStatus } from '../shared/types';

/**
 * agentmemory is a shared singleton daemon (the iii engine + REST/MCP endpoints
 * on 3111/3112/3113/49134), consumed by every agent CLI, not just sessions
 * launched from FineVibe. FineVibe's role is Model-A: opportunistically
 * ENSURE it is running — start-if-absent, never own its shutdown. Killing it on
 * quit would sever memory for agents run outside FineVibe.
 *
 * The health endpoint (3113 Viewer) is the canonical liveness signal; 3111 is
 * MCP/StreamableHTTP-only (no REST health route). Version pinning is
 * agentmemory's own responsibility (it self-selects its pinned engine on start);
 * FineVibe must NOT hardcode a required engine version.
 */

const PROBE_URL = 'http://127.0.0.1:3113/health';
// Same IPv4 literal as PROBE_URL: probe and console can never disagree over
// localhost/::1 resolution.
export const CONSOLE_URL = 'http://127.0.0.1:3113';

/**
 * Where the detached daemon's console output is captured. The daemon inherits
 * this file as its stdout/stderr, so it is the only record of a cold-boot
 * failure (the app never keeps a pipe to a detached child). Tailed by the
 * agentmemory console view.
 */
export function getAgentmemoryLogPath(): string {
  return path.join(app.getPath('userData'), 'agentmemory.log');
}

const PROBE_TIMEOUT_MS = 2000;
// agentmemory self-installs its pinned engine on first start (a download), so a
// cold boot can take tens of seconds. Poll up to this budget before giving up.
const START_POLL_MS = 1000;
const START_ATTEMPTS = 30;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Unique engine version(s) advertised by the daemon's workers, e.g. ["0.11.2"]. */
function extractEngineVersions(payload: unknown): string[] {
  const workers = (payload as { health?: { workers?: Array<{ version?: unknown }> } })?.health?.workers;
  if (!Array.isArray(workers)) return [];
  const versions = workers
    .map((w) => (typeof w?.version === 'string' ? w.version : undefined))
    .filter((v): v is string => Boolean(v));
  return [...new Set(versions)];
}

/**
 * Probe the daemon. `running` is true on any HTTP response (the daemon is up);
 * a thrown fetch (connection refused / DNS / timeout) means absent. Non-200
 * responses still count as running — the daemon is reachable, and its health
 * detail is surfaced for the UI.
 */
export async function probeAgentmemory(): Promise<AgentmemoryStatus> {
  let res: Response;
  try {
    res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return { running: false, consoleUrl: CONSOLE_URL };
  }
  if (!res.ok) {
    return { running: true, consoleUrl: CONSOLE_URL, detail: `http ${res.status}` };
  }
  const payload = await res.json().catch(() => null);
  const top = payload as { version?: unknown; health?: { status?: unknown } } | null;
  return {
    running: true,
    consoleUrl: CONSOLE_URL,
    serviceVersion: typeof top?.version === 'string' ? top.version : undefined,
    engineVersions: extractEngineVersions(payload),
    detail: typeof top?.health?.status === 'string' ? top.health.status : undefined,
  };
}

/**
 * PA-33: the daemon inherits `agentmemory.log` append-mode and nothing ever
 * truncates it — it grew across every restart forever. Rotate at spawn when
 * it exceeds 8 MiB: readers only ever tail ≤ 64 KiB from the current file
 * (`readAgentmemoryLog`), so renaming the old log to `.1` loses nothing
 * anyone reads; one rotation of history is kept.
 */
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

function rotateLogAtSpawn(): void {
  const logPath = getAgentmemoryLogPath();
  try {
    if (fs.statSync(logPath).size <= LOG_ROTATE_BYTES) return;
    // Windows `rename` throws on an existing destination, so drop the
    // previous rotation first. A failed rotation must never skip the spawn.
    fs.rmSync(`${logPath}.1`, { force: true });
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet (first launch) or rotation failed: the append-open creates it.
  }
}

/**
 * Start agentmemory as a detached, unref'd daemon that outlives the Electron
 * process. `.cmd` is a batch shim on Windows, so it must go through a shell.
 * `getFullPath()` resolves the live PATH (registry + login shell + ~/.local/bin)
 * so the daemon can find its pinned engine when launched from explorer.exe.
 *
 * stdout/stderr are handed the append-mode log fd so a cold-boot failure is
 * recoverable after the parent is gone; opening the log must never be a reason
 * to skip the spawn, so any failure there degrades to `stdio: 'ignore'`.
 *
 * `withUtf8Locale` supplies the charset a Finder/Dock-launched macOS app
 * never inherits (see the rationale on withUtf8Locale in pty-manager.ts).
 *
 * Dev caveat: on Windows, `npm start` inside Windows Terminal places the app
 * tree in a kill-on-close job — DETACHED_PROCESS detaches the console, not
 * the job, so closing the dev terminal kills the daemon. Production launch
 * via explorer.exe is jobless and unaffected.
 *
 * Exported for tests.
 */
export function spawnDetached(): boolean {
  let logFd: number | null = null;
  // C5R-04: the fd holder and its closer live outside the try so the outer
  // catch can release the fd when spawn() throws synchronously (bad cwd/env,
  // shell failure) — block-scoped here, every such throw leaked the log fd.
  let fdClosed = false;
  const closeLogFd = () => {
    if (logFd === null || fdClosed) return;
    fdClosed = true;
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
  };
  try {
    rotateLogAtSpawn();
    try {
      logFd = fs.openSync(getAgentmemoryLogPath(), 'a');
    } catch (err) {
      console.warn('[agentmemory] log open failed, spawning silent:', (err as Error).message);
    }
    // libuv dups the fd into the child during spawn, so the parent's copy is
    // dead weight the moment spawn() returns: left open it keeps the log
    // handle alive for the app's lifetime.
    const child = spawn('agentmemory', [], {
      detached: true,
      stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: isWin,
      shell: isWin,
      env: withUtf8Locale({ ...process.env, PATH: getFullPath() }),
    });
    closeLogFd();
    child.on('error', (err) => {
      closeLogFd();
      console.warn('[agentmemory] failed to spawn:', (err as Error).message);
    });
    child.unref();
    return true;
  } catch (err) {
    closeLogFd();
    console.warn('[agentmemory] spawn threw:', (err as Error).message);
    return false;
  }
}

/**
 * Ensure the daemon is running. No-op when already reachable; otherwise spawn
 * and poll the health endpoint for it to come up. Never kills an existing
 * engine (Model A). The returned status reflects the final observed state.
 * Concurrent callers share one in-flight run, so the launch auto-start and a
 * manual Start press can never double-spawn the daemon.
 */
let ensureInFlight: Promise<AgentmemoryStatus> | null = null;

export function ensureAgentmemoryRunning(): Promise<AgentmemoryStatus> {
  if (ensureInFlight) return ensureInFlight;
  const run = doEnsureAgentmemoryRunning().finally(() => {
    ensureInFlight = null;
  });
  ensureInFlight = run;
  return run;
}

async function doEnsureAgentmemoryRunning(): Promise<AgentmemoryStatus> {
  const initial = await probeAgentmemory();
  if (initial.running) return initial;

  if (!spawnDetached()) {
    return { running: false, consoleUrl: CONSOLE_URL, detail: 'spawn-failed' };
  }

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    await sleep(START_POLL_MS);
    const probed = await probeAgentmemory();
    if (probed.running) return probed;
  }
  return { running: false, consoleUrl: CONSOLE_URL, detail: 'start-timeout' };
}

/**
 * Read the tail of the daemon log for the console view. A missing/unreadable
 * file is not an error — it just means nothing has been captured yet (the
 * daemon is usually started by another agent CLI, which never writes here).
 */
export async function readAgentmemoryLog(tailBytes = 64 * 1024): Promise<AgentmemoryLog> {
  const logPath = getAgentmemoryLogPath();
  try {
    const handle = await fs.promises.open(logPath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return { path: logPath, content: decodeTail(buffer) };
    } finally {
      await handle.close();
    }
  } catch (err) {
    console.warn('[agentmemory] log read failed:', (err as Error).message);
    return { path: logPath, content: '' };
  }
}

/**
 * Decode a byte-suffix of the log. The tail slice can start mid-codepoint
 * (the daemon emits multi-byte output), so back off past UTF-8 continuation
 * bytes (0x80-0xBF) at the slice start: dropping the split codepoint beats
 * rendering U+FFFD. Daemon and cmd-shim color codes are stripped so the
 * console view stays plain text.
 */
function decodeTail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer
    .subarray(start)
    .toString('utf8')
    .replace(/\x1b\[[0-9;]*m/g, '');
}
