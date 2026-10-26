// Host-scoped profile identity (coherence plan Phase 1, host-integration
// audit). Lives in shared/ because BOTH the pickers (profile-utils) and the
// spawn-time resolver chain (state/specialized-sessions) need it, and
// neither may import the other for it.
//
// Key rule for `Preferences.defaultProfiles`: the map is keyed
// `<providerId>` for the LOCAL host (the legacy, untouched spelling —
// pre-existing values migrate by being already correct) and
// `<hostId>|<providerId>` for a registry host. No migration step exists;
// a remote host with no key of its own has NO inherited default — a remote
// session launches bare rather than silently booting under a local
// profile's config dir (the "never silently lie" rule, docs/hosts.md).

import { LOCAL_HOST_ID } from './types.js';
import type { Profile, ProviderId } from './types.js';

/** The host a profile lives on — 'local' for every pre-Phase-2 profile. */
export function profileHost(profile: Pick<Profile, 'hostId'>): string {
  return profile.hostId ?? LOCAL_HOST_ID;
}

/** `defaultProfiles` map key: bare providerId locally, `<hostId>|<providerId>` remote. */
export function defaultProfileKey(hostId: string | undefined, providerId: ProviderId): string {
  return !hostId || hostId === LOCAL_HOST_ID ? providerId : `${hostId}|${providerId}`;
}

/** True when `key` names `providerId` on any host (profile-delete cleanup). */
export function keyMatchesProvider(key: string, providerId: ProviderId): boolean {
  return key === providerId || key.endsWith(`|${providerId}`);
}

/** The default profile id configured for a provider ON A HOST (undefined = launch bare). */
export function resolveDefaultProfileId(
  prefs: { defaultProfiles?: Record<string, string> },
  providerId: ProviderId,
  hostId?: string,
): string | undefined {
  return prefs.defaultProfiles?.[defaultProfileKey(hostId, providerId)];
}
