import { appState } from './state.js';
import { getProviderCapabilities } from './provider-availability.js';
import type { Profile } from '../shared/types.js';

/** Profiles whose provider declares `capabilities.profiles` (today: Claude, Pi). */
export function profileCapableProfiles(): Profile[] {
  return appState.profiles.filter((p) => getProviderCapabilities(p.providerId)?.profiles === true);
}

/** Disambiguating option label for a profile across providers: "Name · provider". */
export function profileOptionLabel(p: Profile): string {
  return `${p.name} · ${p.providerId}`;
}
