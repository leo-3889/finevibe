// Enrollment state machine (multi-host Phase 1, plan §4).
//
// Driven main-side; every step emits {step, ok, detail} so the wizard can
// render a live checklist. Failures are per-step: a partial enrollment keeps
// what succeeded (key deployed, dirs created) and reports what did not.
//
// The remote commands are built here from validated registry fields only —
// the renderer never contributes argv. exec() output is bounded by ssh-client.

import { app } from 'electron';
import type { HostRecord, ProviderId } from '../../shared/types';
import { getAllProviderMetas } from '../providers/registry';
import { connect, exec } from './ssh-client';
import { readProviderFile, writeProviderFile } from './provider-fs';
import { HOST_SETTINGS_PATH, hostHookEntries, mergeHookBlock, stripHookBlock } from './host-hooks';
import { getHostSecret } from './secrets';
import {
  authorizedKeysDeployCommands,
  authorizedKeysWithBlock,
  authorizedKeysWithoutBlock,
  markerBlock,
  readPublicKeyLine,
} from './keys';
import { setEnrollmentStatus, updateHost } from './host-registry';
import { isValidProfileId } from '../profiles';

export interface EnrollStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export type HostStatusEvent = { id: string; status: HostRecord['enrollmentStatus']; detail?: string };
export type StatusEmitter = (event: HostStatusEvent) => void;

const POSIX_SYSTEMS = ['Linux', 'Darwin'];
const PREREQ_TIMEOUT_MS = 10_000;

/** Provider ids plus the generic tools Phase 2 consumes (§4 step 6). */
function prereqTargets(): { key: string; binary: string }[] {
  const metas = getAllProviderMetas().map((m) => ({ key: m.id as string, binary: m.binaryName }));
  return [...metas, { key: 'node', binary: 'node' }, { key: 'git', binary: 'git' }];
}

/** TOFU + auth test (§4 steps 1-3). Never mutates the record. */
export async function testHost(
  record: HostRecord,
): Promise<{ ok: boolean; fingerprint?: string; newFingerprint?: string; hostKeyChanged: boolean; steps: EnrollStep[] }> {
  const steps: EnrollStep[] = [];
  let captured = '';
  try {
    // A pinned key must match; an unpinned host connects and reports its
    // fingerprint for the wizard's Approve step (nothing is pinned here).
    const { fingerprint } = await connect(record, {
      verifyHostKey: record.hostKeyFingerprint
        ? (fp) => fp === record.hostKeyFingerprint
        : undefined,
    });
    captured = fingerprint;
    steps.push({ step: 'connect', ok: true, detail: `SSH-${record.authKind} auth ok` });
    if (record.hostKeyFingerprint && record.hostKeyFingerprint !== captured) {
      return { ok: false, hostKeyChanged: true, steps, fingerprint: captured };
    }
    return {
      ok: true,
      fingerprint: captured,
      newFingerprint: record.hostKeyFingerprint ? undefined : captured,
      hostKeyChanged: false,
      steps,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'host-key-changed') {
      steps.push({ step: 'host-key', ok: false, detail: 'pinned fingerprint mismatch — rebuilt machine?' });
      return { ok: false, hostKeyChanged: true, steps };
    }
    steps.push({ step: 'connect', ok: false, detail: msg });
    void captured;
    return { ok: false, hostKeyChanged: false, steps };
  }
}

/** One-shot live probe of the host's tool inventory (UR-4, §4 step 6). */
export async function probePrerequisites(record: HostRecord): Promise<NonNullable<HostRecord['prerequisites']>> {
  const result: NonNullable<HostRecord['prerequisites']> = {};
  for (const { key, binary } of prereqTargets()) {
    try {
      // `command -v` gate first; version is best-effort on one line.
      const out = await exec(
        record,
        `command -v ${binary} >/dev/null 2>&1 && { printf '%s\\t' "$(command -v ${binary})"; ${binary} --version 2>/dev/null | head -n 1; } || true`,
        { timeoutMs: PREREQ_TIMEOUT_MS },
      );
      const trimmed = out.trim();
      if (!trimmed) {
        result[key] = { ok: false };
        continue;
      }
      const [path, version] = trimmed.split('\t');
      result[key] = { ok: true, ...(path ? { path } : {}), ...(version ? { version: version.trim() } : {}) };
    } catch {
      result[key] = { ok: false };
    }
  }
  return result;
}

/**
 * Shared tool-inventory refresh (per-host providers plan §2, council R-4):
 * the `hosts:tools` probe and the `provider:checkBinary` staleness refresh
 * are one implementation, two callers. Concurrent refreshes for the same
 * host share the in-flight promise (bounded by the host registry size).
 */
export function refreshHostTools(record: HostRecord): Promise<NonNullable<HostRecord['prerequisites']>> {
  const existing = toolRefreshInFlight.get(record.id);
  if (existing) return existing;
  // Liveness gate (T1 audit #1): an unreachable host must NOT overwrite a
  // healthy record with all-ok:false — probePrerequisites swallows per-target
  // transport failures, and the silent checkBinary staleness path would then
  // hydrate zero providers for 24h. Fail fast, keep the record stale, retry.
  const run = exec(record, 'true', { timeoutMs: PREREQ_TIMEOUT_MS })
    .then(() => probePrerequisites(record))
    .then((prerequisites) => {
      updateHost(record.id, { prerequisites, lastProbeAt: new Date().toISOString(), lastProbeOk: true });
      return prerequisites;
    })
    .finally(() => { toolRefreshInFlight.delete(record.id); });
  toolRefreshInFlight.set(record.id, run);
  return run;
}

/** hostIds with a tool-refresh in flight; keys are dropped by the work itself. */
const toolRefreshInFlight = new Map<string, Promise<NonNullable<HostRecord['prerequisites']>>>();

/**
 * Provision a managed profile dir on the host (per-host providers plan §2):
 * `mkdir -p ~/.finevibe/profiles/<id>` over the exec lane; the remote shell
 * expands `~`, and the same command echoes the resolved absolute path back
 * (configDir semantics unchanged — an absolute path, now possibly remote).
 * Custom (non-managed) paths are refused: the renderer must never steer a
 * remote mkdir.
 */
export async function provisionRemoteProfileDir(record: HostRecord, profileId: string): Promise<string> {
  if (!isValidProfileId(profileId)) throw new Error(`Invalid profile id: ${JSON.stringify(profileId)}`);
  const dir = `~/.finevibe/profiles/${profileId}`;
  // Unquoted on purpose: quoting `~` would create a literal `~` directory.
  // Safe because isValidProfileId fixes the interpolated charset.
  const out = await exec(record, `mkdir -p ${dir} && printf '%s' ${dir}`, { timeoutMs: PREREQ_TIMEOUT_MS });
  const resolved = out.trim();
  if (!resolved.startsWith('/')) throw new Error(`remote profile provisioning returned ${JSON.stringify(resolved)}`);
  return resolved;
}

/** Deploy finevibe's pubkey into the marker block (§4 step 5). */
async function deployKey(record: HostRecord): Promise<EnrollStep> {
  if (!record.privateKeyPath) return { step: 'key-deploy', ok: false, detail: 'no private key on record' };
  const pubLine = readPublicKeyLine(record.privateKeyPath);
  if (!pubLine) return { step: 'key-deploy', ok: false, detail: 'public key unreadable' };
  const existing = await exec(record, 'cat ~/.ssh/authorized_keys 2>/dev/null || true', { timeoutMs: PREREQ_TIMEOUT_MS });
  const present: 'yes' | 'no' = existing.split(/\r?\n/).some((l) => l.trim() === pubLine.trim()) ? 'yes' : 'no';
  if (authorizedKeysWithBlock(existing, record.id, pubLine) === null) {
    return { step: 'key-deploy', ok: true, detail: 'already present' };
  }
  await exec(record, authorizedKeysDeployCommands(markerBlock(record.id, pubLine), present), { timeoutMs: PREREQ_TIMEOUT_MS });
  return { step: 'key-deploy', ok: true };
}

/** Remove exactly the finevibe marker block (§4, unenroll). */
export async function unenrollHost(record: HostRecord): Promise<{ ok: boolean; detail?: string }> {
  let detail: string | undefined;
  try {
    const existing = await exec(record, 'cat ~/.ssh/authorized_keys 2>/dev/null || true', { timeoutMs: PREREQ_TIMEOUT_MS });
    const removed = authorizedKeysWithoutBlock(existing, record.id);
    if (removed === null) detail = 'no marker block present';
    else {
      // Rewrite the remaining content verbatim (ponytail: file sizes here are
      // a handful of key lines; switch to sftp if huge files ever show up).
      const b64 = Buffer.from(removed, 'utf8').toString('base64');
      await exec(
        record,
        `printf '%s' '${b64}' | base64 -d > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
        { timeoutMs: PREREQ_TIMEOUT_MS },
      );
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  // Unenroll also removes exactly the hook block (§3): every settings file
  // gets its FineVibe-marked handlers stripped; foreign hooks/keys untouched,
  // corrupt files skipped (never overwritten).
  for (const settingsPath of hostSettingsTargets(record)) {
    try {
      const raw = await readProviderFile(record.id, settingsPath, { timeoutMs: PREREQ_TIMEOUT_MS });
      if (raw === null) continue;
      const { json, changed } = stripHookBlock(raw);
      if (changed) await writeProviderFile(record.id, settingsPath, json, { timeoutMs: PREREQ_TIMEOUT_MS });
    } catch (err) {
      detail = `${detail ? `${detail}; ` : ''}${settingsPath}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: true, ...(detail ? { detail } : {}) };
}

/**
 * The host settings files to merge hooks into (plan §3): the settings path
 * of every tool the prereq probe found, de-duplicated (pi and pi-bolt share
 * the `~/.pi/agent` tree — merging it twice would double the block). An
 * unprobed record (unenroll of a never-enrolled host) takes every known path:
 * stripHookBlock is a no-op when no block exists.
 */
function hostSettingsTargets(
  record: HostRecord,
  prereqs?: HostRecord['prerequisites'],
): string[] {
  const paths = new Set<string>();
  const resolved = prereqs ?? record.prerequisites;
  for (const [toolId, settingsPath] of Object.entries(HOST_SETTINGS_PATH)) {
    if (!resolved || resolved[toolId]?.ok) paths.add(settingsPath);
  }
  return [...paths];
}

/**
 * Enrollment step 5.5 (plan §3): merge the marker-scoped FineVibe hook block
 * into the host's provider settings files, via the sftp read-modify-write
 * seam. Per-file failures are collected, not fatal (a corrupt settings.json
 * is never overwritten — P1-18 rule); the step reports them as partial.
 */
async function installHostHooks(
  record: HostRecord,
  prereqs?: HostRecord['prerequisites'],
): Promise<EnrollStep> {
  const targets = hostSettingsTargets(record, prereqs);
  if (targets.length === 0) return { step: 'host-hooks', ok: true, detail: 'no supported tools' };
  const failures: string[] = [];
  let installed = 0;
  for (const settingsPath of targets) {
    try {
      // Parent dir must exist for sftp writeFile; the exec lane owns mkdir
      // (the enrollment idiom), one cheap call per settings file.
      const dir = settingsPath.replace(/\/[^/]+$/, '');
      await exec(record, `mkdir -p ${dir}`, { timeoutMs: PREREQ_TIMEOUT_MS });
      const providerId = (Object.keys(HOST_SETTINGS_PATH) as ProviderId[]).find(
        (p) => HOST_SETTINGS_PATH[p] === settingsPath,
      )!;
      const raw = await readProviderFile(record.id, settingsPath, { timeoutMs: PREREQ_TIMEOUT_MS });
      const { json, changed } = mergeHookBlock(raw, hostHookEntries(providerId));
      if (changed) await writeProviderFile(record.id, settingsPath, json, { timeoutMs: PREREQ_TIMEOUT_MS });
      installed += 1;
    } catch (err) {
      failures.push(`${settingsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    return { step: 'host-hooks', ok: false, detail: failures.join('; ') };
  }
  return { step: 'host-hooks', ok: true, detail: `${installed} settings file(s)` };
}

/**
 * Full enrollment (§4 steps 1-8): connect with the pinned key, env probe,
 * key deploy (managed keys), prereq probe, base dirs, persist. `opts.pin`
 * carries the fingerprint the user approved in the wizard when the host was
 * never pinned before.
 */
export async function enrollHost(
  record: HostRecord,
  emit: StatusEmitter,
  opts?: { pin?: string },
): Promise<{ ok: boolean; steps: EnrollStep[] }> {
  const steps: EnrollStep[] = [];
  const fail = (status: HostRecord['enrollmentStatus'], detail: string): { ok: boolean; steps: EnrollStep[] } => {
    setEnrollmentStatus(record.id, status, detail);
    emit({ id: record.id, status, detail });
    return { ok: false, steps };
  };

  const pin = record.hostKeyFingerprint ?? opts?.pin;
  if (!pin) return fail('failed', 'host key not pinned — run Test & Approve first');

  emit({ id: record.id, status: 'probing' });
  // Steps 1-3: TCP/banner/auth ride on connect; TOFU pin enforced here.
  try {
    await connect(record, { verifyHostKey: (fp) => fp === pin });
    steps.push({ step: 'connect', ok: true });
    if (!record.hostKeyFingerprint) updateHost(record.id, { hostKeyFingerprint: pin });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ step: 'connect', ok: false, detail: msg });
    return fail(msg === 'host-key-changed' ? 'failed' : 'failed', msg);
  }

  // Step 4: env probe — POSIX targets only (R2).
  try {
    const uname = (await exec(record, 'uname -s', { timeoutMs: PREREQ_TIMEOUT_MS })).trim();
    if (!POSIX_SYSTEMS.includes(uname)) {
      steps.push({ step: 'env', ok: false, detail: `unsupported target system: ${uname}` });
      return fail('failed', `Phase 1 enrolls POSIX targets only (got ${uname})`);
    }
    const shell = (await exec(record, 'echo "$SHELL"', { timeoutMs: PREREQ_TIMEOUT_MS })).trim();
    steps.push({ step: 'env', ok: true, detail: `${uname}, $SHELL=${shell || 'unset'}` });
  } catch (err) {
    steps.push({ step: 'env', ok: false });
    return fail('failed', `env probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: key deploy (managed keys; password enrollment bootstraps with it).
  if (record.managedKey) {
    try {
      steps.push(await deployKey(record));
      if (!steps[steps.length - 1].ok) return fail('partial', steps[steps.length - 1].detail ?? 'key deploy failed');
    } catch (err) {
      steps.push({ step: 'key-deploy', ok: false });
      return fail('partial', `key deploy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 6: prereq probe (non-fatal → partial).
  let partial = false;
  let probedPrereqs: HostRecord['prerequisites'];
  try {
    const prerequisites = await probePrerequisites(record);
    probedPrereqs = prerequisites;
    updateHost(record.id, { prerequisites });
    const missing = prereqTargets().filter((t) => !prerequisites[t.key]?.ok).map((t) => t.key);
    partial = missing.length > 0;
    steps.push({ step: 'prereqs', ok: !partial, detail: partial ? `missing: ${missing.join(', ')}` : 'all present' });
  } catch (err) {
    partial = true;
    steps.push({ step: 'prereqs', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // Hook merge (plan §3 "step 5.5" — runs HERE, after the step-6 probe, so
  // the tool list decides the targets; the step keeps its `host-hooks` label.
  // Non-fatal.)
  try {
    const hookStep = await installHostHooks(record, probedPrereqs);
    steps.push(hookStep);
    if (!hookStep.ok) partial = true;
  } catch (err) {
    partial = true;
    steps.push({ step: 'host-hooks', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // Step 7: base dirs (+ the hook status sidecar dir, §3: hooks write
  // ~/.finevibe/run on the host).
  try {
    await exec(record, 'mkdir -p ~/.finevibe ~/.finevibe/run', { timeoutMs: PREREQ_TIMEOUT_MS });
    steps.push({ step: 'dirs', ok: true });
  } catch (err) {
    partial = true;
    steps.push({ step: 'dirs', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // Step 8: persist + offer "forget password" (UI acts on auth-ok password).
  const status: HostRecord['enrollmentStatus'] = partial ? 'partial' : 'enrolled';
  updateHost(record.id, {
    enrollmentStatus: status,
    enrolledAt: new Date().toISOString(),
    lastProbeAt: new Date().toISOString(),
    lastProbeOk: true,
    ...(partial ? { enrollmentDetail: steps.find((s) => !s.ok)?.detail } : { enrollmentDetail: undefined }),
  });
  emit({ id: record.id, status });
  const passwordUsable = record.authKind === 'password' && getHostSecret(record.id) !== null;
  return { ok: true, steps: passwordUsable ? [...steps, { step: 'forget-password', ok: true, detail: 'available' }] : steps };
}

/** userData hosts dir helper (wizard calls it before create for managed keys). */
export function managedKeyDir(hostId: string): string {
  return `${app.getPath('userData')}/hosts/${hostId}`;
}

/** Provider ids surface for the §6 tool list (kept here: registry shape). */
export function providerIds(): ProviderId[] {
  return getAllProviderMetas().map((m) => m.id);
}
