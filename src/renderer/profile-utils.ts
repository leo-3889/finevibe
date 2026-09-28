import { appState } from './state.js';
import { getProviderCapabilities } from './provider-availability.js';
import type { SelectOption } from './components/custom-select.js';
import type { Profile, ProjectRecord, ProviderId } from '../shared/types.js';

/** Profiles whose provider declares `capabilities.profiles` (today: Claude, Pi, OMP). */
export function profileCapableProfiles(): Profile[] {
  return appState.profiles.filter((p) => getProviderCapabilities(p.providerId)?.profiles === true);
}

/**
 * Profile pick options for one coding tool: bare names, no provider suffix
 * (the tool is already known to the picker). Empty for providers without
 * profile support or with no profiles defined.
 */
export function providerProfileOptions(providerId: ProviderId): SelectOption[] {
  if (getProviderCapabilities(providerId)?.profiles !== true) return [];
  return appState.profiles
    .filter((p) => p.providerId === providerId)
    .map((p) => ({ value: p.id, label: p.name }));
}

/**
 * The project's current coding tool: the active session's provider, falling
 * back to the global default. Used to scope project-level profile pickers
 * (project settings, new project) to a single tool.
 */
export function projectProviderId(project: ProjectRecord): ProviderId {
  const active = project.sessions.find((s) => s.id === project.activeSessionId);
  return active?.providerId ?? appState.preferences.defaultProvider ?? 'claude';
}
