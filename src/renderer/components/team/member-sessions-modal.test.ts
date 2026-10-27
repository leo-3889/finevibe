// @vitest-environment jsdom
// N-row close (FEATURE_LEDGER_2026-10-26 §4): the member-sessions modal's
// listing rules were untested. Pins: member+CLI filtering, newest-first sort,
// and the liveSessionId dedup that stops a running session rendering twice
// (once as a tab row, once as its spawn-time history record).
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { ProjectRecord, TeamMember } from '../../../shared/types.js';

const closeModal = vi.fn();
const pushModal = vi.fn(() => vi.fn());
vi.mock('../modal.js', () => ({
  closeModal: () => closeModal(),
  registerModalCleanup: (fn: () => void) => fn,
}));
vi.mock('../modal-manager.js', () => ({ pushModal: (h: unknown) => pushModal(h) }));
vi.mock('../../provider-availability.js', () => ({
  getProviderDisplayName: () => 'Claude Code',
}));
vi.mock('../../i18n.js', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    key === 'team.sessions.title' ? `Sessions: ${vars?.name}` : key,
  getLocale: () => 'en',
}));

let projects: ProjectRecord[] = [];
vi.mock('../../state.js', () => ({
  appState: { get projects() { return projects; } },
}));

const member: TeamMember = {
  id: 'm-1', name: 'Dev', role: 'r', systemPrompt: 'p',
  source: 'custom', createdAt: 0, updatedAt: 0,
};

function session(over: Partial<ProjectRecord['sessions'][number]>): ProjectRecord['sessions'][number] {
  return {
    id: 's-base', name: 'S', createdAt: '2026-01-01T00:00:00.000Z',
    workingDir: '/p', ...over,
  } as ProjectRecord['sessions'][number];
}

beforeAll(() => {
  document.body.innerHTML = `
    <div id="modal-overlay" class="hidden"><div id="modal-title"></div>
      <div id="modal-body"></div>
      <button id="modal-cancel"></button><button id="modal-confirm"></button>
    </div>`;
});

beforeEach(() => {
  vi.clearAllMocks();
  projects = [];
});

async function show(projectId = 'p-1') {
  const { showMemberSessionsModal } = await import('./member-sessions-modal.js');
  showMemberSessionsModal(member, projectId);
}

describe('member-sessions-modal', () => {
  it('shows the empty state when the member has nothing', async () => {
    projects = [{ id: 'p-1', name: 'P', path: '/p', sessions: [] } as ProjectRecord];
    await show();
    expect(document.querySelector('.team-sessions-empty')).not.toBeNull();
  });

  it('lists only this member\'s CLI sessions, newest first; non-CLI rows excluded', async () => {
    projects = [{
      id: 'p-1', name: 'P', path: '/p',
      sessions: [
        session({ id: 'old', name: 'Old', teamMemberId: 'm-1', createdAt: '2026-01-01T00:00:00.000Z' }),
        session({ id: 'new', name: 'New', teamMemberId: 'm-1', createdAt: '2026-02-01T00:00:00.000Z' }),
        session({ id: 'other', name: 'Other', teamMemberId: 'm-2', createdAt: '2026-03-01T00:00:00.000Z' }),
        session({ id: 'filer', name: 'File', teamMemberId: 'm-1', type: 'file-reader', createdAt: '2026-04-01T00:00:00.000Z' }),
      ],
    } as ProjectRecord];
    await show();
    const names = [...document.querySelectorAll('.team-sessions-list .session-row-name, .team-sessions-list > div > div:first-child')];
    void names; // row internals asserted via textContent below
    const rows = document.querySelector('.team-sessions-list')!.textContent!;
    expect(rows).toContain('New');
    expect(rows).toContain('Old');
    expect(rows).not.toContain('Other');
    expect(rows).not.toContain('File');
    expect(rows.indexOf('New')).toBeLessThan(rows.indexOf('Old'));
  });

  it('dedups the history row of a running session via liveSessionId and cliSessionId', async () => {
    projects = [{
      id: 'p-1', name: 'P', path: '/p',
      sessions: [session({ id: 'live-1', name: 'Live', teamMemberId: 'm-1', cliSessionId: 'cli-9', createdAt: '2026-02-01T00:00:00.000Z' })],
      sessionHistory: [
        // Mirror of the live tab: deduped on liveSessionId.
        { id: 'h1', cliSessionId: null, liveSessionId: 'live-1', teamMemberId: 'm-1', name: 'Mirror', createdAt: '2026-02-01T00:00:00.000Z', closedAt: '2026-02-02T00:00:00.000Z' },
        // Same cli id via another tab's record: deduped on cliSessionId.
        { id: 'h2', cliSessionId: 'cli-9', teamMemberId: 'm-1', name: 'SameCli', createdAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-02T00:00:00.000Z' },
        // Unrelated archive entry: kept.
        { id: 'h3', cliSessionId: 'cli-7', teamMemberId: 'm-1', name: 'Kept', createdAt: '2026-01-05T00:00:00.000Z', closedAt: '2026-01-06T00:00:00.000Z' },
        // Other member: dropped.
        { id: 'h4', cliSessionId: 'cli-6', teamMemberId: 'm-2', name: 'Foreign', createdAt: '2026-01-07T00:00:00.000Z', closedAt: '2026-01-08T00:00:00.000Z' },
      ],
    } as unknown as ProjectRecord];
    await show();
    const rows = document.querySelector('.team-sessions-list')!.textContent!;
    expect(rows).toContain('Live');
    expect(rows).toContain('Kept');
    expect(rows).not.toContain('Mirror');
    expect(rows).not.toContain('SameCli');
    expect(rows).not.toContain('Foreign');
  });

  it('returns silently for an unknown project and hides the confirm button', async () => {
    projects = [{ id: 'p-1', name: 'P', path: '/p', sessions: [] } as ProjectRecord];
    await show('nope');
    expect(closeModal).not.toHaveBeenCalled();
    await show();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect((document.getElementById('modal-confirm') as HTMLButtonElement).style.display).toBe('none');
    expect(document.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(false);
  });
});
