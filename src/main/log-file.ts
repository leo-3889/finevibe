// Main-process log file (owner request 2026-10-26: "if an error comes I just
// say 'check FineVibe logs for issues'"). Packaged Electron apps have no
// console: on Windows a GUI process has no stdio at all, and on Linux output
// lands in journald the user never opens. This module tees the console —
// AFTER the throttle installed first (installConsoleThrottle captures the
// raw methods, so the file receives the collapsed stream, not the flood) —
// into `<logs>/finevibe.log`.
//
// Failure rules (the 2026-10-23 ENOSPC incident is the contract):
// - the sink is append-only, size-capped, and rotates to exactly ONE `.1`
//   backup (the one-backup rule);
// - ANY write failure disables the sink permanently — a logging layer that
//   retries onto a failing disk re-amplifies the incident it documents;
// - installation never throws: no logs directory, no permission → the app
//   runs console-only, exactly as before this module existed.

import * as fs from 'fs';
import * as path from 'path';
import { format } from 'util';

/** Rotation cap for the active log; the `.1` backup carries the same size. */
export const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

export const LOG_FILE_NAME = 'finevibe.log';

const METHODS = ['log', 'info', 'warn', 'error'] as const;

/** @internal Test seam: the module writes through these, never fs directly. */
const io = {
  mkdirSync: fs.mkdirSync,
  appendFileSync: fs.appendFileSync,
  statSync: fs.statSync,
  renameSync: fs.renameSync,
};

let enabled = false;

/** Append one console emission: `<ISO> <LEVEL> <formatted args>`. */
function emit(filePath: string, level: string, args: unknown[]): void {
  let line: string;
  try {
    line = `${new Date().toISOString()} ${level} ${format(...(args as [unknown]))}\n`;
  } catch {
    line = `${new Date().toISOString()} ${level} <unformattable log args>\n`;
  }
  try {
    if (io.statSync(filePath).size + line.length > MAX_LOG_FILE_BYTES) {
      io.renameSync(filePath, `${filePath}.1`);
    }
    io.appendFileSync(filePath, line);
  } catch {
    // ENOSPC, EROFS, EACCES, disk gone: stop writing, keep the app. The
    // console (journald/terminal) still carries everything.
    enabled = false;
  }
}

/**
 * Install the tee. `logDir` is `app.getPath('logs')` in production; returns
 * the log file path for surfacing (Help/About), or null when installation
 * failed — callers treat null as "console-only, as before".
 */
export function installLogFile(logDir: string): string | null {
  if (enabled) return null;
  const filePath = path.join(logDir, LOG_FILE_NAME);
  try {
    io.mkdirSync(logDir, { recursive: true });
    io.appendFileSync(filePath, '');
  } catch {
    return null;
  }
  enabled = true;
  for (const method of METHODS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      if (enabled) emit(filePath, method.toUpperCase(), args);
    };
  }
  return filePath;
}

/** @internal Test-only: swap the fs seam and reset the installed flag. */
export function _setIoForTesting(overrides: Partial<typeof io> | null): void {
  Object.assign(io, {
    mkdirSync: fs.mkdirSync,
    appendFileSync: fs.appendFileSync,
    statSync: fs.statSync,
    renameSync: fs.renameSync,
  }, overrides ?? {});
  enabled = false;
}
