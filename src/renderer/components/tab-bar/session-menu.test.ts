// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldDef, ModalOptions } from '../modal.js';

// The real modal.ts grabs the shared overlay at module load; mirror
// index.html's #modal-overlay skeleton (same pattern as modal.test.ts).
document.body.innerHTML = `
  <div id="modal-overlay" class="hidden">
    <div class="modal">
      <div id="modal-title"></div>
      <div id="modal-body"></div>
      <div id="modal-actions">
        <button id="modal-cancel" class="btn-secondary">Cancel</button>
        <button id="modal-confirm" class="btn-primary">Create</button>
      </div>
    </div>
  </div>`;

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(0);
  return 1;
});

interface FakeSession {
  id: string;
  name: string;
}
interface FakeMember {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  profileId?: string;
}

let activeProjectVal: Record<string, unknown> | null = null;
let teamMembersVal: FakeMember[] = [];
let profilesVal: Array<{ id: string; name: string; providerId: string }> = [];

const addSession = vi.fn((): FakeSession => ({ id: 's-plain', name: 'plain' }));
const startTeamChat = vi.fn((): FakeSession => ({ id: 's-team', name: 'CMO - Session 1' }));
const getTeamMemberById = vi.fn((id: string): FakeMember | undefined =>
  teamMembersVal.find((m) => m.id === id),
);

vi.mock('../../state.js', () => ({
  appState: {
    get activeProject() { return activeProjectVal; },
    get team() { return { members: teamMembersVal }; },
    get profiles() { return profilesVal; },
    preferences: {},
    addSession,
    startTeamChat,
    getTeamMemberById,
  },
}));

const providerMetas = [
  { id: 'claude', displayName: 'Claude', capabilities: { profiles: true, systemPromptInjection: true } },
  { id: 'gemini', displayName: 'Gemini', capabilities: { profiles: false, systemPromptInjection: false } },
];
let teamCapableVal = new Set(['claude']);

vi.mock('../../provider-availability.js', () => ({
  loadProviderAvailability: vi.fn(async () => {}),
  getProviderAvailabilitySnapshot: () => ({
    providers: providerMetas,
    availability: new Map(providerMetas.map((p) => [p.id, true])),
  }),
  getProviderCapabilities: (id: string) =>
    providerMetas.find((p) => p.id === id)?.capabilities ?? null,
  getTeamCapableProviderIds: () => teamCapableVal,
  getProviderDisplayName: (id: string) =>
    providerMetas.find((p) => p.id === id)?.displayName ?? id,
}));

vi.mock('../../profile-utils.js', () => ({ providerProfileOptions: () => [] }));
vi.mock('../join-dialog.js', () => ({ showJoinDialog: vi.fn() }));
vi.mock('./menu.js', () => ({
  hideTabContextMenu: vi.fn(),
  setActiveContextMenu: vi.fn(),
  positionMenu: vi.fn(),
}));
vi.mock('../terminal-pane.js', () => ({ setPendingPrompt: vi.fn() }));

// The field list and confirm callback the modal was opened with, captured by
// wrapping the REAL modal (so the rows are really rendered and the real
// closeModal/setModalError semantics apply).
const captured: {
  fields: FieldDef[];
  onConfirm: (values: Record<string, string>) => void | Promise<void>;
} = { fields: [], onConfirm: () => {} };

vi.mock('../modal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modal.js')>();
  return {
    ...actual,
    showModal: (
      title: string,
      fields: FieldDef[],
      onConfirm: (values: Record<string, string>) => void | Promise<void>,
      options?: ModalOptions,
    ) => {
      captured.fields = fields;
      captured.onConfirm = onConfirm;
      actual.showModal(title, fields, onConfirm, options);
    },
  };
});

// session-menu pulls appState/modal DOM handles at import time and every
// vi.mock above must be hoisted first — a static import cannot order itself
// after the mock + jsdom skeleton setup (repo's jsdom test pattern).
const { promptNewSession } = await import('./session-menu.js');
const { closeModal } = await import('../modal.js');
const { setPendingPrompt } = await import('../terminal-pane.js');

const overlay = () => document.getElementById('modal-overlay')!;
const fieldIds = () => captured.fields.map((f) => f.id);
const field = (id: string) => captured.fields.find((f) => f.id === id);

function makeMember(over: Partial<FakeMember> = {}): FakeMember {
  return { id: 'm1', name: 'CMO', role: 'Marketing', systemPrompt: 'You are the CMO.', ...over };
}

function makeProject() {
  return {
    id: 'p1',
    name: 'P',
    path: '/p',
    sessions: [],
    activeSessionId: null,
    defaultArgs: undefined,
    defaultEnv: undefined,
    defaultProvider: undefined,
    defaultProfileId: undefined,
  };
}

/** The value bag the real modal's handleConfirm would collect. */
function values(over: Record<string, string> = {}): Record<string, string> {
  return {
    provider: 'claude',
    'session-name': 'Session 1',
    persona: '',
    'session-prompt': '',
    'session-args': '',
    'keep-args': 'false',
    'session-env': '',
    'keep-env': 'false',
    profile: '',
    ...over,
  };
}

async function confirmWith(over: Record<string, string> = {}): Promise<void> {
  await captured.onConfirm(values(over));
}

const personaWrapper = () =>
  document.getElementById('modal-persona')?.closest('.modal-field') as HTMLElement | null;
const promptWrapper = () =>
  document.getElementById('modal-session-prompt')?.closest('.modal-field') as HTMLElement | null;

beforeEach(async () => {
  vi.clearAllMocks();
  closeModal();
  teamCapableVal = new Set(['claude']);
  teamMembersVal = [];
  profilesVal = [];
  activeProjectVal = makeProject();
  addSession.mockReturnValue({ id: 's-plain', name: 'plain' });
  startTeamChat.mockReturnValue({ id: 's-team', name: 'CMO - Session 1' });
});

describe('New Session modal persona/prompt rows', () => {
  it('inserts persona + prompt rows directly below Name when the team has members', async () => {
    teamMembersVal = [makeMember(), makeMember({ id: 'm2', name: 'CEO', role: 'Strategy' })];
    await promptNewSession();

    expect(fieldIds()).toEqual([
      'provider',
      'session-name',
      'persona',
      'session-prompt',
      'session-args',
      'keep-args',
      'session-env',
      'keep-env',
    ]);

    const persona = field('persona')!;
    expect(persona.type).toBe('select');
    expect(persona.options).toEqual([
      { value: '', label: 'None' },
      { value: 'm1', label: 'CMO — Marketing' },
      { value: 'm2', label: 'CEO — Strategy' },
    ]);

    const prompt = field('session-prompt')!;
    expect(prompt.type).toBe('textarea');
    expect(prompt.rows).toBe(3);
    expect(prompt.placeholder).toBe('Add a custom prompt for this persona…');

    // Really rendered: custom-select for the persona, textarea for the prompt.
    expect(document.getElementById('modal-persona')).not.toBeNull();
    expect(document.getElementById('modal-session-prompt')?.tagName).toBe('TEXTAREA');
  });

  it('omits the persona + prompt rows when the team has no members', async () => {
    teamMembersVal = [];
    await promptNewSession();
    expect(fieldIds()).not.toContain('persona');
    expect(fieldIds()).not.toContain('session-prompt');
  });

  it('hides persona + prompt rows for a non-team-capable provider and restores on switch back', async () => {
    teamMembersVal = [makeMember()];
    await promptNewSession();

    expect(personaWrapper()!.style.display).toBe('');
    expect(promptWrapper()!.style.display).toBe('');

    field('provider')!.onSelectChange!('gemini');
    expect(personaWrapper()!.style.display).toBe('none');
    expect(promptWrapper()!.style.display).toBe('none');

    field('provider')!.onSelectChange!('claude');
    expect(personaWrapper()!.style.display).toBe('');
    expect(promptWrapper()!.style.display).toBe('');
  });

  it('launches the persona via startTeamChat with the modal name/args/env and delivers the prompt', async () => {
    teamMembersVal = [makeMember()];
    const onCreated = vi.fn();
    await promptNewSession(onCreated);

    await confirmWith({
      'session-name': 'Sprint review',
      persona: 'm1',
      'session-prompt': 'Review the sprint',
      'session-args': '--model sonnet',
      'keep-args': 'true',
    });

    expect(startTeamChat).toHaveBeenCalledWith('p1', teamMembersVal[0], 'claude', {
      name: 'Sprint review',
      args: '--model sonnet',
      envVars: undefined,
    });
    expect(addSession).not.toHaveBeenCalled();
    expect(setPendingPrompt).toHaveBeenCalledWith('s-team', 'Review the sprint');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 's-team' }));
    expect(overlay().classList.contains('hidden')).toBe(true);
    // keep-args persists exactly as on the plain path.
    expect(activeProjectVal!.defaultArgs).toBe('--model sonnet');
  });

  it('keeps the member-derived name when the name field is at its "Session {num}" default', async () => {
    teamMembersVal = [makeMember()];
    await promptNewSession();

    await confirmWith({ persona: 'm1' });

    expect(startTeamChat).toHaveBeenCalledWith('p1', teamMembersVal[0], 'claude', {
      name: undefined,
      args: undefined,
      envVars: undefined,
    });
  });

  it('surfaces a hard error and keeps the modal open when the persona cannot run', async () => {
    teamMembersVal = [makeMember()];
    startTeamChat.mockReturnValue(undefined as unknown as FakeSession);
    const onCreated = vi.fn();
    await promptNewSession(onCreated);

    await confirmWith({ persona: 'm1' });

    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.modal-error')?.textContent).toBe("Claude can't run team personas");
    expect(addSession).not.toHaveBeenCalled();
    expect(setPendingPrompt).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('surfaces the same hard error for a persona that was deleted mid-edit', async () => {
    teamMembersVal = [makeMember()];
    await promptNewSession();
    teamMembersVal = []; // member deleted after the modal opened

    await confirmWith({ persona: 'm1' });

    expect(startTeamChat).not.toHaveBeenCalled();
    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(document.querySelector('.modal-error')).not.toBeNull();
  });

  it('plain path: addSession runs unchanged and the prompt lands via setPendingPrompt', async () => {
    teamMembersVal = [makeMember()];
    const onCreated = vi.fn();
    await promptNewSession(onCreated);

    await confirmWith({ 'session-prompt': 'hello', 'session-name': 'Plain' });

    expect(startTeamChat).not.toHaveBeenCalled();
    expect(addSession).toHaveBeenCalledWith('p1', 'Plain', undefined, 'claude', undefined, undefined, undefined);
    expect(setPendingPrompt).toHaveBeenCalledWith('s-plain', 'hello');
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 's-plain' }));
  });

  it('empty prompt = no setPendingPrompt call', async () => {
    teamMembersVal = [makeMember()];
    await promptNewSession();
    await confirmWith({ 'session-name': 'Plain' });
    expect(setPendingPrompt).not.toHaveBeenCalled();
  });

  it('invalid env lines keep the modal open with the env error (unchanged guard)', async () => {
    teamMembersVal = [makeMember()];
    await promptNewSession();

    await confirmWith({ 'session-env': 'NOT AN ENV LINE' });

    expect(overlay().classList.contains('hidden')).toBe(false);
    expect(addSession).not.toHaveBeenCalled();
    expect(startTeamChat).not.toHaveBeenCalled();
  });

  it('a pinned persona explains the provider override via the provider field tooltip', async () => {
    profilesVal = [{ id: 'prof-1', name: 'Work', providerId: 'claude' }];
    teamMembersVal = [makeMember({ profileId: 'prof-1' })];
    await promptNewSession();

    const persona = field('persona')!;
    persona.onSelectChange!('m1');
    const providerWrapper = document.getElementById('modal-provider')!.closest('.modal-field')!;
    expect(providerWrapper.title).toBe('CMO is pinned to Claude; the pinned backend wins at launch.');

    persona.onSelectChange!('');
    expect(providerWrapper.title).toBe('');
  });
});
