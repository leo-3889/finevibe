// Remote-native open/add folder (per-host providers plan §6, UR-6): the
// Add-project modal's verbs on a distant host — enumerate, stat, `mkdir -p`,
// `git clone`. The renderer sends ids + strings only; every path is
// posix-normalized and traversal-rejected HERE, and every remote argv is
// shell-quoted in main (the enrollment `remotePathArg` idiom), so a
// compromised renderer contributes no argv and no unquoted metachar.
//
// SEC (plan §7 + the task's consent question): there is deliberately NO
// enumerate-confirm dialog on the remote lanes. `fs:listDirs`' confirm
// (P1-19) guards a LOCAL privacy concept — enumerating the user's own disk
// outside the home tree. On a registry host the consent IS the HostRecord:
// the user created it, pinned its key, and enrolled it, and `hosts:openShell`
// treats that record as the whole gate (council R-1). The gates below are
// therefore host-exists + enrolled|partial (`syncSettingsToHost`'s shape)
// and path safety, nothing more. Remote paths are NEVER canonicalized
// against the local disk — `path.posix` only.

import * as path from 'path';
import type { HostRecord } from '../../shared/types';
import { detectGitCheckoutUrl } from '../../shared/git-url';
import { getHost } from './host-registry';
import { exec, sftpListDirEntries, sftpStat } from './ssh-client';
import { remotePathArg } from './settings-sync';

/** Listing cap for the dir browser — bounds one readdir payload (the local
 * fs:listDirs cap is 20 because it is a keystroke autocomplete; a browser
 * page needs the directory, and 500 names is ~20 KB). */
export const MAX_REMOTE_LIST_DIRS = 500;

const LIST_TIMEOUT_MS = 10_000;
const STAT_TIMEOUT_MS = 10_000;
const MKDIR_TIMEOUT_MS = 15_000;
/** Mirrors the local GIT_CLONE_TIMEOUT_MS (ipc-handlers.ts): a clone on a
 * host is the same slow network operation. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

export interface RemoteDirsResult { ok: boolean; dirs?: string[]; error?: string }
export interface RemoteStatResult { ok: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number; error?: string }
export interface RemoteEnsureResult { ok: boolean; path?: string; error?: string }
export interface RemoteCloneResult { ok: boolean; error?: string }

/**
 * Normalize a renderer-supplied remote path to the canonical posix spelling
 * the lanes speak: `~` (home), `~/seg/...`, or `/seg/...`.
 *
 * Rejects: non-strings, empty, NUL, `..` segments (checked on the RAW
 * segments — a home-anchored `~/../etc` would normalize to `/etc`, quietly
 * changing the anchor, so the boring gate is "no `..` at all"), relative
 * spellings (the renderer always anchors at `~` or `/`), and a bare `~seg`
 * (another user's home is not a project location).
 * Backslashes are `/`-converted (a Windows-typed field spells them); a
 * trailing `/` is trimmed, the root keeps its single slash.
 */
export function normalizeRemotePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (trimmed === '' || trimmed.includes('\0')) return null;
  const homeAnchored = trimmed === '~' || trimmed.startsWith('~/');
  const body = homeAnchored ? (trimmed === '~' ? '/' : trimmed.slice(1)) : trimmed;
  if (!body.startsWith('/')) return null;
  // RAW segments: path.posix.normalize would silently re-anchor `~/../etc`
  // to `/etc`, so the gate runs before it.
  if (body.split('/').some((seg) => seg === '..')) return null;
  const norm = path.posix.normalize(body).replace(/\/+$/, '');
  if (homeAnchored) {
    return norm === '' ? '~' : `~${norm}`;
  }
  return norm === '' ? '/' : norm;
}

/** The gate every remote verb shares: the record exists and is enrolled
 * (partial counts — the sidebar shows its tab, so its verbs must work).
 * Returns the error string, or null when the host passes. */
function gateHost(hostId: unknown): { record: HostRecord } | { error: string } {
  if (typeof hostId !== 'string' || hostId === '') return { error: 'No host id was given' };
  const record = getHost(hostId);
  if (!record) return { error: `Unknown host ${JSON.stringify(hostId)}` };
  if (record.enrollmentStatus !== 'enrolled' && record.enrollmentStatus !== 'partial') {
    return { error: `Host ${record.name} is not enrolled` };
  }
  return { record };
}

/** `parent` + child name in the remote's canonical posix spelling. */
function remoteJoin(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/**
 * List the directory's child DIRECTORIES in the `fs:listDirs` shape (sorted
 * full paths, dot-names hidden, prefix-filtered), capped at
 * MAX_REMOTE_LIST_DIRS. A missing directory answers `ok:false` — the browser
 * shows the error, the autocomplete shows nothing.
 */
export async function listRemoteDirs(
  hostId: unknown,
  dirPath: unknown,
  prefix?: string,
): Promise<RemoteDirsResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(dirPath)}` };
  try {
    const entries = await sftpListDirEntries(gate.record, dir, { timeoutMs: LIST_TIMEOUT_MS });
    if (entries === null) return { ok: false, error: `No such directory: ${dir}` };
    const lowerPrefix = prefix?.toLowerCase();
    const dirs = entries
      .filter((e) => e.isDirectory && !e.name.startsWith('.')
        && (!lowerPrefix || e.name.toLowerCase().startsWith(lowerPrefix)))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_REMOTE_LIST_DIRS)
      .map((name) => remoteJoin(dir, name));
    return { ok: true, dirs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The `fs:stat` answer for a remote path (widened with `isDirectory`, the
 * one thing the Add-project probe asks). Missing answers `{ok:false}`. */
export async function statRemotePath(hostId: unknown, target: unknown): Promise<RemoteStatResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const p = normalizeRemotePath(target);
  if (p === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(target)}` };
  try {
    const stat = await sftpStat(gate.record, p, { timeoutMs: STAT_TIMEOUT_MS });
    if (stat === null) return { ok: false };
    return { ok: true, isDirectory: stat.isDirectory, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `mkdir -p` on the host, answering with main's canonical posix spelling —
 * the `printf` echo resolves `~` to the host's absolute home, exactly the
 * `provisionRemoteProfileDir` idiom, so the renderer persists what main
 * itself answers for. A bare `~` becomes `~/` for the quoting helper:
 * quoting `~` literally would CREATE a directory named `~`.
 */
export async function ensureRemoteDir(hostId: unknown, dirPath: unknown): Promise<RemoteEnsureResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(dirPath)}` };
  const arg = remotePathArg(dir === '~' ? '~/' : dir);
  try {
    const out = await exec(gate.record, `mkdir -p ${arg} && printf '%s' ${arg}`, { timeoutMs: MKDIR_TIMEOUT_MS });
    const resolved = out.trim().replace(/\/+$/, '');
    if (!resolved.startsWith('/')) {
      return { ok: false, error: `Remote mkdir returned ${JSON.stringify(resolved)}` };
    }
    return { ok: true, path: resolved || '/' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `git clone` on the host. The URL gate is the local `fs:cloneRepo` gate
 * verbatim — `detectGitCheckoutUrl` (host allowlist, no credentials, no
 * ports, folder-safe repo name), re-checked in main. The destination takes
 * the same "exists, not empty → refuse" pre-check the local channel runs,
 * over sftp. Both argv words are shell-quoted (the URL grammar is safe, the
 * quoting is belt-and-braces: the path is user-typed).
 */
export async function cloneRemoteRepo(
  hostId: unknown,
  url: unknown,
  destPath: unknown,
): Promise<RemoteCloneResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const target = typeof url === 'string' ? detectGitCheckoutUrl(url) : null;
  if (!target) return { ok: false, error: 'Unsupported repository URL' };
  const dest = normalizeRemotePath(destPath);
  if (dest === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(destPath)}` };
  if (gate.record.prerequisites?.git?.ok === false) {
    return { ok: false, error: 'git is not installed on the host' };
  }
  try {
    const stat = await sftpStat(gate.record, dest, { timeoutMs: STAT_TIMEOUT_MS });
    if (stat !== null && !stat.isDirectory) {
      return { ok: false, error: `Destination exists and is not a directory: ${dest}` };
    }
    if (stat !== null) {
      const entries = await sftpListDirEntries(gate.record, dest, { timeoutMs: LIST_TIMEOUT_MS });
      if (entries !== null && entries.length > 0) {
        return { ok: false, error: `Destination is not empty: ${dest}` };
      }
    }
    await exec(
      gate.record,
      `git clone -- ${remotePathArg(target.url)} ${remotePathArg(dest)}`,
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
