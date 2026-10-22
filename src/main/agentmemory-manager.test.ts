import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Real temp dir behind app.getPath('userData'); the log reader opens real
// files there, never the real userData dir. The closure reads userDataDir at
// call time, so the per-test beforeEach assignment is what the mock sees.
let userDataDir: string;
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

// agentmemory-manager's import-time surface: pty-manager pulls in node-pty
// (native) and the module keeps child_process's spawn in reach of spawnDetached.
// Neither is exercised by the log-tail tests, so both stay mocked.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('./pty-manager', () => ({
  getFullPath: () => process.env.PATH,
  withUtf8Locale: (env: Record<string, string | undefined>) => env,
}));

import {
  ensureAgentmemoryRunning,
  getAgentmemoryLogPath,
  readAgentmemoryLog,
  spawnDetached,
} from './agentmemory-manager';

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'finevibe-agentmemory-'));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('readAgentmemoryLog', () => {
  const logPath = () => path.join(userDataDir, 'agentmemory.log');

  it('resolves empty content when the log file does not exist', async () => {
    const result = await readAgentmemoryLog();
    expect(result).toEqual({ path: logPath(), content: '' });
    expect(getAgentmemoryLogPath()).toBe(logPath());
  });

  it('returns the full file verbatim when smaller than tailBytes', async () => {
    const text = 'daemon boot\nengine 0.11.2 listening on 3113\n';
    writeFileSync(logPath(), text, 'utf8');
    const result = await readAgentmemoryLog();
    expect(result).toEqual({ path: logPath(), content: text });
  });

  it('returns exactly the last tailBytes bytes for a larger file', async () => {
    const text = '0123456789'.repeat(10); // 100 ASCII bytes: 1 byte per char
    writeFileSync(logPath(), text, 'utf8');
    const result = await readAgentmemoryLog(20);
    expect(result.content).toBe(text.slice(-20));
    expect(result.content).toHaveLength(20);
    expect(result.path).toBe(logPath());
  });

  it('strips ANSI color codes from the tail', async () => {
    writeFileSync(logPath(), '\x1b[32mok\x1b[0m', 'utf8');
    const result = await readAgentmemoryLog();
    expect(result.content).toBe('ok');
  });

  it('drops a codepoint split by the tail offset instead of emitting U+FFFD', async () => {
    // '€' is 3 UTF-8 bytes: bytes 10-24 are five euro signs. tailBytes=11
    // starts the slice at byte 14 — the middle continuation byte of the
    // second '€' — so the reader must back off to byte 16 and decode 3 whole
    // codepoints.
    const text = `0123456789${'€'.repeat(5)}`;
    writeFileSync(logPath(), Buffer.from(text, 'utf8'));
    const result = await readAgentmemoryLog(11);
    expect(result.content).not.toContain('\uFFFD');
    expect(text.endsWith(result.content)).toBe(true);
    expect(result.content).toBe('€'.repeat(3));
  });
});

describe('ensureAgentmemoryRunning', () => {
  it('single-flights concurrent calls into one spawn', async () => {
    vi.useFakeTimers();
    let probeCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        probeCalls++;
        // First probe: daemon down (connection refused). Poll probes: up.
        if (probeCalls === 1) throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }),
    );
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    try {
      const both = Promise.all([ensureAgentmemoryRunning(), ensureAgentmemoryRunning()]);
      await vi.advanceTimersByTimeAsync(1000);
      const [first, second] = await both;
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(first.running).toBe(true);
      expect(second.running).toBe(true);
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

// PA-33: the append-mode daemon log grew across every restart forever.
// Rotation runs at spawn, strictly above 8 MiB; readers tail ≤ 64 KiB from
// the current file, so the rename is loss-free by construction.
describe('spawnDetached log rotation', () => {
  const CAP = 8 * 1024 * 1024;
  const logPath = () => path.join(userDataDir, 'agentmemory.log');
  const rotatedPath = () => path.join(userDataDir, 'agentmemory.log.1');

  beforeEach(() => {
    // spawnDetached registers 'error' and unref() on the returned child.
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('keeps a log of exactly 8 MiB: rotation is strictly above the cap', () => {
    writeFileSync(logPath(), Buffer.alloc(CAP, 0x61));
    expect(spawnDetached()).toBe(true);
    expect(existsSync(rotatedPath())).toBe(false);
    expect(statSync(logPath()).size).toBe(CAP);
  });

  it('rotates 8 MiB + 1 byte to .1 and starts a fresh current file', () => {
    writeFileSync(logPath(), Buffer.concat([Buffer.alloc(CAP, 0x61), Buffer.from('tail')]));
    expect(spawnDetached()).toBe(true);
    expect(statSync(rotatedPath()).size).toBe(CAP + 4);
    // The append-open recreated the current log empty: the daemon writes fresh.
    expect(statSync(logPath()).size).toBe(0);
  });

  it('overwrites the previous .1 rotation (one generation of history kept)', () => {
    writeFileSync(rotatedPath(), 'OLD ROTATION');
    writeFileSync(logPath(), Buffer.concat([Buffer.alloc(CAP, 0x61), Buffer.from('NEW')]));
    expect(spawnDetached()).toBe(true);
    expect(readFileSync(rotatedPath()).subarray(-3).toString()).toBe('NEW');
  });

  it('spawns untouched when no log exists (first launch)', () => {
    expect(spawnDetached()).toBe(true);
    expect(existsSync(rotatedPath())).toBe(false);
    expect(spawnMock).toHaveBeenCalled();
  });

  it('getAgentmemoryLogPath still points at the unrotated file', () => {
    expect(getAgentmemoryLogPath()).toBe(logPath());
  });
});
