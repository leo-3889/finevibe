import { describe, it, expect } from 'vitest';
import {
  parseEnvVars,
  findInvalidEnvLines,
  partitionUserEnv,
  findProviderOwnedEnvKeys,
  providerOwnedEnvReason,
} from './env-vars';

describe('parseEnvVars', () => {
  it('returns an empty object for empty/whitespace input', () => {
    expect(parseEnvVars('')).toEqual({});
    expect(parseEnvVars('   \n  \n')).toEqual({});
  });

  it('parses a single KEY=VALUE pair', () => {
    expect(parseEnvVars('FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('parses multiple pairs across lines', () => {
    expect(parseEnvVars('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('keeps "=" characters in the value (splits on the first only)', () => {
    expect(parseEnvVars('URL=https://x?a=1&b=2')).toEqual({ URL: 'https://x?a=1&b=2' });
  });

  it('trims keys and skips blank lines', () => {
    expect(parseEnvVars('\n  FOO=bar\n\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips a trailing CRLF carriage return from values', () => {
    expect(parseEnvVars('FOO=bar\r\nBAZ=qux\r')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips malformed lines (no "=" or empty key)', () => {
    expect(parseEnvVars('NOEQUALS\n=value\nGOOD=1')).toEqual({ GOOD: '1' });
  });
});

describe('profile-owned environment', () => {
  it('drops casing variants that Windows treats as the same variable', () => {
    expect(partitionUserEnv({ claude_config_dir: '/other', Pi_Coding_Agent_Dir: '/other', SAFE: 'yes' }, true)).toEqual({
      allowed: { SAFE: 'yes' },
      dropped: ['claude_config_dir', 'Pi_Coding_Agent_Dir'],
    });
  });

  it('drops the pi/omp profile and directory selectors in any casing on Windows', () => {
    expect(partitionUserEnv({ OMP_PROFILE: 'x', pi_profile: 'y', PI_CONFIG_DIR: 'z', PI_CODING_AGENT_DIR: 'w', SAFE: 'yes' }, true)).toEqual({
      allowed: { SAFE: 'yes' },
      dropped: ['OMP_PROFILE', 'pi_profile', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR'],
    });
  });

  it('drops the per-session hook status keys in any casing on Windows', () => {
    expect(partitionUserEnv({ FINEVIBE_SESSION_ID: 'x', claude_ide_session_id: 'y', SAFE: 'yes' }, true)).toEqual({
      allowed: { SAFE: 'yes' },
      dropped: ['FINEVIBE_SESSION_ID', 'claude_ide_session_id'],
    });
  });

  it('drops COPILOT_HOME so a session cannot relocate the Copilot data tree', () => {
    // The transcript readers only scan the pinned home; a session that
    // overrides COPILOT_HOME writes transcripts where the app never looks.
    expect(partitionUserEnv({ COPILOT_HOME: '/other', copilot_home: '/x', SAFE: 'yes' }, true)).toEqual({
      allowed: { SAFE: 'yes' },
      dropped: ['COPILOT_HOME', 'copilot_home'],
    });
  });

  it('drops only the exact-case name on POSIX, where the child env is case-sensitive', () => {
    // S1-08: `claude_config_dir=/x` is inert in a POSIX child, so folding it
    // would report a dropped override that never existed.
    expect(partitionUserEnv({ CLAUDE_CONFIG_DIR: '/other', claude_config_dir: '/inert', SAFE: 'yes' }, false)).toEqual({
      allowed: { claude_config_dir: '/inert', SAFE: 'yes' },
      dropped: ['CLAUDE_CONFIG_DIR'],
    });
  });

  it('reports nothing for a clean environment on either platform', () => {
    const env = { PATH: '/usr/local/bin', ANTHROPIC_API_KEY: 'sk' };
    expect(partitionUserEnv(env, true).dropped).toEqual([]);
    expect(partitionUserEnv(env, false).dropped).toEqual([]);
  });

  it('findProviderOwnedEnvKeys mirrors partitionUserEnv on both platforms', () => {
    const env = { OMP_PROFILE: 'x', omp_profile: 'y' };
    expect(findProviderOwnedEnvKeys(env, true)).toEqual(['OMP_PROFILE', 'omp_profile']);
    expect(findProviderOwnedEnvKeys(env, false)).toEqual(['OMP_PROFILE']);
    expect(findProviderOwnedEnvKeys(env, true)).toEqual(partitionUserEnv(env, true).dropped);
    expect(findProviderOwnedEnvKeys(env, false)).toEqual(partitionUserEnv(env, false).dropped);
  });

  it('explains every owned key case-insensitively so the report is actionable', () => {
    // The renderer warns about a typed key on POSIX too, where only the
    // exact-case name is live — the explanation must still resolve.
    expect(providerOwnedEnvReason('claude_config_dir')).toMatch(/profile/i);
    expect(providerOwnedEnvReason('FINEVIBE_SESSION_ID')).toMatch(/status files/);
    expect(providerOwnedEnvReason('SOMETHING_ELSE')).toMatch(/pinned .*profile/);
  });
});

describe('findInvalidEnvLines', () => {
  it('returns no invalid lines for valid input', () => {
    expect(findInvalidEnvLines('FOO=bar\nBAZ=qux')).toEqual([]);
  });

  it('ignores blank lines', () => {
    expect(findInvalidEnvLines('\nFOO=bar\n\n')).toEqual([]);
  });

  it('flags lines without "=" and lines with an empty key', () => {
    expect(findInvalidEnvLines('NOEQUALS\nFOO=bar\n=value')).toEqual(['NOEQUALS', '=value']);
  });

  it('agrees with parseEnvVars on what is kept vs rejected', () => {
    const text = 'A=1\nBAD\nB=2\n=nope';
    const kept = Object.keys(parseEnvVars(text));
    const rejected = findInvalidEnvLines(text);
    expect(kept).toEqual(['A', 'B']);
    expect(rejected).toEqual(['BAD', '=nope']);
  });
});
