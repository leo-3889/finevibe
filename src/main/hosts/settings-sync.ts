// Settings push (per-host providers plan §4, UR-5): local → host, one-way,
// user-initiated. The bundle builder is the allowlist; this module owns the
// I/O loop over it — seam writes with the one-backup `.bak` rule, sha256
// bookkeeping on the HostRecord, drift confirmation, and the exec-lane
// `npm install` for the manifest-synced extension trees.
//
// Direction is push-only by design (§4): bidirectional sync is a sync engine
// this feature has not earned. Everything main-side; the renderer sends ids.

import { createHash } from 'crypto';
import type { HostRecord, ProviderId } from '../../shared/types';
import { listProviderDir, readProviderFile, writeProviderFile } from './provider-fs';
import { exec } from './ssh-client';
import { updateHost } from './host-registry';
import { buildSettingsBundle, SYNCABLE_PROVIDER_IDS, type BundleEntry, type BundleSourceFs } from './settings-bundle';

export interface SyncStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface SyncResult {
  ok: boolean;
  /** Set when remote files drifted and the caller must confirm Overwrite. */
  drift?: string[];
  steps: SyncStep[];
}

const DIR_TIMEOUT_MS = 10_000;
/** npm install is a real install, not a probe (plan §4). */
const NPM_TIMEOUT_MS = 120_000;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Double-quote a `~/`-anchored path for the remote shell with `$HOME`
 * interpolation (the pty-manager ssh-wrap idiom): quoting keeps skill names
 * with spaces/metachars inert, `$HOME` keeps the tilde expansion the seam's
 * `~/` spelling implies. The escaped set is what bash expands inside `"..."`.
 */
export function remotePathArg(path: string): string {
  const homeRelative = path.startsWith('~/');
  const body = homeRelative ? path.slice(2) : path;
  const prefix = homeRelative ? '$HOME/' : '';
  return `"${prefix}${body.replace(/[`$\\"]/g, (c) => `\\${c}`)}"`;
}

/** The provider-fs seam's local lane as a BundleSourceFs: the seam maps
 * ENOENT to null; directories surface as EISDIR/EPERM/ENOTDIR reads and
 * ENOTDIR listings, which the seam contract calls null for this consumer. */
async function localReadText(relPath: string): Promise<string | null> {
  try {
    return await readProviderFile(undefined, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EISDIR' || code === 'EPERM' || code === 'ENOTDIR') return null;
    throw err;
  }
}

async function localListDir(relDir: string): Promise<string[] | null> {
  try {
    return await listProviderDir(undefined, relDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTDIR' || code === 'EISDIR' || code === 'EPERM') return null;
    throw err;
  }
}

const localSource: BundleSourceFs = { readText: localReadText, listDir: localListDir };

/**
 * Paths whose REMOTE content no longer matches what we would push (§4 drift).
 * Two classes (audit T3 #1): stored-hash paths whose remote ≠ stored hash,
 * AND bundle paths with NO stored hash whose remote exists with foreign
 * content — a first sync must not silently clobber the host's own file
 * (T2 installed hooks live in these files). `bundle` bounds the check to
 * what this push writes; without it only stored hashes are considered.
 */
async function driftedPaths(record: HostRecord, bundle?: BundleEntry[]): Promise<string[]> {
  const stored = record.settingsSync?.lastSyncHashes ?? {};
  const drift: string[] = [];
  const checked = new Set<string>();
  for (const [relPath, hash] of Object.entries(stored)) {
    if (bundle && !bundle.some((e) => e.relPath === relPath)) continue;
    checked.add(relPath);
    const remote = await readProviderFile(record.id, relPath);
    if (remote === null || sha256(remote) !== hash) drift.push(relPath);
  }
  for (const entry of bundle ?? []) {
    if (checked.has(entry.relPath)) continue;
    const remote = await readProviderFile(record.id, entry.relPath);
    if (remote !== null && sha256(remote) !== sha256(entry.content)) drift.push(entry.relPath);
  }
  return drift;
}

/** `npm install` on the host (exec lane) for a manifest dir; node absence is
 * a warning, not a failure (the prereq probe already knows about node). */
async function npmInstallOnHost(record: HostRecord, manifestDir: string, label: string): Promise<SyncStep> {
  if (record.prerequisites?.node?.ok !== true) {
    return { step: 'npm', ok: false, detail: `${label}: node missing on host — npm install skipped` };
  }
  try {
    await exec(record, `cd ${remotePathArg(manifestDir)} && npm install`, { timeoutMs: NPM_TIMEOUT_MS });
    return { step: 'npm', ok: true, detail: label };
  } catch (err) {
    return { step: 'npm', ok: false, detail: `${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Push the selected providers' settings to the host. Drift gate: when a
 * previously-synced file in this bundle has remote content ≠ the stored
 * hash, the caller must re-invoke with `confirmOverwrite: true` (the UI
 * shows Overwrite/Cancel). On success the record carries the new
 * providers/lastSyncAt/lastSyncHashes.
 */
export async function syncSettingsToHost(
  record: HostRecord,
  providerIds: ProviderId[],
  opts?: { confirmOverwrite?: boolean },
): Promise<SyncResult> {
  const ids = providerIds.filter((p): p is (typeof SYNCABLE_PROVIDER_IDS)[number] =>
    (SYNCABLE_PROVIDER_IDS as string[]).includes(p),
  );
  const fail = (detail: string): SyncResult => ({ ok: false, steps: [{ step: 'sync', ok: false, detail }] });
  if (ids.length === 0) return fail('no syncable providers selected');
  if (record.enrollmentStatus !== 'enrolled' && record.enrollmentStatus !== 'partial') {
    return fail('host is not enrolled');
  }

  const bundle = await buildSettingsBundle(ids, localSource);
  if (bundle.length === 0) return fail('nothing to sync (no source files found)');

  // Drift gate over this bundle's paths only — other stored files are not
  // being overwritten by this push.
  const drift = await driftedPaths(record, bundle);
  if (drift.length > 0 && opts?.confirmOverwrite !== true) {
    return { ok: false, drift, steps: [] };
  }

  const steps: SyncStep[] = [];
  const failures: string[] = [];
  const written = new Map<string, string>();
  for (const entry of bundle) {
    try {
      // The seam never creates dirs (enrollment idiom): exec-lane mkdir.
      const dir = entry.relPath.slice(0, entry.relPath.lastIndexOf('/'));
      if (dir) await exec(record, `mkdir -p ${remotePathArg(dir)}`, { timeoutMs: DIR_TIMEOUT_MS });
      // Global rule: ONE `.bak` per path, replaced each sync. The bundle is
      // deduped by path, so pi + pi-bolt sharing the tree rotate one backup.
      const existing = await readProviderFile(record.id, entry.relPath);
      if (existing !== null) await writeProviderFile(record.id, `${entry.relPath}.bak`, existing);
      await writeProviderFile(record.id, entry.relPath, entry.content);
      written.set(entry.relPath, sha256(entry.content));
    } catch (err) {
      console.warn(`[hosts] settings sync write failed [${record.id}] ${entry.relPath}: ${err instanceof Error ? err.message : String(err)}`);
      failures.push(`${entry.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  steps.push({
    step: 'sync',
    ok: failures.length === 0,
    detail: failures.length > 0 ? failures.join('; ') : `${written.size} file(s) pushed`,
  });

  // Extension manifests (§4): manifests synced → npm install on the host.
  // Audit T3 #2: gate on the manifest having been WRITTEN, not just being in
  // the bundle — a failed sftp write must not npm-install a stale manifest.
  if (ids.includes('pi-bolt') && written.has('~/.pi/agent/npm/package.json')) {
    steps.push(await npmInstallOnHost(record, '~/.pi/agent/npm', 'pi-bolt extensions'));
  }
  if (ids.includes('omp') && written.has('~/.omp/plugins/package.json')) {
    steps.push(await npmInstallOnHost(record, '~/.omp/plugins', 'omp plugins'));
  }

  const stored = record.settingsSync;
  const lastSyncHashes = { ...(stored?.lastSyncHashes ?? {}), ...Object.fromEntries(written) };
  const providers = [...new Set([...(stored?.providers ?? []), ...ids])];
  updateHost(record.id, {
    settingsSync: {
      providers,
      lastSyncAt: new Date().toISOString(),
      lastSyncHashes,
    },
  });

  return { ok: failures.length === 0, steps };
}
