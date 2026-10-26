// Renderer-side live cache of the main-owned host registry (Phase 2 T4).
// The renderer keeps no host state of its own; this is the ONE loader +
// subscriber feeding the sidebar host tab row, project-card colors,
// active-session/tab chips and the offline banner. Reads are copies of
// `hosts:list` output; `hosts:status` events (enrollment progress, parent §11)
// trigger a reload.

import type { HostRecord } from '../shared/types.js';
import { LOCAL_HOST_ID } from '../shared/types.js';
import { isValidHostColor } from '../shared/host-colors.js';
import { t } from './i18n.js';

let hosts: HostRecord[] = [];
let loaded = false;
const listeners = new Set<() => void>();
// Session-lifetime reachability answers from on-demand `hosts:test` probes
// (parent §11 offline banner). Bounded by the registry size, and a host's
// entry is replaced, never accumulated. The durable part is the record's
// own lastProbeOk; this map only carries fresh Reconnect results.
const probeOk = new Map<string, boolean>();

function notify(): void {
  for (const cb of listeners) cb();
}

export async function loadHosts(): Promise<void> {
  hosts = await window.finevibe.hosts.list();
  loaded = true;
  notify();
}

/** True after the FIRST successful `hosts:list` — consumers that treat
 * "host id not in the registry" as "host removed" (the tab-row fallback,
 * audit T4 #1) must not act before this: at startup the registry is
 * legitimately empty, and a swallowed fetch error must not wipe the
 * persisted active host. */
export function hostsLoaded(): boolean {
  return loaded;
}

/** Load once and reload on every registry-status event; call at startup. */
export function initHostRegistry(): void {
  void loadHosts().catch(() => {});
  window.finevibe.hosts.onStatus(() => {
    void loadHosts().catch(() => {});
  });
}

export function onHostsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getHosts(): readonly HostRecord[] {
  return hosts;
}

export function getHost(hostId: string): HostRecord | undefined {
  return hosts.find((h) => h.id === hostId);
}

/** Tab-strip list: enrolled (and partial) hosts in registry order; draft /
 * probing / failed records live only in Settings → Hosts (parent §11). */
export function getEnrolledHosts(): HostRecord[] {
  return hosts.filter((h) => h.enrollmentStatus === 'enrolled' || h.enrollmentStatus === 'partial');
}

/** Validated identity color; '' for Local, unknown hosts and junk values. */
export function getHostColor(hostId: string | undefined): string {
  if (!hostId || hostId === LOCAL_HOST_ID) return '';
  const color = getHost(hostId)?.color;
  return isValidHostColor(color) ? color : '';
}

/** Display name; Local renders the translated neutral label. */
export function getHostName(hostId: string | undefined): string {
  if (!hostId || hostId === LOCAL_HOST_ID) return t('sidebar.hostTabs.local');
  return getHost(hostId)?.name ?? hostId;
}

/** Offline = the freshest reachability answer is "no": a session-probe
 * result when one exists, else the record's last durable probe. */
export function isHostOffline(hostId: string): boolean {
  if (hostId === LOCAL_HOST_ID) return false;
  const probe = probeOk.get(hostId);
  if (probe !== undefined) return !probe;
  return getHost(hostId)?.lastProbeOk === false;
}

/** Reconnect (parent §11): one on-demand testHost, remembered, broadcast. */
export async function reconnectHost(hostId: string): Promise<boolean> {
  const res = await window.finevibe.hosts.test(hostId);
  probeOk.set(hostId, res.ok);
  await loadHosts().catch(() => {});
  return res.ok;
}
