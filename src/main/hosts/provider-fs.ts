// The provider file plane, keyed per host (per-host providers plan §2/§3).
//
// One seam for every provider file read FineVibe needs off-box: local fs for
// 'local', ssh2 sftp for registry hosts. Paths are POSIX and anchored at the
// host user's home (a leading `/` is absolute on the host). §7 security rule:
// normalization happens HERE — callers hand relative paths, the seam rejects
// `..` traversal before any disk/network touch.
//
// Deliberately stateless: no module-level cache. The consumers already gate
// repeat reads (session-transcript-sync's (mtime,size) tuple, hook-status's
// mtime/content gate), so a second cache would only add staleness.
// ponytail: add a bounded per-host tail cache if sftp latency ever shows up
// in profiles (docs/performance.md precedent), with a governance entry.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getHost } from './host-registry';
import { sftpListDir, sftpRead, sftpReadRange, sftpStatSize, sftpWrite } from './ssh-client';
import { LOCAL_HOST_ID } from '../../shared/types';

/** Cap for paged window reads (head/tail). Bounds a pathological transcript. */
export const MAX_WINDOW_BYTES = 1024 * 1024;

/** True when reads for this host id go over sftp. */
function isRemote(hostId: string | undefined): boolean {
  return hostId !== undefined && hostId !== LOCAL_HOST_ID;
}

/**
 * Normalize a home-relative (or host-absolute posix) path and reject
 * traversal: `..` segments and empty segments never reach fs or sftp.
 * A leading `~/` is the home-relative spelling callers use (settings paths,
 * the status sidecar) and is stripped — the targets below re-add it in the
 * form each lane needs. Returns the path safe to join/serve, or null when
 * the input is unsafe.
 */
export function normalizeProviderPath(relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const norm = path.posix.normalize(relPath.replaceAll('\\', '/').replace(/^~\/?/, ''));
  if (norm.split('/').some((seg) => seg === '..')) return null;
  if (norm === '.' || norm === '/') return null;
  return norm;
}

/** Map the seam path onto the local filesystem (home-relative ⇒ homedir). */
function localTarget(relPath: string): string {
  return path.posix.isAbsolute(relPath) ? path.resolve(relPath) : path.join(os.homedir(), relPath);
}

/** Remote spelling: home-relative gets the `~/` prefix sftp servers expand. */
function remoteTarget(relPath: string): string {
  return path.posix.isAbsolute(relPath) ? relPath : `~/${relPath}`;
}

function recordFor(hostId: string) {
  const record = getHost(hostId);
  if (!record) throw new Error(`Unknown host ${JSON.stringify(hostId)} — cannot read provider files`);
  return record;
}

/**
 * Read a provider file. Resolves null when the file does not exist —
 * "missing" and "unreadable" stay distinguishable by callers via the throw.
 */
export async function readProviderFile(
  hostId: string | undefined,
  relPath: string,
  opts?: { timeoutMs?: number },
): Promise<string | null> {
  const p = normalizeProviderPath(relPath);
  if (p === null) throw new Error(`Unsafe provider file path: ${JSON.stringify(relPath)}`);
  if (!isRemote(hostId)) {
    try {
      return await fs.promises.readFile(localTarget(p), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }
  return sftpRead(recordFor(hostId!), remoteTarget(p), opts);
}

/** File size in bytes; null when the file does not exist. */
export async function statProviderFileSize(
  hostId: string | undefined,
  relPath: string,
  opts?: { timeoutMs?: number },
): Promise<number | null> {
  const p = normalizeProviderPath(relPath);
  if (p === null) throw new Error(`Unsafe provider file path: ${JSON.stringify(relPath)}`);
  if (!isRemote(hostId)) {
    try {
      return (await fs.promises.stat(localTarget(p))).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }
  return sftpStatSize(recordFor(hostId!), remoteTarget(p), opts);
}

/**
 * Paged window read — the transcript-tail primitive. Reads at most
 * `length` bytes from `position` (capped at MAX_WINDOW_BYTES); never the
 * whole file. `fromEnd` positions the window at the file tail:
 * position = max(0, size - length), the tail-read the status pollers use.
 */
export async function readProviderFileWindow(
  hostId: string | undefined,
  relPath: string,
  length: number,
  opts?: { fromEnd?: boolean; timeoutMs?: number },
): Promise<string | null> {
  const p = normalizeProviderPath(relPath);
  if (p === null) throw new Error(`Unsafe provider file path: ${JSON.stringify(relPath)}`);
  const len = Math.min(Math.max(0, Math.floor(length)), MAX_WINDOW_BYTES);
  if (!isRemote(hostId)) {
    const target = localTarget(p);
    let fd: number | null = null;
    try {
      fd = fs.openSync(target, 'r');
      const size = fs.fstatSync(fd).size;
      const start = opts?.fromEnd ? Math.max(0, size - len) : 0;
      const buf = Buffer.alloc(Math.min(len, Math.max(0, size - start)));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8', 0, bytesRead);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  }
  const record = recordFor(hostId!);
  const remote = remoteTarget(p);
  // The seam's `fromEnd` selector is not an sftp option — strip it (audit T2
  // nit #11); only the timeout rides down the wire lane.
  const sftpOpts = opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined;
  let start = 0;
  if (opts?.fromEnd) {
    const size = await sftpStatSize(record, remote, sftpOpts);
    if (size === null) return null;
    start = Math.max(0, size - len);
  }
  const buf = await sftpReadRange(record, remote, start, len, sftpOpts);
  return buf === null ? null : buf.toString('utf8');
}

/** List a provider directory's entry names; null when the directory is gone. */
export async function listProviderDir(
  hostId: string | undefined,
  relDir: string,
  opts?: { timeoutMs?: number },
): Promise<string[] | null> {
  const p = normalizeProviderPath(relDir);
  if (p === null) throw new Error(`Unsafe provider dir path: ${JSON.stringify(relDir)}`);
  if (!isRemote(hostId)) {
    try {
      return await fs.promises.readdir(localTarget(p));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    }
  }
  return sftpListDir(recordFor(hostId!), remoteTarget(p), opts);
}

/**
 * Write a provider file (create/truncate) — the enrollment hook-merge write
 * path. Parent dirs must exist (the exec lane owns `mkdir -p`).
 */
export async function writeProviderFile(
  hostId: string | undefined,
  relPath: string,
  content: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const p = normalizeProviderPath(relPath);
  if (p === null) throw new Error(`Unsafe provider file path: ${JSON.stringify(relPath)}`);
  if (!isRemote(hostId)) {
    await fs.promises.writeFile(localTarget(p), content, 'utf8');
    return;
  }
  await sftpWrite(recordFor(hostId!), remoteTarget(p), content, opts);
}
