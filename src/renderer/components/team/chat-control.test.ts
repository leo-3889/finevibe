// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TeamMember } from '../../../shared/types.js';

const mockStartTeamChat = vi.fn();
vi.mock('../../state.js', () => ({
  appState: {
    startTeamChat: (...args: unknown[]) => mockStartTeamChat(...args),
    profiles: [],
  },
}));

const mockProviderMetas = vi.fn();
vi.mock('../../provider-availability.js', () => ({
  getTeamChatProviderMetas: () => mockProviderMetas(),
}));

vi.mock('../../state/team-state.js', () => ({
  resolvePinnedTeamProfile: () => undefined,
}));

const mockShowContextMenu = vi.fn();
vi.mock('../board/board-context-menu.js', () => ({
  showContextMenu: (...args: unknown[]) => mockShowContextMenu(...args),
}));

vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));

import { buildTeamChatControl } from './chat-control.js';

const member: TeamMember = {
  id: 'm-1',
  name: 'CMO',
  role: 'Marketing',
  systemPrompt: 'You are the CMO.',
  source: 'custom',
  createdAt: 0,
  updatedAt: 0,
};
const classes = { chat: 'c', chatMain: 'cm', chevron: 'ch', group: 'g' };

interface MenuItem {
  label: string;
  action: () => void;
}

beforeEach(() => {
  document.body.innerHTML = '';
  mockStartTeamChat.mockReset();
  mockShowContextMenu.mockReset();
  mockProviderMetas.mockReset();
  mockProviderMetas.mockReturnValue([
    { id: 'claude', displayName: 'Claude' },
    { id: 'codex', displayName: 'Codex' },
  ]);
  vi.useFakeTimers(); // vitest fakes requestAnimationFrame with the timers
});

afterEach(() => {
  vi.useRealTimers();
});

describe('team chat control latch (C4TM-02)', () => {
  it('swallows a double-click: one Chat click spawns one session', () => {
    const group = buildTeamChatControl('p-1', member, classes);
    const btn = group.querySelector('.c') as HTMLButtonElement;

    btn.click();
    btn.click();
    expect(mockStartTeamChat).toHaveBeenCalledTimes(1);
    expect(mockStartTeamChat).toHaveBeenCalledWith('p-1', member, undefined);
  });

  it('releases the latch once the spawn frames ran — the next click launches again', () => {
    const group = buildTeamChatControl('p-1', member, classes);
    const btn = group.querySelector('.c') as HTMLButtonElement;
    btn.click();
    expect(btn.disabled).toBe(true);
    vi.runAllTimers(); // drains the nested rAF release
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(mockStartTeamChat).toHaveBeenCalledTimes(2);
  });

  it('the provider chevron launch is latched too', () => {
    const group = buildTeamChatControl('p-1', member, classes);
    const chevron = group.querySelector('.ch') as HTMLButtonElement;
    chevron.click();
    const items = mockShowContextMenu.mock.calls[0][2] as MenuItem[];
    expect(items.map((i) => i.label)).toEqual(['Claude', 'Codex']);
    items[1].action();
    items[1].action();
    expect(mockStartTeamChat).toHaveBeenCalledTimes(1);
    expect(mockStartTeamChat).toHaveBeenCalledWith('p-1', member, 'codex');
  });

  it('a chevron pick while the Chat button is latched is swallowed', () => {
    const group = buildTeamChatControl('p-1', member, classes);
    const btn = group.querySelector('.c') as HTMLButtonElement;
    btn.click(); // arms the latch
    const chevron = group.querySelector('.ch') as HTMLButtonElement;
    chevron.click();
    const items = mockShowContextMenu.mock.calls[0][2] as MenuItem[];
    items[0].action();
    expect(mockStartTeamChat).toHaveBeenCalledTimes(1);
  });
});
