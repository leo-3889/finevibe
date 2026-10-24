import type { ProviderId, CliProviderMeta } from '../../shared/types';
import type { CliProvider } from './provider';
import { invalidateBinaryCache } from './resolve-binary';
import { ClaudeProvider } from './claude-provider';
import { CodexProvider } from './codex-provider';
import { CopilotProvider } from './copilot-provider';
import { GeminiProvider } from './gemini-provider';
import { PiProvider } from './pi-provider';
import { OmpProvider } from './omp-provider';
import { PiBoltProvider } from './pi-bolt-provider';

const providers = new Map<ProviderId, CliProvider>();

export function initProviders(): void {
  registerProvider(new ClaudeProvider());
  registerProvider(new CodexProvider());
  registerProvider(new CopilotProvider());
  registerProvider(new GeminiProvider());
  registerProvider(new PiProvider());
  registerProvider(new OmpProvider());
  registerProvider(new PiBoltProvider());
}

export function registerProvider(provider: CliProvider): void {
  providers.set(provider.meta.id, provider);
  invalidateAvailabilityCache();
}

export function getProvider(id: ProviderId): CliProvider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown CLI provider: ${id}`);
  }
  return provider;
}

export function getAllProviders(): CliProvider[] {
  return Array.from(providers.values());
}

export function getProviderMeta(id: ProviderId): CliProviderMeta {
  return getProvider(id).meta;
}

export function getAllProviderMetas(): CliProviderMeta[] {
  return getAllProviders().map(p => p.meta);
}

// Availability probes (validatePrerequisites → validateBinaryExists: bin-dir
// scans, nvm walk, `which`/`npm prefix -g` subprocesses) used to run for all
// seven providers on every getAvailableProviderIds call (readiness analysis,
// the provider IPC). The result is cached for the process; the explicit
// invalidation hook below clears it plus the binary probe cache. Call it
// after provider install/uninstall or a settings change that moves binaries
// on PATH. registerProvider runs it, so initProviders refreshes at startup.
let availabilityCache: ProviderId[] | null = null;

export function getAvailableProviderIds(): ProviderId[] {
  if (!availabilityCache) {
    availabilityCache = getAllProviders()
      .filter(p => p.validatePrerequisites())
      .map(p => p.meta.id);
  }
  return availabilityCache;
}

/** S4-03: async twin of getAvailableProviderIds — same process cache, probed
 * with the async binary probe (validatePrerequisitesAsync → disk-tier cache
 * + spawn stages off the main thread). Consumers that run the sync getter
 * afterwards (analyzeReadiness) hit this cache, so warming costs no extra
 * probes. Providers without the twin keep the sync probe, mirroring main.ts. */
export async function getAvailableProviderIdsAsync(): Promise<ProviderId[]> {
  if (!availabilityCache) {
    const providers = getAllProviders();
    const availability = await Promise.all(providers.map(p => (
      p.validatePrerequisitesAsync
        ? p.validatePrerequisitesAsync()
        : Promise.resolve(p.validatePrerequisites())
    )));
    availabilityCache = providers.filter((_, i) => availability[i]).map(p => p.meta.id);
  }
  return availabilityCache;
}

/** Explicit invalidation hook for the cached availability probes. */
export function invalidateAvailabilityCache(): void {
  availabilityCache = null;
  invalidateBinaryCache();
}
