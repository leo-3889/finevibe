import type { ProviderId, CliProviderMeta, CliProviderCapabilities } from '../shared/types.js';
import { LOCAL_HOST_ID } from '../shared/types.js';

let cachedProviders: CliProviderMeta[] | null = null;
// Per-host providers plan §2: availability is a per-machine fact, so the
// cache is keyed by hostId. 'local' probes binaries; remote hosts hydrate
// from the registry record's enrollment-time prereq probe (no probing, no
// SSH on this path — hosts:list already carries prerequisites).
const cachedAvailability = new Map<string, Map<ProviderId, boolean>>();
const availabilityLoadPromises = new Map<string, Promise<void>>();

export async function loadProviderMetas(): Promise<void> {
  if (!cachedProviders) {
    cachedProviders = await window.finevibe.provider.listProviders();
  }
}

export async function loadProviderAvailability(hostId: string = LOCAL_HOST_ID): Promise<void> {
  if (cachedAvailability.has(hostId)) return;
  const inflight = availabilityLoadPromises.get(hostId);
  if (inflight) return inflight;
  const promise = (async () => {
    await loadProviderMetas();
    if (hostId === LOCAL_HOST_ID) {
      const checks = await Promise.all(
        cachedProviders!.map(async p => ({ id: p.id, ok: await window.finevibe.provider.checkBinary(p.id, hostId) }))
      );
      cachedAvailability.set(hostId, new Map(checks.map(c => [c.id, c.ok])));
    } else {
      const hosts = await window.finevibe.hosts.list();
      const record = hosts.find(h => h.id === hostId);
      cachedAvailability.set(hostId, new Map(
        cachedProviders!.map(p => [p.id, record?.prerequisites?.[p.id]?.ok === true])
      ));
    }
  })();
  availabilityLoadPromises.set(hostId, promise);
  try {
    await promise;
  } finally {
    availabilityLoadPromises.delete(hostId);
  }
}

function availabilityFor(hostId: string): Map<ProviderId, boolean> | null {
  return cachedAvailability.get(hostId) ?? null;
}

export function hasMultipleAvailableProviders(hostId: string = LOCAL_HOST_ID): boolean {
  const availability = availabilityFor(hostId);
  if (!availability) return false;
  let count = 0;
  for (const ok of availability.values()) {
    if (ok) count++;
    if (count > 1) return true;
  }
  return false;
}

export function getProviderAvailabilitySnapshot(hostId: string = LOCAL_HOST_ID): {
  providers: CliProviderMeta[];
  availability: Map<ProviderId, boolean>;
} | null {
  const availability = availabilityFor(hostId);
  if (!cachedProviders || !availability) return null;
  return {
    providers: cachedProviders,
    availability,
  };
}

export function getCachedProviderMetas(): CliProviderMeta[] {
  return cachedProviders ?? [];
}

export function getAvailableProviderMetas(hostId: string = LOCAL_HOST_ID): CliProviderMeta[] {
  const availability = availabilityFor(hostId);
  if (!cachedProviders || !availability) return [];
  return cachedProviders.filter(p => availability.get(p.id));
}

export function getTeamChatProviderMetas(hostId: string = LOCAL_HOST_ID): CliProviderMeta[] {
  return getAvailableProviderMetas(hostId).filter(p => p.capabilities.systemPromptInjection);
}

/** The ids of installed providers that can run team personas (system-prompt injection). */
export function getTeamCapableProviderIds(hostId: string = LOCAL_HOST_ID): Set<ProviderId> {
  return new Set(getTeamChatProviderMetas(hostId).map((m) => m.id));
}

export function getProviderCapabilities(providerId: ProviderId): CliProviderCapabilities | null {
  if (!cachedProviders) return null;
  return cachedProviders.find(provider => provider.id === providerId)?.capabilities ?? null;
}

export function getProviderDisplayName(providerId: ProviderId): string {
  if (!cachedProviders) return providerId;
  return cachedProviders.find(provider => provider.id === providerId)?.displayName ?? providerId;
}
