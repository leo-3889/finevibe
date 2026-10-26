import { describe, expect, it } from 'vitest';
import { defaultProfileKey, keyMatchesProvider, profileHost, resolveDefaultProfileId } from './profile-keys.js';

describe('profileHost', () => {
  it('reads pre-Phase-2 profiles (no hostId) as local', () => {
    expect(profileHost({})).toBe('local');
  });
  it('passes an explicit host through', () => {
    expect(profileHost({ hostId: 'host-1' })).toBe('host-1');
  });
});

describe('defaultProfileKey', () => {
  it('keeps the bare providerId for local (legacy values are already keyed this way)', () => {
    expect(defaultProfileKey(undefined, 'claude')).toBe('claude');
    expect(defaultProfileKey('local', 'claude')).toBe('claude');
  });
  it('prefixes remote hosts', () => {
    expect(defaultProfileKey('host-1', 'claude')).toBe('host-1|claude');
  });
});

describe('keyMatchesProvider', () => {
  it('matches the bare key and every host-prefixed key of one provider', () => {
    expect(keyMatchesProvider('claude', 'claude')).toBe(true);
    expect(keyMatchesProvider('host-1|claude', 'claude')).toBe(true);
    expect(keyMatchesProvider('claude', 'pi')).toBe(false);
    expect(keyMatchesProvider('host-1|claude', 'pi')).toBe(false);
    // A host named "x" must not make "|claude"-style suffixes leak across.
    expect(keyMatchesProvider('claude|weird', 'claude')).toBe(false);
  });
});

describe('resolveDefaultProfileId', () => {
  const prefs = { defaultProfiles: { claude: 'local-prof', 'host-1|claude': 'remote-prof' } };
  it('local (and undefined host) reads the bare key', () => {
    expect(resolveDefaultProfileId(prefs, 'claude')).toBe('local-prof');
    expect(resolveDefaultProfileId(prefs, 'claude', 'local')).toBe('local-prof');
  });
  it('a remote host reads ONLY its own key', () => {
    expect(resolveDefaultProfileId(prefs, 'claude', 'host-1')).toBe('remote-prof');
    // No fallback to the local default: its config dir does not exist there.
    expect(resolveDefaultProfileId(prefs, 'claude', 'host-2')).toBeUndefined();
  });
  it('tolerates a missing map', () => {
    expect(resolveDefaultProfileId({}, 'claude', 'host-1')).toBeUndefined();
  });
});
