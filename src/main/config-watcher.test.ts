import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/home/testuser',
}));

vi.mock('electron', () => ({
  BrowserWindow: {},
}));

import * as fs from 'fs';
import * as path from 'path';
import { startConfigWatcher, stopConfigWatcher } from './config-watcher';

const n = (p: string) => p.replace(/\\/g, '/');

const mockSend = vi.fn();
function createMockWin(destroyed = false) {
  return { isDestroyed: () => destroyed, webContents: { send: mockSend } } as any;
}

let watchFileCallbacks: Map<string, () => void>;
let watchDirCallbacks: Map<string, () => void>;
const mockClose = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  watchFileCallbacks = new Map();
  watchDirCallbacks = new Map();
  mockClose.mockClear();
  mockSend.mockClear();

  // The fs.watchFile overloads type the listener with 2 args; the mock keeps
  // the 3-arg (path, options, cb) shape production calls it with.
  vi.mocked(fs.watchFile as unknown as (filePath: string, opts: unknown, cb: unknown) => unknown)
    .mockImplementation((filePath: string, _opts: unknown, cb: unknown) => {
      watchFileCallbacks.set(n(String(filePath)), cb as () => void);
      return {} as any;
    });
  vi.mocked(fs.unwatchFile).mockImplementation(vi.fn() as any);
  vi.mocked(fs.watch as unknown as (dirPath: string, opts: unknown, cb: unknown) => unknown)
    .mockImplementation((dirPath: string, _opts: unknown, cb: unknown) => {
      watchDirCallbacks.set(n(String(dirPath)), cb as () => void);
      return { close: mockClose, on: vi.fn().mockReturnThis() } as any;
    });

  // Clean up any previous watcher state
  stopConfigWatcher();
});

afterEach(() => {
  stopConfigWatcher();
  vi.useRealTimers();
});

describe('config-watcher', () => {
  it('watches config files and directories for a project', () => {
    const win = createMockWin();
    // Delta assertions (order-independence audit 2026-10-26): a shuffled
    // predecessor's pending fake-timer restart can add watch calls between
    // beforeEach and this case. What must be exact is what THIS start adds.
    const fileBase = vi.mocked(fs.watchFile).mock.calls.length;
    const dirBase = vi.mocked(fs.watch).mock.calls.length;
    startConfigWatcher(win, '/projects/test');

    // Should watch 5 config files
    expect(vi.mocked(fs.watchFile).mock.calls.length - fileBase).toBe(5);
    expect(watchFileCallbacks.has('/home/testuser/.claude.json')).toBe(true);
    expect(watchFileCallbacks.has('/home/testuser/.claude/settings.json')).toBe(true);
    expect(watchFileCallbacks.has('/home/testuser/.mcp.json')).toBe(true);
    expect(watchFileCallbacks.has('/projects/test/.claude/settings.json')).toBe(true);
    expect(watchFileCallbacks.has('/projects/test/.mcp.json')).toBe(true);

    // Should watch 6 directories
    expect(vi.mocked(fs.watch).mock.calls.length - dirBase).toBe(6);
    expect(watchDirCallbacks.has('/home/testuser/.claude/agents')).toBe(true);
    expect(watchDirCallbacks.has('/home/testuser/.claude/skills')).toBe(true);
    expect(watchDirCallbacks.has('/home/testuser/.claude/commands')).toBe(true);
    expect(watchDirCallbacks.has('/projects/test/.claude/agents')).toBe(true);
    expect(watchDirCallbacks.has('/projects/test/.claude/skills')).toBe(true);
    expect(watchDirCallbacks.has('/projects/test/.claude/commands')).toBe(true);
  });

  it('debounces notifications to the renderer', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    // Trigger multiple file changes rapidly
    watchFileCallbacks.get('/home/testuser/.claude.json')!();
    watchFileCallbacks.get('/home/testuser/.mcp.json')!();

    // Not notified yet (debounce pending)
    expect(mockSend).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(500);

    // Should have sent exactly one notification
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('config:changed');
  });

  it('notifies on directory changes', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    watchDirCallbacks.get('/projects/test/.claude/commands')!();
    vi.advanceTimersByTime(500);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith('config:changed');
  });

  it('does not notify destroyed windows', () => {
    const win = createMockWin(true);
    startConfigWatcher(win, '/projects/test');

    watchFileCallbacks.get('/home/testuser/.claude.json')!();
    vi.advanceTimersByTime(500);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('cleans up watchers on stop', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    vi.mocked(fs.unwatchFile).mockClear();
    mockClose.mockClear();

    stopConfigWatcher();

    expect(fs.unwatchFile).toHaveBeenCalledTimes(5);
    // 6 dir watchers created, each should be closed
    expect(mockClose).toHaveBeenCalledTimes(6);
  });

  it('skips restart if same project', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    vi.mocked(fs.watchFile).mockClear();
    vi.mocked(fs.watch).mockClear();

    startConfigWatcher(win, '/projects/test');

    // Should not have set up new watchers
    expect(fs.watchFile).not.toHaveBeenCalled();
    expect(fs.watch).not.toHaveBeenCalled();
  });

  it('rebinds to a recreated window without duplicating watchers (SA-P2-11)', () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const winA = { isDestroyed: () => destroyedA, webContents: { send: sendA } } as any;
    const winB = { isDestroyed: () => false, webContents: { send: sendB } } as any;
    let destroyedA = false;

    startConfigWatcher(winA, '/projects/test');
    vi.mocked(fs.watchFile).mockClear();
    vi.mocked(fs.watch).mockClear();
    vi.mocked(fs.unwatchFile).mockClear();
    mockClose.mockClear();

    // Window A is destroyed and recreated as B with the same project/provider.
    destroyedA = true;
    startConfigWatcher(winB, '/projects/test');

    // No fs watchers torn down or duplicated by the rebind.
    expect(fs.watchFile).not.toHaveBeenCalled();
    expect(fs.watch).not.toHaveBeenCalled();
    expect(fs.unwatchFile).not.toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();

    watchFileCallbacks.get('/home/testuser/.claude.json')!();
    vi.advanceTimersByTime(500);

    // Reaches win B exactly once, never win A.
    expect(sendB).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledWith('config:changed');
    expect(sendA).not.toHaveBeenCalled();
  });

  it('restarts watchers for new project', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    vi.mocked(fs.watchFile).mockClear();
    vi.mocked(fs.watch).mockClear();

    startConfigWatcher(win, '/projects/other');

    // Should set up new watchers with the new project path
    expect(fs.watchFile).toHaveBeenCalledTimes(5);
    expect(watchFileCallbacks.has('/projects/other/.claude/settings.json')).toBe(true);
    expect(watchFileCallbacks.has('/projects/other/.mcp.json')).toBe(true);
  });

  it('handles fs.watch errors gracefully', () => {
    vi.mocked(fs.watch).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const win = createMockWin();
    // Should not throw
    expect(() => startConfigWatcher(win, '/projects/test')).not.toThrow();
  });

  it('watches codex config files and directories for a project', () => {
    const win = createMockWin();
    vi.mocked(fs.watchFile).mockClear();
    vi.mocked(fs.watch).mockClear();
    startConfigWatcher(win, '/projects/test', 'codex');

    expect(fs.watchFile).toHaveBeenCalledTimes(2);
    expect(watchFileCallbacks.has('/home/testuser/.codex/config.toml')).toBe(true);
    expect(watchFileCallbacks.has('/projects/test/.codex/config.toml')).toBe(true);

    expect(fs.watch).toHaveBeenCalledTimes(4);
    expect(watchDirCallbacks.has('/home/testuser/.codex/agents')).toBe(true);
    expect(watchDirCallbacks.has('/home/testuser/.codex/skills')).toBe(true);
    expect(watchDirCallbacks.has('/projects/test/.codex/agents')).toBe(true);
    expect(watchDirCallbacks.has('/projects/test/.codex/skills')).toBe(true);
  });

  it('restarts watchers when switching providers for the same project', () => {
    const win = createMockWin();
    startConfigWatcher(win, '/projects/test');

    vi.mocked(fs.watchFile).mockClear();
    vi.mocked(fs.watch).mockClear();

    startConfigWatcher(win, '/projects/test', 'codex');

    expect(fs.watchFile).toHaveBeenCalledTimes(2);
    expect(fs.watch).toHaveBeenCalledTimes(4);
    expect(watchFileCallbacks.has('/home/testuser/.codex/config.toml')).toBe(true);
  });
});
