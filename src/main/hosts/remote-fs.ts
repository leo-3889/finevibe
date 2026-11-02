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
const HOME_TIMEOUT_MS = 10_000;

/** Cap for the resolved-home cache (module-map-governance): one entry per host
 * that ran a `~`-anchored lane; keys are host ids so the registry is the
 * natural bound and this is the ceiling (LRU, the `fs-utils` idiom). */
export const MAX_REMOTE_HOME_CACHE = 32;
/** Mirrors the local GIT_CLONE_TIMEOUT_MS (ipc-handlers.ts): a clone on a
 * host is the same slow network operation. */
const CLONE_TIMEOUT_MS = 10 * 60_000;

interface RemoteDirsResult { ok: boolean; dirs?: string[]; home?: string; error?: string }
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
  let body = trimmed;
  if (homeAnchored) body = trimmed === '~' ? '/' : trimmed.slice(1);
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

/**
 * DEFECT 129: the host's absolute home, resolved ONCE per host over the exec
 * lane (`printf '%s' "$HOME"` — the enrollment idiom: the login shell expands
 * `$HOME`, the quoting keeps a home with a space inert). sftp has NO tilde
 * expansion — a quoted `~` is a literal directory named `~` — so every
 * `~`-anchored lane needs this value before it quotes or hands a path to the
 * sftp seam. Warm at enrollment success (the `dirs` step in enrollment.ts) and
 * lazily on the first `~`-anchored call; a failed probe is NOT cached, so the
 * next call retries. An unresolvable `$HOME` (empty/multi-line/relative) is
 * null: the `~`-anchored lanes refuse with a real message, absolute paths
 * keep working.
 */
export async function resolveRemoteHome(record: HostRecord): Promise<string | null> {
  const hit = remoteHomeCache.get(record.id);
  if (hit !== undefined) {
    // Insertion order doubles as recency: re-inserting on a hit makes the size
    // cap evict the least recently used host (the fs-utils LRU idiom).
    remoteHomeCache.delete(record.id);
    remoteHomeCache.set(record.id, hit);
    return hit;
  }
  try {
    const raw = (await exec(record, `printf '%s' "$HOME"`, { timeoutMs: HOME_TIMEOUT_MS })).trim();
    const home = raw.replace(/\/+$/, '');
    if (!home.startsWith('/') || home.includes('\n')) return null;
    remoteHomeCache.set(record.id, home);
    while (remoteHomeCache.size > MAX_REMOTE_HOME_CACHE) {
      remoteHomeCache.delete(remoteHomeCache.keys().next().value as string);
    }
    return home;
  } catch {
    return null;
  }
}

/** Drop a host's cached home (host removed / re-enrolled into a new account). */
export function invalidateRemoteHome(hostId: string): void {
  remoteHomeCache.delete(hostId);
}

/** The resolved home, cached per host id (bounded by MAX_REMOTE_HOME_CACHE). */
const remoteHomeCache = new Map<string, string>();

/**
 * Expand a canonical `~`/`~/x` spelling into the host's absolute path. Pure:
 * `home` is {@link resolveRemoteHome}'s answer. Returns null when the spelling
 * needs the home and there is none (the caller refuses — quoting `~` literally
 * is exactly the `No such directory: ~` defect this closes).
 */
export function expandRemotePath(p: string, home: string | null): string | null {
  if (p !== '~' && !p.startsWith('~/')) return p;
  if (home === null) return null;
  return p === '~' ? home : `${home}/${p.slice(2)}`;
}

/**
 * The host home when `p` needs it (a `~`-anchored spelling), without probing
 * for an absolute path — the tree rails speak absolutes all day.
 */
async function homeIfAnchored(record: HostRecord, p: string): Promise<string | null> {
  return p === '~' || p.startsWith('~/') ? resolveRemoteHome(record) : null;
}

function homeUnresolvedError(record: HostRecord): string {
  return `Could not resolve the home directory on ${record.name} (is $HOME set?)`;
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
  // `home` rides the payload so the browser can seed/label at the ABSOLUTE
  // home and hand back an absolute selection (DEFECT 129); the listing itself
  // stays in the canonical `~` spelling the whole remote surface speaks.
  const home = await homeIfAnchored(gate.record, dir);
  const target = expandRemotePath(dir, home);
  if (target === null) return { ok: false, error: homeUnresolvedError(gate.record) };
  try {
    const entries = await sftpListDirEntries(gate.record, target, { timeoutMs: LIST_TIMEOUT_MS });
    if (entries === null) return { ok: false, error: `No such directory: ${dir}` };
    const lowerPrefix = prefix?.toLowerCase();
    const dirs = entries
      .filter((e) => e.isDirectory && !e.name.startsWith('.')
        && (!lowerPrefix || e.name.toLowerCase().startsWith(lowerPrefix)))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_REMOTE_LIST_DIRS)
      .map((name) => remoteJoin(dir, name));
    return { ok: true, dirs, ...(home ? { home } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The `fs:stat` answer for a remote path (widened with `isDirectory`, the
 * one thing the Add-project probe asks). Missing answers `{ok:false}`.
 *
 * NOT project-contained on purpose: this is the Add-project DIR-BROWSER lane
 * (`hosts:stat`), whose consent is the enrolled HostRecord (council R-1) — the
 * browser has to name folders that are not projects yet. The always-on TREE
 * rails call `isRemotePathInKnownProject` themselves before reaching here
 * (audit row 93).
 */
export async function statRemotePath(hostId: unknown, target: unknown): Promise<RemoteStatResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const p = normalizeRemotePath(target);
  if (p === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(target)}` };
  const resolved = expandRemotePath(p, await homeIfAnchored(gate.record, p));
  if (resolved === null) return { ok: false, error: homeUnresolvedError(gate.record) };
  try {
    const stat = await sftpStat(gate.record, resolved, { timeoutMs: STAT_TIMEOUT_MS });
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
 * The dir-browser lanes (hosts:listDirs/hosts:stat/ensureDir/cloneRepo) are NOT
 * gated by this — the HostRecord is their consent (council R-1, T5); this gate
 * narrows the always-on tree/preview rails to what the user opened. Its callers
 * are the tree rails only: `fs:listDir`, `fs:readFile`, `fs:exists`, `fs:stat`,
 * `fs:isDirectory` (rows 93) and the remote `provider:getConfig` / `pty:create`
 * gates, which hand it the RAW renderer string (row 94).
 *
 * The compare runs on `normalizeRemotePath` of BOTH sides, so `..` segments die
 * before it: the lexical collapse happens in `joinPosix` +
 * `normalizeProviderPath` AFTER a raw prefix compare, so a raw `startsWith` let
 * `/proj/evil/../../secret` through the gate and then read the fixed config
 * filenames out of `/secret` on the host (row 94).
 */
export function isRemotePathInKnownProject(hostId: string, target: string): boolean {
  const norm = normalizeRemotePath(target);
  if (norm === null) return false;
  for (const p of loadState().projects) {
    if ((p.hostId ?? 'local') !== hostId) continue;
    const root = normalizeRemotePath(p.path);
    if (root === null) continue;
    if (norm === root || norm.startsWith(`${root}/`)) return true;
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
  const target = expandRemotePath(dir, await homeIfAnchored(gate.record, dir));
  if (target === null) return { ok: false, error: homeUnresolvedError(gate.record) };
  try {
    const entries = await sftpListDirEntries(gate.record, target, { timeoutMs: LIST_TIMEOUT_MS });
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
 * walk (`ipc/fs-domains.ts walkProjectFiles`): DFS in readdir order, same depth
 * cap, same ignore set, dotfiles skipped. The file cap is the per-dir
 * MAX_REMOTE_LIST_ENTRIES as a TOTAL bound (one project's whole listing stays
 * ~80 KB over the wire, matching the payload-bounding rule of the sibling
 * caps); the local 5000 cap is a git-ls-files bound, not a wire bound.
 * Results are cached by the caller (ipc/fs-domains.ts `getCachedFiles`). */
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
  const resolved = expandRemotePath(p, await homeIfAnchored(gate.record, p));
  if (resolved === null) return { ok: false, reason: 'error' };
  try {
    const stat = await sftpStat(gate.record, resolved, { timeoutMs: STAT_TIMEOUT_MS });
    if (stat === null || stat.isDirectory) return { ok: false, reason: 'error' };
    if (stat.size > MAX_REMOTE_READ_BYTES) return { ok: false, reason: 'error' };
    const head = await sftpReadRange(gate.record, resolved, 0, 8192, { timeoutMs: READ_TIMEOUT_MS });
    if (head === null) return { ok: false, reason: 'error' };
    if (isBinaryBuffer(head)) return { ok: false, reason: 'binary' };
    const content = await sftpRead(gate.record, resolved, { timeoutMs: READ_TIMEOUT_MS });
    if (content === null) return { ok: false, reason: 'error' };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

/**
 * `mkdir -p` on the host, answering with the absolute path the `printf` echo
 * returns, so the renderer persists what main itself answers for. The path is
 * expanded against the resolved home BEFORE quoting (DEFECT 129): a quoted
 * `~`/`~/x` is literal to the remote shell, so the old `'~/'` shim created a
 * directory literally named `~`.
 */
export async function ensureRemoteDir(hostId: unknown, dirPath: unknown): Promise<RemoteEnsureResult> {
  const gate = gateHost(hostId);
  if ('error' in gate) return { ok: false, error: gate.error };
  const dir = normalizeRemotePath(dirPath);
  if (dir === null) return { ok: false, error: `Unsafe remote path: ${JSON.stringify(dirPath)}` };
  const expanded = expandRemotePath(dir, await homeIfAnchored(gate.record, dir));
  if (expanded === null) return { ok: false, error: homeUnresolvedError(gate.record) };
  const arg = remotePathArg(expanded);
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
  const cloneDest = expandRemotePath(dest, await homeIfAnchored(gate.record, dest));
  if (cloneDest === null) return { ok: false, error: homeUnresolvedError(gate.record) };
  try {
    const stat = await sftpStat(gate.record, cloneDest, { timeoutMs: STAT_TIMEOUT_MS });
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
      `git clone -- ${remotePathArg(target.url)} ${remotePathArg(cloneDest)}`,
      { timeoutMs: CLONE_TIMEOUT_MS },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
