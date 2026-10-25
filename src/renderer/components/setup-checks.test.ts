import { describe, it, expect } from 'vitest';
import type { CliProviderMeta, SettingsValidationResult } from '../../shared/types.js';
import { hasProviderIssue, type ProviderStatus } from './setup-checks.js';

function makeMeta(overrides: Partial<CliProviderMeta['capabilities']> = {}): CliProviderMeta {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    defaultContextWindowSize: 200_000,
    capabilities: {
      sessionResume: false,
      costTracking: false,
      contextWindow: false,
      hookStatus: false,
      configReading: false,
      shiftEnterNewline: false,
      pendingPromptTrigger: 'session-start',
      ...overrides,
    },
  };
}

function makeValidation(overrides: Partial<SettingsValidationResult> = {}): SettingsValidationResult {
  return {
    statusLine: 'finevibe',
    hooks: 'complete',
    hookDetails: {},
    ...overrides,
  };
}

function makeStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    meta: makeMeta(),
    validation: makeValidation(),
    binaryOk: true,
    ...overrides,
  };
}

describe('hasProviderIssue', () => {
  // SA-P2-1: a declined consent covering the current foreign command is a
  // deliberate Keep — not an issue, no red badge, no Fix CTA.
  it('returns false for a foreign statusLine the user deliberately kept (SA-P2-1)', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true }),
      validation: makeValidation({ statusLine: 'foreign', foreignStatusLineCommand: 'other-tool', userKeptStatusLine: true }),
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  it('returns true for a foreign statusLine with no matching Keep (SA-P2-1)', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true }),
      validation: makeValidation({ statusLine: 'foreign', foreignStatusLineCommand: 'other-tool' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('keeps hook issues red even when the statusLine was kept (SA-P2-1)', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true, hookStatus: true }),
      validation: makeValidation({ statusLine: 'foreign', userKeptStatusLine: true, hooks: 'partial' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('returns false when binary is not installed', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true, hookStatus: true }),
      validation: makeValidation({ statusLine: 'missing', hooks: 'missing' }),
      binaryOk: false,
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  it('returns true when binary installed and statusLine misconfigured with costTracking', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true }),
      validation: makeValidation({ statusLine: 'missing' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('returns true when binary installed and statusLine misconfigured with contextWindow', () => {
    const status = makeStatus({
      meta: makeMeta({ contextWindow: true }),
      validation: makeValidation({ statusLine: 'foreign' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('returns true when binary installed and hooks incomplete', () => {
    const status = makeStatus({
      meta: makeMeta({ hookStatus: true }),
      validation: makeValidation({ hooks: 'partial' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('returns true when binary installed and hooks missing', () => {
    const status = makeStatus({
      meta: makeMeta({ hookStatus: true }),
      validation: makeValidation({ hooks: 'missing' }),
    });
    expect(hasProviderIssue(status)).toBe(true);
  });

  it('returns false when binary installed and everything configured', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: true, hookStatus: true }),
      validation: makeValidation({ statusLine: 'finevibe', hooks: 'complete' }),
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  it('returns false when statusLine misconfigured but no costTracking/contextWindow capability', () => {
    const status = makeStatus({
      meta: makeMeta({ costTracking: false, contextWindow: false }),
      validation: makeValidation({ statusLine: 'missing' }),
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  it('returns false when hooks incomplete but no hookStatus capability', () => {
    const status = makeStatus({
      meta: makeMeta({ hookStatus: false }),
      validation: makeValidation({ hooks: 'partial' }),
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  // Project-scope hooks (Copilot) with no project open are unvalidatable —
  // the row renders neutral and must not light the badge.
  it('returns false for a neutral project-scope hook row', () => {
    const status = makeStatus({
      meta: makeMeta({ hookStatus: true, hookScope: 'project' }),
      validation: makeValidation({ hooks: 'missing' }),
      hooksNeutral: true,
    });
    expect(hasProviderIssue(status)).toBe(false);
  });

  it('returns true for a project-scope provider validated against an open project', () => {
    const status = makeStatus({
      meta: makeMeta({ hookStatus: true, hookScope: 'project' }),
      validation: makeValidation({ hooks: 'missing' }),
      hooksNeutral: false,
    });
    expect(hasProviderIssue(status)).toBe(true);
  });
});
