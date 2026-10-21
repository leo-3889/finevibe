import { spawn } from 'child_process';
import { isWin } from './platform';
import { getFullPath } from './pty-manager';
import type { AgentmemoryStatus } from '../shared/types';

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
export const CONSOLE_URL = 'http://localhost:3113';

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
 * Start agentmemory as a detached, unref'd daemon that outlives the Electron
 * process. `.cmd` is a batch shim on Windows, so it must go through a shell.
 * `getFullPath()` resolves the live PATH (registry + login shell + ~/.local/bin)
 * so the daemon can find its pinned engine when launched from explorer.exe.
 */
function spawnDetached(): boolean {
  try {
    const child = spawn('agentmemory', [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: isWin,
      shell: isWin,
      env: { ...process.env, PATH: getFullPath() },
    });
    child.on('error', (err) => console.warn('[agentmemory] failed to spawn:', (err as Error).message));
    child.unref();
    return true;
  } catch (err) {
    console.warn('[agentmemory] spawn threw:', (err as Error).message);
    return false;
  }
}

/**
 * Ensure the daemon is running. No-op when already reachable; otherwise spawn
 * and poll the health endpoint for it to come up. Never kills an existing
 * engine (Model A). The returned status reflects the final observed state.
 */
export async function ensureAgentmemoryRunning(): Promise<AgentmemoryStatus> {
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
