// End-to-end proof of the polled-status pipeline for hook-less providers
// (pi-bolt incident: after an Esc the glyph stayed '?' on the next prompt).
// Real chain: real PiBoltProvider (via the real registry), real transcript
// files, real session-transcript-sync poller/watch, real STATUS_DIR writes,
// real hook-status watcher → win.webContents.send. Only 'electron' (GUI
// handle) and 'node-pty' (native, unused here) are mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

vi.mock('electron', () => ({
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fv-itest-app-')) },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }));

import { registerTranscriptSync, unregisterTranscriptSync, _resetTranscriptSyncForTesting } from './session-transcript-sync';
import { initProviders } from './providers/registry';
import { STATUS_DIR, startWatching, registerSession, unregisterSession, cleanupAll } from './hook-status';
import { seedLaunchTranscript } from './providers/pi-compatible-transcripts';

interface Sent { channel: string; args: unknown[] }

const sent: Sent[] = [];
const stubWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, ...args: unknown[]) => { sent.push({ channel, args }); } },
} as never;

function statusesSent(): string[] {
  // Consecutive-dedupe: the sidecar write fires two fs.watch events
  // (rename + change), so every write is delivered twice; the renderer's
  // setStatus dedupes identical values, so the MEANINGFUL signal is the
  // deduped sequence.
  const out: string[] = [];
  for (const s of sent) {
    if (s.channel !== 'session:hookStatus' || s.args[0] !== sid) continue;
    const v = String(s.args[1]);
    if (out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

async function waitForStatus(want: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (statusesSent().includes(want)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`status '${want}' never delivered; sent: ${JSON.stringify(statusesSent())}`);
}

const sid = `itest-${randomUUID()}`;
let sessionDir = '';
let transcript = '';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-itest-cwd-'));
let statusDirExistedBefore = true;

function appendEntry(entry: object): void {
  fs.appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
}

beforeAll(() => {
  initProviders();
  statusDirExistedBefore = fs.existsSync(STATUS_DIR);
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-itest-sess-'));
  const cliId = randomUUID();
  seedLaunchTranscript(sessionDir, cliId, cwd);
  transcript = path.join(sessionDir, fs.readdirSync(sessionDir)[0]);
  registerSession(sid);
  startWatching(stubWin);
  expect(registerTranscriptSync(sid, 'pi-bolt', cliId, cwd, undefined, { sessionDir })).toBe(true);
});

afterAll(() => {
  unregisterTranscriptSync(sid);
  _resetTranscriptSyncForTesting();
  cleanupAll();
  unregisterSession(sid);
  fs.rmSync(path.join(STATUS_DIR, `${sid}.status`), { force: true });
  for (const dir of [sessionDir, cwd]) fs.rmSync(dir, { recursive: true, force: true });
  if (!statusDirExistedBefore) { try { fs.rmdirSync(STATUS_DIR); } catch { /* not empty */ } }
});

describe('polled status pipeline (real modules, real fs)', () => {
  it('delivers working on the user-prompt append and completed on the assistant stop', async () => {
    // The exact incident shape: a completed turn, an Esc (renderer 'waiting',
    // tail unchanged), then a NEW prompt. The prompt append must re-emit
    // 'working' even though the mirrored status already WAS 'working' state
    // earlier — the poller dedupes on (mtime,size), not on value, and the
    // renderer swallows 'working' only for hooks, never for 'Transcript'.
    appendEntry({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } });
    await waitForStatus('completed');
    expect(fs.readFileSync(path.join(STATUS_DIR, `${sid}.status`), 'utf-8')).toBe('Transcript:completed');

    appendEntry({ type: 'message', message: { role: 'user' } });
    await waitForStatus('working');

    appendEntry({ type: 'message', message: { role: 'assistant', stopReason: 'stop' } });
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && statusesSent().filter((s) => s === 'completed').length < 2) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(statusesSent()).toEqual(['completed', 'working', 'completed']);
    // The renderer-side half of the fix is pinned in
    // renderer/session-activity.test.ts (polled 'working' overrides interrupted).
  }, 20_000);
});
