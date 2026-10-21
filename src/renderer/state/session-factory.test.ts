import { describe, it, expect } from 'vitest';
import type { ProjectRecord } from '../../shared/types';
import { attachSessionToProject, buildCliSession } from './session-factory';

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
