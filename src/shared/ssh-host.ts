// SSH host parsing for the per-session `ssh <host>` launch wrap.
// Pure JS (no Node APIs): the renderer validates for the UI, main re-validates
// before putting the value into `ssh` argv — a compromised value must not aim
// ssh at an option string (`-oProxyCommand=…`).
//
// Accepted forms: `host`, `user@host`. Rejected: whitespace, ports (`:22` —
// the port belongs to `ssh -p`, the prefix shows the host), `ssh://` URLs,
// leading `-` (option injection), characters outside the hostname/username
// grammars, length > 253.

export interface SshHostRef {
  /** Normalized `user@host` when a user is given, else `host`. */
  host: string;
  user?: string;
}

import type { HostRecord, HostAuthKind, HostEnrollmentStatus } from './types.js';
import { isValidHostColor } from './host-colors.js';

const MAX_HOST_LENGTH = 253;

/** RFC-1123-style hostname: labels alphanumeric with inner hyphens. */
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** POSIX-ish user names; rejects anything that could smuggle argv/quoting. */
const USERNAME = /^[A-Za-z0-9._-]+$/;

const PORT_SUFFIX = /:\d+$/;

/**
 * Parse a free-text SSH host (context-menu field, pty:create arg, detected
 * echo). Returns the normalized reference or null — never throws.
 */
export function parseSshHost(raw: string): SshHostRef | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed.length > MAX_HOST_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  if (PORT_SUFFIX.test(trimmed)) return null;

  const at = trimmed.lastIndexOf('@');
  if (at === 0) return null; // `@host` has an empty user
  let user: string | undefined;
  let host: string;
  if (at > 0) {
    user = trimmed.slice(0, at);
    host = trimmed.slice(at + 1);
    if (!USERNAME.test(user)) return null;
  } else {
    host = trimmed;
  }
  if (!HOSTNAME.test(host)) return null;

  return user ? { host: `${user}@${host}`, user } : { host };
}

// --- HostRecord validation (multi-host Phase 1) ---

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bracketed IPv6 literal (the spelling ssh argv requires). */
const IPV6_BRACKETED = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Registry-target check: the record's user/host as they reach ssh argv.
 * Broader than parseSshHost's free-text gate (which rejects brackets —
 * the registry stores the bracketed IPv6 spelling on purpose). Callers get
 * here only with a validateHostRecordShape-passed record; this is defense
 * in depth for hand-edited state (per-host providers plan audit T1 #2).
 */
export function isRegistryHostTarget(user: string, host: string): boolean {
  return USERNAME.test(user) && (HOSTNAME.test(host) || IPV6_BRACKETED.test(host));
}

const HOST_AUTH_KINDS = ['key', 'password'];
const HOST_ENROLLMENT_STATUSES = ['draft', 'probing', 'auth-ok', 'enrolled', 'partial', 'failed'];

/** The ProviderId union as a set (settingsSync.providers validation). */
const PROVIDER_IDS = new Set(['claude', 'codex', 'copilot', 'gemini', 'pi', 'omp', 'pi-bolt']);

/**
 * Validate one raw `PersistedState.hosts` entry (or an IPC draft) and return
 * the normalized record, or null. Pure JS, shared main+renderer: main
 * re-validates everything the renderer sends (the registry is main-owned).
 * Grammar mirrors parseSshHost: same USERNAME, HOSTNAME extended with the
 * bracketed IPv6 form; port required 1..65535; uuid id. Zero secrets here —
 * this record never carries a password or key body.
 */
export function validateHostRecordShape(raw: unknown): HostRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !UUID.test(r.id)) return null;
  if (typeof r.name !== 'string') return null;
  const name = r.name.trim();
  if (name.length < 1 || name.length > 64) return null;
  if (typeof r.user !== 'string' || !USERNAME.test(r.user)) return null;
  if (typeof r.host !== 'string') return null;
  if (!(HOSTNAME.test(r.host) || IPV6_BRACKETED.test(r.host))) return null;
  if (typeof r.port !== 'number' || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return null;
  if (typeof r.authKind !== 'string' || !HOST_AUTH_KINDS.includes(r.authKind)) return null;
  if (typeof r.managedKey !== 'boolean') return null;
  if (typeof r.enrollmentStatus !== 'string' || !HOST_ENROLLMENT_STATUSES.includes(r.enrollmentStatus)) return null;
  if (r.privateKeyPath !== undefined && (typeof r.privateKeyPath !== 'string' || r.privateKeyPath.trim() === '')) return null;
  if (r.authKind === 'key' && r.privateKeyPath === undefined) return null;
  for (const key of ['enrollmentDetail', 'enrolledAt', 'lastProbeAt', 'hostKeyFingerprint', 'defaultFolder'] as const) {
    const v = r[key];
    if (v !== undefined && typeof v !== 'string') return null;
  }
  if (r.lastProbeOk !== undefined && typeof r.lastProbeOk !== 'boolean') return null;
  if (r.memoryServer !== undefined && typeof r.memoryServer !== 'boolean') return null;
  // Identity color: the shared gate (plan §7) — a hand-edited state.json can
  // never smuggle a raw string into a renderer style attribute.
  if (r.color !== undefined && !isValidHostColor(r.color)) return null;
  if (r.prerequisites !== undefined) {
    if (typeof r.prerequisites !== 'object' || r.prerequisites === null || Array.isArray(r.prerequisites)) return null;
    for (const value of Object.values(r.prerequisites as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) return null;
      const v = value as Record<string, unknown>;
      if (typeof v.ok !== 'boolean') return null;
      if (v.version !== undefined && typeof v.version !== 'string') return null;
      if (v.path !== undefined && typeof v.path !== 'string') return null;
    }
  }
  // Settings-sync bookkeeping (per-host providers T3): plain data only —
  // provider-id strings, timestamps, and a string→string hash map.
  if (r.settingsSync !== undefined) {
    if (typeof r.settingsSync !== 'object' || r.settingsSync === null || Array.isArray(r.settingsSync)) return null;
    const ss = r.settingsSync as Record<string, unknown>;
    if (!Array.isArray(ss.providers) || !ss.providers.every((p) => typeof p === 'string' && PROVIDER_IDS.has(p))) return null;
    if (ss.lastSyncAt !== undefined && typeof ss.lastSyncAt !== 'string') return null;
    if (ss.lastSyncHashes !== undefined) {
      if (typeof ss.lastSyncHashes !== 'object' || ss.lastSyncHashes === null || Array.isArray(ss.lastSyncHashes)) return null;
      if (!Object.values(ss.lastSyncHashes as Record<string, unknown>).every((h) => typeof h === 'string')) return null;
      // Audit T3 #4: keys become sftp paths in driftedPaths — same shape the
      // builder emits (home-relative posix, no traversal). A hand-edited
      // `../../x` key must drop the record, not aim the seam at `..`.
      const hashKeys = Object.keys(ss.lastSyncHashes as Record<string, unknown>);
      if (!hashKeys.every((k) => k.startsWith('~/') && !k.includes('\\') && !k.split('/').includes('..'))) return null;
    }
  }
  // Normalized copy: known fields only, trimmed name — a hand-edited
  // state.json cannot smuggle extra keys into the renderer.
  const record: HostRecord = {
    id: r.id.toLowerCase(),
    name,
    user: r.user,
    host: r.host,
    port: r.port,
    authKind: r.authKind as HostAuthKind,
    managedKey: r.managedKey,
    enrollmentStatus: r.enrollmentStatus as HostEnrollmentStatus,
  };
  if (r.privateKeyPath !== undefined) record.privateKeyPath = r.privateKeyPath as string;
  if (r.enrollmentDetail !== undefined) record.enrollmentDetail = r.enrollmentDetail as string;
  if (r.enrolledAt !== undefined) record.enrolledAt = r.enrolledAt as string;
  if (r.lastProbeAt !== undefined) record.lastProbeAt = r.lastProbeAt as string;
  if (r.lastProbeOk !== undefined) record.lastProbeOk = r.lastProbeOk as boolean;
  if (r.hostKeyFingerprint !== undefined) record.hostKeyFingerprint = r.hostKeyFingerprint as string;
  if (r.prerequisites !== undefined) record.prerequisites = r.prerequisites as HostRecord['prerequisites'];
  if (r.defaultFolder !== undefined) record.defaultFolder = r.defaultFolder as string;
  if (r.memoryServer !== undefined) record.memoryServer = r.memoryServer as boolean;
  if (r.color !== undefined) record.color = r.color as string;
  if (r.settingsSync !== undefined) record.settingsSync = r.settingsSync as HostRecord['settingsSync'];
  return record;
}
