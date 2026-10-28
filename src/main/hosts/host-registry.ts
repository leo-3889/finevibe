// Host registry (multi-host Phase 1) — CRUD over `PersistedState.hosts`.
//
// Main-owned: every mutation goes through `loadState`/`saveState` (house
// R7: last-write-wins on state.json). The renderer sends `id` + a
// shape-validated draft; `validateHostRecordShape` in main rejects anything
// the shared module rejects. Secrets never cross through here (they live in
// secrets.ts); this module owns records only.

import * as fs from 'fs';
import * as path from 'path';
import type { HostRecord } from '../../shared/types';
import { validateHostRecordShape } from '../../shared/ssh-host';
import { pickHostColor } from '../../shared/host-colors';
import { loadState, saveState } from '../store';
import { deleteHostSecret } from './secrets';
import { closeConnection } from './ssh-client';

/** Validation error carrying a machine-readable reason for the wizard. */
export class HostValidationError extends Error {
  constructor(reason: string) {
    super(`invalid host draft: ${reason}`);
    this.name = 'HostValidationError';
  }
}

/** List all hosts (normalized copy — the store cache is the source). */
export function listHosts(): HostRecord[] {
  return [...(loadState().hosts ?? [])];
}

/** One host by id, or null. */
export function getHost(hostId: string): HostRecord | null {
  return listHosts().find((h) => h.id === hostId) ?? null;
}

/**
 * Create a host from a draft (unknown shape from the renderer). Generates
 * the id, validates via the shared grammar, persists. Returns the record.
 * For managed key auth the caller (enrollment wizard) generates the keypair
 * first and passes `privateKeyPath` + `managedKey: true`.
 */
export function createHost(draft: unknown): HostRecord {
  const raw = typeof draft === 'object' && draft !== null ? { ...(draft as Record<string, unknown>) } : null;
  if (!raw) throw new HostValidationError('draft must be an object');
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    raw.id = crypto.randomUUID();
  }
  if (raw.port === undefined) raw.port = 22;
  if (typeof raw.name === 'string') raw.name = raw.name.trim();
  if (raw.color === undefined) {
    // Per-host providers plan §2: identity color assigned at creation,
    // round-robin over the shared palette (editable later via hosts:update).
    raw.color = pickHostColor(loadState().hosts.map((h) => h.color));
  }
  const record = validateHostRecordShape(raw);
  if (!record) throw new HostValidationError('failed validateHostRecordShape');
  const state = loadState();
  if (state.hosts.some((h) => h.id === record.id)) {
    throw new HostValidationError(`host id ${record.id} already exists`);
  }
  state.hosts.push(record);
  saveState(state);
  return record;
}

/**
 * Update mutable fields of an existing host. `id` is immutable; status and
 * probe fields update in place. Validates the merged record before saving.
 */
export function updateHost(hostId: string, patch: Partial<Omit<HostRecord, 'id'>>): HostRecord {
  const state = loadState();
  const idx = state.hosts.findIndex((h) => h.id === hostId);
  if (idx === -1) throw new HostValidationError(`unknown host id ${hostId}`);
  const merged = validateHostRecordShape({ ...state.hosts[idx], ...patch, id: hostId });
  if (!merged) throw new HostValidationError('patch produced an invalid record');
  state.hosts[idx] = merged;
  saveState(state);
  return merged;
}

/**
 * Delete a host: record + secret + managed key files + cached connection.
 * Caller confirms the unenroll dialog; key-file removal for managed keys is
 * the caller's (enrollment) — here we drop the record and the secret.
 */
export function deleteHost(hostId: string): void {
  const state = loadState();
  const idx = state.hosts.findIndex((h) => h.id === hostId);
  if (idx === -1) return;
  const [record] = state.hosts.splice(idx, 1);
  saveState(state);
  deleteHostSecret(record.id);
  // Key passphrases live under the keypass: key (audit T1 #2).
  deleteHostSecret(`keypass:${record.id}`);
  if (record.managedKey && record.privateKeyPath) {
    // Managed key dir lives under userData/hosts/<id>; remove the pair.
    const dir = path.dirname(record.privateKeyPath);
    try {
      if (path.basename(record.privateKeyPath) === 'id_ed25519') {
        for (const f of ['id_ed25519', 'id_ed25519.pub']) {
          const p = path.join(dir, f);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
    } catch {
      // Best-effort: the record is already gone; a leftover file is cosmetic.
    }
  }
  closeConnection(hostId);
}

/** Write enrollment status + detail (state machine calls this per step). */
export function setEnrollmentStatus(
  hostId: string,
  status: HostRecord['enrollmentStatus'],
  detail?: string,
): HostRecord | null {
  return updateHost(hostId, {
    enrollmentStatus: status,
    ...(detail !== undefined ? { enrollmentDetail: detail } : {}),
  });
}
