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
import { isBinaryBuffer } from '../fs-utils';
import { loadState } from '../store';
import { getHost } from './host-registry';
import { exec, sftpListDirEntries, sftpRead, sftpReadRange, sftpStat } from './ssh-client';
import { remotePathArg } from './settings-sync';

/** Listing cap for the dir browser — bounds one readdir payload (the local
 * fs:listDirs cap is 20 because it is a keystroke autocomplete; a browser
 * page needs the directory, and 500 names is ~20 KB). */
const MAX_REMOTE_LIST_DIRS = 500;

/** Listing cap for the remote FILE tree — bounds one readdir payload like
 * MAX_REMOTE_LIST_DIRS bounds the dir browser. 2000 names is ~80 KB over
 * sftp; a project root that overflows it renders truncated (the local
 * fs:listDir is uncapped, the watcher keeps it honest; a remote tree has no
 * watcher and a bounded payload is the whole point). */
export const MAX_REMOTE_LIST_ENTRIES = 2000;

/** Read cap for the remote file preview — parity with the local
 * MAX_READ_FILE_BYTES (ipc-handlers), so a tree open behaves the same on
 * both sides of the wire. */
const MAX_REMOTE_READ_BYTES = 8 * 1024 * 1024;

const LIST_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 30_000;
const STAT_TIMEOUT_MS = 10_000;
const MKDIR_TIMEOUT_MS = 15_000;
/** Mirrors the local GIT_CLONE_TIMEOUT_MS (ipc-handlers.ts): a clone on a
 * host is the same slow network operation. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

interface RemoteDirsResult { ok: boolean; dirs?: string[]; error?: string }
interface RemoteStatResult { ok: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number; error?: string }
interface RemoteEnsureResult { ok: boolean; path?: string; error?: string }
interface RemoteCloneResult { ok: boolean; error?: string }

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
 * Project containment for the remote FILE lanes (parent plan §11: "gated by
 * the same project containment rules as local fs:*"). The local analogue is
 * `isAllowedReadPath`: a file read must sit under a known project root. The
 * remote root set is the persisted ProjectRecords whose `hostId` is this
 * host (paths stored posix at add-time; trailing separators tolerated).
 * The dir-browser lanes (listDirs/stat/ensureDir/cloneRepo) are NOT gated
 * by this — the HostRecord is their consent (council R-1, T5); this gate
 * narrows the always-on tree/preview rails to what the user opened.
 */
export function isRemotePathInKnownProject(hostId: string, target: string): boolean {
  for (const p of loadState().projects) {
    if ((p.hostId ?? 'local') !== hostId) continue;
    const root = p.path.replace(/\/+$/, '');
    if (!root) continue;
    if (target === root || target.startsWith(root + '/')) return true;
  }
  return false;
}

interface RemoteDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * The `fs:listDir` answer for a remote directory: files AND dirs, dotfiles
 * included (parity with the local channel — the renderer sorts/filters).
 * Gated: host enrolled|partial + path safety + project containment.
 * Every failure answers as an empty listing would not — the caller (the
 * IPC handler) maps errors to `[]` like the local channel's catch.
 */
export async function listRemoteDir(
  hostId: unknown,
  dirPath: unknown,
): Promise<{ ok: true; entries: RemoteDirEntry[] } | { ok: false; error: string }> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(dirPath)}` };
  if (!isRemotePathInKnownProject(gate.record.id, dir)) {
    return { ok: false, error: `Not a known project path: ${dir}` };
  }
  try {
    const entries = await sftpListDirEntries(gate.record, dir, { timeoutMs: LIST_TIMEOUT_MS });
    if (entries === null) return { ok: false, error: `No such directory: ${dir}` };
    const out = entries
      .slice(0, MAX_REMOTE_LIST_ENTRIES)
      .map((e) => ({ name: e.name, path: remoteJoin(dir, e.name), isDirectory: e.isDirectory }));
    return { ok: true, entries: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * R2 Phase 4a (`docs/hosts.md` §R2 backlog): the `fs:listFiles` sibling for a
 * remote project — a recursive sftp walk mirroring the local non-git fallback
 * walk (`ipc-handlers.ts walkProjectFiles`): DFS in readdir order, same depth
 * cap, same ignore set, dotfiles skipped. The file cap is the per-dir
 * MAX_REMOTE_LIST_ENTRIES as a TOTAL bound (one project's whole listing stays
 * ~80 KB over the wire, matching the payload-bounding rule of the sibling
 * caps); the local 5000 cap is a git-ls-files bound, not a wire bound.
 * Results are cached by the caller (ipc-handlers `getCachedFiles`). */
const REMOTE_WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__']);
const REMOTE_WALK_MAX_DEPTH = 5;

export async function walkRemoteFiles(hostId: string, projectPath: string): Promise<string[]> {
  const root = normalizeRemotePath(projectPath);
  if (root === null) return [];
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > REMOTE_WALK_MAX_DEPTH || files.length >= MAX_REMOTE_LIST_ENTRIES) return;
    const res = await listRemoteDir(hostId, dir);
    if (!res.ok) return; // unreadable dir: skip it, like the local walk's catch
    for (const e of res.entries) {
      if (files.length >= MAX_REMOTE_LIST_ENTRIES) return;
      if (REMOTE_WALK_IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      if (e.isDirectory) await walk(e.path, depth + 1);
      else files.push(e.path.slice(root.length + 1)); // posix-relative, local walk's shape
    }
  };
  await walk(root, 0);
  return files;
}

/**
 * The `fs:readFile` answer for a remote file: size-capped, head-sniffed for
 * binary (NUL in the first 8 KiB, the `isBinaryBuffer` rule), then the whole
 * file over sftp. Shape-mirrors the local channel's ReadFileResult.
 */
export async function readRemoteFile(
  hostId: unknown,
  target: unknown,
): Promise<{ ok: true; content: string } | { ok: false; reason: 'binary' | 'error' }> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, reason: 'error' };
  const p = normalizeRemotePath(target);
  if (p === null) return { ok: false, reason: 'error' };
  if (!isRemotePathInKnownProject(gate.record.id, p)) return { ok: false, reason: 'error' };
  try {
    const stat = await sftpStat(gate.record, p, { timeoutMs: STAT_TIMEOUT_MS });
    if (stat === null || stat.isDirectory) return { ok: false, reason: 'error' };
    if (stat.size > MAX_REMOTE_READ_BYTES) return { ok: false, reason: 'error' };
    const head = await sftpReadRange(gate.record, p, 0, 8192, { timeoutMs: READ_TIMEOUT_MS });
    if (head === null) return { ok: false, reason: 'error' };
    if (isBinaryBuffer(head)) return { ok: false, reason: 'binary' };
    const content = await sftpRead(gate.record, p, { timeoutMs: READ_TIMEOUT_MS });
    if (content === null) return { ok: false, reason: 'error' };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: 'error' };
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
