import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoad = vi.fn();
const mockSave = vi.fn();

vi.stubGlobal('window', {
  vibeyard: {
    store: { load: mockLoad, save: mockSave },
  },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++uuidCounter}`,
});

vi.mock('../session-cost.js', () => ({
  getCost: vi.fn().mockReturnValue(null),
  restoreCost: vi.fn(),
}));

vi.mock('../session-context.js', () => ({
  restoreContext: vi.fn(),
}));

vi.mock('../provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, _resetForTesting } from '../state';
import { getTeamChatProviderMetas } from '../provider-availability.js';
const mockGetTeamChatProviderMetas = vi.mocked(getTeamChatProviderMetas);
import { getCost } from '../session-cost.js';
const mockGetCost = vi.mocked(getCost);

beforeEach(() => {
  vi.clearAllMocks();
  uuidCounter = 0;
  mockGetCost.mockReturnValue(null);
  _resetForTesting();
});

function addProject(name = 'Test', path = '/test') {
  return appState.addProject(name, path);
}

describe('startTeamChat()', () => {
  function makeMember(): import('../../shared/types.js').TeamMember {
    return {
      id: 'm-1',
      name: 'CMO',
      role: 'Marketing',
      systemPrompt: 'You are the CMO.',
      source: 'custom',
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function metaFor(id: 'claude' | 'codex' | 'gemini' | 'copilot') {
    return {
      id,
      displayName: id,
      binaryName: id,
      capabilities: {
        sessionResume: true,
        costTracking: false,
        contextWindow: false,
        hookStatus: true,
        configReading: true,
        shiftEnterNewline: false,
        pendingPromptTrigger: 'startup-arg' as const,
        systemPromptInjection: id === 'claude' || id === 'codex',
      },
      defaultContextWindowSize: 200_000,
    };
  }

  it('falls through Gemini override to Claude when Claude is team-capable', () => {
    mockGetTeamChatProviderMetas.mockReturnValue([metaFor('claude'), metaFor('codex')]);
    const project = addProject();
    const session = appState.startTeamChat(project.id, makeMember(), 'gemini');
    expect(session?.providerId).toBe('claude');
    expect(session?.pendingSystemPrompt).toBe('You are the CMO.');
  });

  it('falls through Copilot default-provider to Claude', () => {
    mockGetTeamChatProviderMetas.mockReturnValue([metaFor('claude'), metaFor('codex')]);
    appState.setPreference('defaultProvider', 'copilot');
    const project = addProject();
    const session = appState.startTeamChat(project.id, makeMember());
    expect(session?.providerId).toBe('claude');
  });

  it('honors a Codex override when team-capable', () => {
    mockGetTeamChatProviderMetas.mockReturnValue([metaFor('claude'), metaFor('codex')]);
    const project = addProject();
    const session = appState.startTeamChat(project.id, makeMember(), 'codex');
    expect(session?.providerId).toBe('codex');
  });

  it('returns undefined and creates no session when no team-capable provider exists', () => {
    mockGetTeamChatProviderMetas.mockReturnValue([]);
    const project = addProject();
    const before = project.sessions.length;
    const session = appState.startTeamChat(project.id, makeMember(), 'gemini');
    expect(session).toBeUndefined();
    expect(appState.projects.find((p) => p.id === project.id)?.sessions.length).toBe(before);
  });

  it('numbers sessions per team member', () => {
    mockGetTeamChatProviderMetas.mockReturnValue([metaFor('claude')]);
    const project = addProject();
    const cmo = makeMember();
    const ceo: import('../../shared/types.js').TeamMember = {
      ...makeMember(),
      id: 'm-2',
      name: 'CEO',
    };

    expect(appState.startTeamChat(project.id, cmo)?.name).toBe('CMO - Session 1');
    expect(appState.startTeamChat(project.id, cmo)?.name).toBe('CMO - Session 2');
    expect(appState.startTeamChat(project.id, ceo)?.name).toBe('CEO - Session 1');
    expect(appState.startTeamChat(project.id, cmo)?.name).toBe('CMO - Session 3');
  });
});
