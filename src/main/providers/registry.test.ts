import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliProvider } from './provider';
import type { CliProviderMeta } from '../../shared/types';
import { initProviders, registerProvider, getProvider, getAllProviders, getProviderMeta, getAllProviderMetas, getAvailableProviderIds, invalidateAvailabilityCache } from './registry';

// Real providers probe the filesystem/subprocesses through resolve-binary;
// stub it so availability probes are instant and deterministic. The spy
// counts probes for the availability-cache tests.
const mockValidateBinaryExists = vi.hoisted(() => vi.fn(() => true));
const mockInvalidateBinaryCache = vi.hoisted(() => vi.fn());
vi.mock('./resolve-binary', () => ({
  resolveBinary: (name: string, cache: { path: string | null }) => (cache.path ??= name),
  validateBinaryExists: mockValidateBinaryExists,
  validateBinaryExistsAsync: vi.fn(async () => true),
  invalidateBinaryCache: mockInvalidateBinaryCache,
}));

const fakeMeta: CliProviderMeta = {
  id: 'copilot',
  displayName: 'Copilot CLI',
  binaryName: 'copilot',
  capabilities: {
    sessionResume: false,
    costTracking: false,
    contextWindow: false,
    hookStatus: false,
    configReading: false,
    shiftEnterNewline: false,
    pendingPromptTrigger: 'session-start',
    systemPromptInjection: false,
    profiles: false,
    selfTitles: false,
    polledStatus: false,
  },
  defaultContextWindowSize: 128_000,
};

function makeFakeProvider(meta: CliProviderMeta, validatePrerequisites: () => boolean = () => true): CliProvider {
  return {
    meta,
    resolveBinaryPath: () => '/usr/bin/fake',
    validatePrerequisites,
    buildEnv: (_sid, env) => env,
    buildArgs: () => [],
    installHooks: async () => {},
    installStatusScripts: () => {},
    cleanup: () => {},
    getConfig: async () => ({ mcpServers: [], agents: [], skills: [], commands: [] }),
    getShiftEnterSequence: () => null,
    validateSettings: () => ({ statusLine: 'finevibe', hooks: 'complete', hookDetails: {} }),
    reinstallSettings: () => {},
  };
}

beforeEach(() => {
  // Re-init to reset registry to only the Claude provider
  initProviders();
});

describe('initProviders', () => {
  it('registers the Claude provider', () => {
    const provider = getProvider('claude');
    expect(provider).toBeDefined();
    expect(provider.meta.id).toBe('claude');
  });

  it('registers the Codex provider', () => {
    const provider = getProvider('codex');
    expect(provider).toBeDefined();
    expect(provider.meta.id).toBe('codex');
  });

  it('registers the Copilot provider', () => {
    const provider = getProvider('copilot');
    expect(provider).toBeDefined();
    expect(provider.meta.id).toBe('copilot');
  });
});

describe('getProvider', () => {
  it('registers the Gemini provider', () => {
    const provider = getProvider('gemini');
    expect(provider).toBeDefined();
    expect(provider.meta.id).toBe('gemini');
  });

  it('throws for unknown provider ID', () => {
    expect(() => getProvider('unknown-provider' as any)).toThrow('Unknown CLI provider: unknown-provider');
  });
});

describe('registerProvider', () => {
  it('makes a custom provider retrievable', () => {
    const fake = makeFakeProvider(fakeMeta);
    registerProvider(fake);
    expect(getProvider('copilot')).toBe(fake);
  });
});

describe('getAllProviders', () => {
  it('returns all registered providers', () => {
    registerProvider(makeFakeProvider(fakeMeta));
    const all = getAllProviders();
    expect(all.length).toBe(6);
    const ids = all.map(p => p.meta.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('gemini');
    expect(ids).toContain('copilot');
    expect(ids).toContain('pi');
    expect(ids).toContain('omp');
  });
});

describe('getProviderMeta', () => {
  it('returns meta for a given provider ID', () => {
    const meta = getProviderMeta('claude');
    expect(meta.id).toBe('claude');
    expect(meta.displayName).toBe('Claude Code');
  });
});

describe('getAllProviderMetas', () => {
  it('returns meta array for all providers', () => {
    registerProvider(makeFakeProvider(fakeMeta));
    const metas = getAllProviderMetas();
    expect(metas.length).toBe(6);
    expect(metas.map(m => m.id)).toContain('codex');
    expect(metas.map(m => m.id)).toContain('gemini');
    expect(metas.map(m => m.id)).toContain('copilot');
    expect(metas.map(m => m.id)).toContain('pi');
    expect(metas.map(m => m.id)).toContain('omp');
  });
});

describe('getAvailableProviderIds', () => {
  it('returns ids of providers whose prerequisites validate', () => {
    const ids = getAvailableProviderIds();
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
  });

  it('caches probes: the second call does not re-run validatePrerequisites', () => {
    const probe = vi.fn(() => true);
    registerProvider(makeFakeProvider(fakeMeta, probe));

    const ids = getAvailableProviderIds();
    expect(ids).toContain('copilot');
    expect(probe).toHaveBeenCalledTimes(1);

    getAvailableProviderIds();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('invalidateAvailabilityCache clears the cache', () => {
    const probe = vi.fn(() => true);
    registerProvider(makeFakeProvider(fakeMeta, probe));
    getAvailableProviderIds();
    expect(probe).toHaveBeenCalledTimes(1);

    invalidateAvailabilityCache();
    getAvailableProviderIds();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('invalidateAvailabilityCache also clears the binary probe cache', () => {
    invalidateAvailabilityCache();
    expect(mockInvalidateBinaryCache).toHaveBeenCalled();
  });

  it('registerProvider invalidates, so a freshly registered provider appears', () => {
    getAvailableProviderIds();
    const fake = makeFakeProvider({ ...fakeMeta, id: 'pi' }, () => false);
    registerProvider(fake);
    expect(getAvailableProviderIds()).not.toContain('pi');
  });
});
