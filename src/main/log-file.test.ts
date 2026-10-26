// The log file sink: format, one-backup rotation, and the ENOSPC contract
// (a failing disk disables the sink; it never throws into the app and never
// re-amplifies — the 2026-10-23 incident rule).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { installLogFile, MAX_LOG_FILE_BYTES, LOG_FILE_NAME, _setIoForTesting } from './log-file';

const io = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
}));

let saved: Record<string, (...a: unknown[]) => void>;

beforeEach(() => {
  saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  _setIoForTesting(io);
  io.mkdirSync.mockReset();
  io.appendFileSync.mockReset();
  io.statSync.mockReset().mockImplementation(() => ({ size: 0 }));
  io.renameSync.mockReset();
});

afterEach(() => {
  Object.assign(console, saved);
  _setIoForTesting(null);
});

describe('installLogFile', () => {
  it('tees console emissions to <dir>/finevibe.log with level and message', () => {
    const file = installLogFile('/logs');
    expect(file).toBe(path.join('/logs', LOG_FILE_NAME));
    console.warn('disk health: %s', 'low');
    const [fileArg, lineArg] = io.appendFileSync.mock.calls.at(-1)!;
    expect(String(fileArg)).toBe(path.join('/logs', 'finevibe.log'));
    expect(String(lineArg)).toMatch(/^\d{4}-\d{2}-\d{2}T.* WARN disk health: low\n$/);
  });

  it('rotates to exactly ONE .1 backup at the size cap', () => {
    installLogFile('/logs');
    io.statSync.mockImplementation(() => ({ size: MAX_LOG_FILE_BYTES }));
    console.error('trigger rotation');
    const f = path.join('/logs', 'finevibe.log');
    expect(io.renameSync).toHaveBeenCalledWith(f, `${f}.1`);
  });

  it('a write failure disables the sink permanently and never throws', () => {
    const spy = vi.fn();
    console.warn = spy as never; // install captures THIS as the original
    installLogFile('/logs');
    io.appendFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); });
    expect(() => console.warn('first')).not.toThrow();
    const writesAfterFail = io.appendFileSync.mock.calls.length;
    expect(() => console.warn('second')).not.toThrow();
    expect(io.appendFileSync.mock.calls.length).toBe(writesAfterFail); // sink off
    expect(spy).toHaveBeenCalledWith('first'); // console survives
  });

  it('install failure (no dir, no permission) leaves the console untouched and returns null', () => {
    io.mkdirSync.mockImplementation(() => { throw new Error('EACCES'); });
    expect(installLogFile('/nope')).toBeNull();
    const spy = vi.fn();
    console.warn = spy as never;
    console.warn('plain');
    expect(spy).toHaveBeenCalledWith('plain');
    expect(io.appendFileSync).not.toHaveBeenCalled();
  });
});
