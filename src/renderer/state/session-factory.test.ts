import { describe, it, expect } from 'vitest';
import { LEAD_CHARTER_MAX_BYTES, type ProjectLead, type ProjectRecord, type ProviderId } from '../../shared/types';
import type { CliProvider } from '../../main/providers/provider';
import { ClaudeProvider } from '../../main/providers/claude-provider';
import { CodexProvider } from '../../main/providers/codex-provider';
import { CopilotProvider } from '../../main/providers/copilot-provider';
import { GeminiProvider } from '../../main/providers/gemini-provider';
import { PiProvider } from '../../main/providers/pi-provider';
import { PiBoltProvider } from '../../main/providers/pi-bolt-provider';
import { OmpProvider } from '../../main/providers/omp-provider';
import { attachSessionToProject, buildCliSession, composeLeadLaunch } from './session-factory';

describe('buildCliSession', () => {
  it('omits args and envVars when not provided', () => {
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    expect(session.name).toBe('S1');
    expect(session.providerId).toBe('claude');
    expect('args' in session).toBe(false);
    expect('envVars' in session).toBe(false);
    expect(session.cliSessionId).toBeNull();
  });

  it('includes args when provided', () => {
    const session = buildCliSession({ name: 'S1', providerId: 'claude', args: '--model sonnet' });
    expect(session.args).toBe('--model sonnet');
  });

  it('includes envVars when provided', () => {
    const session = buildCliSession({ name: 'S1', providerId: 'claude', envVars: 'FOO=bar' });
    expect(session.envVars).toBe('FOO=bar');
  });

  it('includes both args and envVars when both provided', () => {
    const session = buildCliSession({
      name: 'S1',
      providerId: 'claude',
      args: '--verbose',
      envVars: 'FOO=bar\nBAZ=qux',
    });
    expect(session.args).toBe('--verbose');
    expect(session.envVars).toBe('FOO=bar\nBAZ=qux');
  });

  it('omits envVars for an empty string', () => {
    const session = buildCliSession({ name: 'S1', providerId: 'claude', envVars: '' });
    expect('envVars' in session).toBe(false);
  });
});

function makeProject(overrides: { activeSessionId?: string | null; mode?: 'tabs' | 'split' | 'swarm' } = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'P',
    path: '/p',
    sessions: [],
    activeSessionId: overrides.activeSessionId ?? null,
    layout: { mode: overrides.mode ?? 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  };
}

describe('attachSessionToProject', () => {
  it('activates the new session by default', () => {
    const project = makeProject({ activeSessionId: 'old' });
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    attachSessionToProject(project, session);
    expect(project.sessions).toEqual([session]);
    expect(project.activeSessionId).toBe(session.id);
  });

  it('activate:false appends the session and leaves activeSessionId untouched', () => {
    const project = makeProject({ activeSessionId: 'old' });
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    attachSessionToProject(project, session, { activate: false });
    expect(project.sessions).toEqual([session]);
    expect(project.activeSessionId).toBe('old');
  });

  it('activate:false keeps a null active tab null', () => {
    const project = makeProject();
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    attachSessionToProject(project, session, { activate: false });
    expect(project.activeSessionId).toBeNull();
  });

  it('activate:false still honors addToSwarm in swarm mode', () => {
    const project = makeProject({ activeSessionId: 'old', mode: 'swarm' });
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    attachSessionToProject(project, session, { addToSwarm: true, activate: false });
    expect(project.layout.splitPanes).toEqual([session.id]);
    expect(project.activeSessionId).toBe('old');
  });

  it('addToSwarm is a no-op outside swarm mode', () => {
    const project = makeProject({ mode: 'tabs' });
    const session = buildCliSession({ name: 'S1', providerId: 'claude' });
    attachSessionToProject(project, session, { addToSwarm: true, activate: false });
    expect(project.layout.splitPanes).toEqual([]);
  });
});

// --- P2 I1b: lead charter injection (team-lead-persona-plan M1) -----------

const CHARTER = 'Own the release train. Refuse unreviewed merges.';
const FENCED = `[Project lead - Dana]\n${CHARTER}\n[/Project lead]`;
const makeLead = (over: Partial<ProjectLead> = {}): ProjectLead => ({ name: 'Dana', charter: CHARTER, enabled: true, ...over });
const spawnBase = { sessionId: 'sess-1', cliSessionId: null as string | null, isResume: false, extraArgs: '' };

describe('composeLeadLaunch', () => {
  it('absent lead: both parameters pass through untouched on each lane', () => {
    expect(composeLeadLaunch({ systemPromptInjection: true, systemPrompt: 'sp', initialPrompt: 'ip' }))
      .toEqual({ systemPrompt: 'sp', initialPrompt: 'ip' });
    expect(composeLeadLaunch({ systemPromptInjection: false, systemPrompt: 'sp', initialPrompt: 'ip' }))
      .toEqual({ systemPrompt: 'sp', initialPrompt: 'ip' });
  });

  it('disabled lead and blank charter: zero delta', () => {
    expect(composeLeadLaunch({ lead: makeLead({ enabled: false }), systemPromptInjection: true }))
      .toEqual({ systemPrompt: undefined, initialPrompt: undefined });
    expect(composeLeadLaunch({ lead: makeLead({ charter: '   ' }), systemPromptInjection: false, initialPrompt: 'ip' }))
      .toEqual({ systemPrompt: undefined, initialPrompt: 'ip' });
    // A hand-edited state.json record can omit the charter: absent feature, no throw.
    expect(composeLeadLaunch({ lead: makeLead({ charter: undefined as unknown as string }), systemPromptInjection: true, systemPrompt: 'sp' }))
      .toEqual({ systemPrompt: 'sp', initialPrompt: undefined });
  });

  it('system-prompt lane: the charter rides systemPrompt verbatim when nothing else flows', () => {
    expect(composeLeadLaunch({ lead: makeLead(), systemPromptInjection: true, initialPrompt: 'ip' }))
      .toEqual({ systemPrompt: CHARTER, initialPrompt: 'ip' });
  });

  it('system-prompt lane: an existing prompt stays first and the fenced charter is appended after it', () => {
    expect(composeLeadLaunch({ lead: makeLead(), systemPromptInjection: true, systemPrompt: 'You are the CMO.' }))
      .toEqual({ systemPrompt: `You are the CMO.\n\n${FENCED}`, initialPrompt: undefined });
  });

  it('initial-prompt lane: the charter is fenced in front of the queued prompt', () => {
    expect(composeLeadLaunch({ lead: makeLead(), systemPromptInjection: false, initialPrompt: 'fix the bug' }))
      .toEqual({ systemPrompt: undefined, initialPrompt: `${FENCED}\n\nfix the bug` });
  });

  it('initial-prompt lane: a launch with no queued prompt stays untouched (no lane to carry it)', () => {
    expect(composeLeadLaunch({ lead: makeLead(), systemPromptInjection: false }))
      .toEqual({ systemPrompt: undefined, initialPrompt: undefined });
  });

  it('over-cap charter on a NO-INJECTION path does not throw (cap gates injection, not the record)', () => {
    // Copilot/Gemini launch with no queued prompt injects nothing, so an
    // over-cap charter must not refuse it - the launch carries no charter.
    const over = 'x'.repeat(LEAD_CHARTER_MAX_BYTES + 1);
    expect(composeLeadLaunch({ lead: makeLead({ charter: over }), systemPromptInjection: false }))
      .toEqual({ systemPrompt: undefined, initialPrompt: undefined });
  });

  it('oversize charter throws naming the cap instead of truncating', () => {
    expect(() => composeLeadLaunch({ lead: makeLead({ charter: 'x'.repeat(LEAD_CHARTER_MAX_BYTES + 1) }), systemPromptInjection: true }))
      .toThrow(`Charter is ${LEAD_CHARTER_MAX_BYTES + 1} bytes; the cap is ${LEAD_CHARTER_MAX_BYTES} bytes.`);
  });

  it('cap is bytes, not characters (a multi-byte charter over budget throws at half the char count)', () => {
    expect(() => composeLeadLaunch({ lead: makeLead({ charter: 'é'.repeat(LEAD_CHARTER_MAX_BYTES) }), systemPromptInjection: true }))
      .toThrow(`Charter is ${LEAD_CHARTER_MAX_BYTES * 2} bytes; the cap is ${LEAD_CHARTER_MAX_BYTES} bytes.`);
  });

  it('a charter at exactly the cap launches', () => {
    const charter = 'x'.repeat(LEAD_CHARTER_MAX_BYTES);
    expect(composeLeadLaunch({ lead: makeLead({ charter }), systemPromptInjection: true }).systemPrompt).toBe(charter);
  });
});

const providers: [ProviderId, CliProvider][] = [
  ['claude', new ClaudeProvider()],
  ['codex', new CodexProvider()],
  ['copilot', new CopilotProvider()],
  ['gemini', new GeminiProvider()],
  ['pi', new PiProvider()],
  ['pi-bolt', new PiBoltProvider()],
  ['omp', new OmpProvider()],
];

describe('lead charter argv per provider', () => {
  it('covers all seven providers, and only Claude/Codex/Pi/Pi-Bolt/OMP declare the system-prompt lane', () => {
    expect(providers.map(([id]) => id)).toEqual(['claude', 'codex', 'copilot', 'gemini', 'pi', 'pi-bolt', 'omp']);
    expect(providers.filter(([, p]) => p.meta.capabilities.systemPromptInjection).map(([id]) => id))
      .toEqual(['claude', 'codex', 'pi', 'pi-bolt', 'omp']);
  });

  for (const [id, provider] of providers) {
    const lane = provider.meta.capabilities.systemPromptInjection;
    it(`${id}: absent lead is a byte-identical argv`, () => {
      const composed = composeLeadLaunch({ systemPromptInjection: lane, systemPrompt: 'sp', initialPrompt: 'ip' });
      expect(provider.buildArgs({ ...spawnBase, ...composed }))
        .toEqual(provider.buildArgs({ ...spawnBase, systemPrompt: 'sp', initialPrompt: 'ip' }));
    });

    it(`${id}: disabled lead is a byte-identical argv`, () => {
      const composed = composeLeadLaunch({ lead: makeLead({ enabled: false }), systemPromptInjection: lane, systemPrompt: 'sp', initialPrompt: 'ip' });
      expect(provider.buildArgs({ ...spawnBase, ...composed }))
        .toEqual(provider.buildArgs({ ...spawnBase, systemPrompt: 'sp', initialPrompt: 'ip' }));
    });

    it(`${id}: enabled lead lands the charter in exactly one argv element`, () => {
      const composed = composeLeadLaunch({ lead: makeLead(), systemPromptInjection: lane, initialPrompt: lane ? undefined : 'fix the bug' });
      const args = provider.buildArgs({ ...spawnBase, ...composed });
      const carriers = args.filter((arg) => arg.includes(CHARTER));
      expect(carriers).toHaveLength(1);
      expect(carriers[0]).toContain(lane ? CHARTER : `${FENCED}\n\nfix the bug`);
    });

    it(`${id}: enabled lead composes AFTER an existing team prompt without replacing it`, () => {
      const composed = composeLeadLaunch({ lead: makeLead(), systemPromptInjection: lane, systemPrompt: 'You are the CMO.', initialPrompt: 'fix the bug' });
      const args = provider.buildArgs({ ...spawnBase, ...composed });
      const carriers = args.filter((arg) => arg.includes(CHARTER));
      expect(carriers).toHaveLength(1);
      const carrier = carriers[0];
      if (lane) {
        expect(carrier).toContain('You are the CMO.');
        expect(carrier.indexOf('You are the CMO.')).toBeLessThan(carrier.indexOf(FENCED));
      } else {
        expect(carrier.startsWith(FENCED)).toBe(true);
        expect(carrier.endsWith('fix the bug')).toBe(true);
      }
    });
  }

  for (const [id, provider] of providers.filter(([, p]) => !p.meta.capabilities.systemPromptInjection)) {
    it(`${id}: no queued prompt means no charter in argv (the launch stays as before)`, () => {
      const composed = composeLeadLaunch({ lead: makeLead(), systemPromptInjection: false });
      expect(provider.buildArgs({ ...spawnBase, ...composed })).toEqual([]);
    });
  }
});
