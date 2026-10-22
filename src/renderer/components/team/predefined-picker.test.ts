// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TeamMember } from '../../../shared/types.js';

const mockFetch = vi.fn();
vi.mock('./github-fetcher.js', () => ({
  fetchPredefinedMembers: (...args: unknown[]) => mockFetch(...args),
  isCacheFresh: () => false,
}));
vi.mock('../../state.js', () => ({
  appState: {
    team: { predefinedCache: undefined },
    activeProject: undefined,
    getTeamMembers: () => [],
    setTeamPredefinedCache: vi.fn(),
  },
}));
vi.mock('../modal-manager.js', () => ({
  bindModalDismiss: () => () => {},
  pushModal: () => () => {},
}));
vi.mock('../file-reader.js', () => ({ renderMarkdownContent: () => document.createElement('div') }));

import { showPredefinedPicker } from './predefined-picker.js';
import { appState } from '../../state.js';

const suggestion: TeamMember = {
  id: 'scout',
  name: 'Scout',
  role: 'Research',
  systemPrompt: 'You are the Scout.',
  source: 'predefined',
  createdAt: 0,
  updatedAt: 0,
};

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function openOverlay(): HTMLElement {
  const overlay = document.querySelector('.team-picker-overlay') as HTMLElement | null;
  if (!overlay) throw new Error('picker overlay not mounted');
  return overlay;
}

function close(overlay: HTMLElement): void {
  (overlay.querySelector('.team-picker-close') as HTMLButtonElement).click();
}

beforeEach(() => {
  // A test that leaves the picker open leaks `activeDispose` (the UI2-11
  // guard makes every later showPredefinedPicker a no-op): close it through
  // the real close path first, then wipe the DOM.
  const leftover = document.querySelector('.team-picker-overlay') as HTMLElement | null;
  (leftover?.querySelector('.team-picker-close') as HTMLButtonElement | null)?.click();
  document.body.innerHTML = '';
  mockFetch.mockReset();
  vi.mocked(appState.setTeamPredefinedCache).mockClear();
});

describe('predefined-picker load (CI-11)', () => {
  it('does not write the load error into a disposed dialog', async () => {
    const pending = Promise.withResolvers<TeamMember[]>();
    mockFetch.mockReturnValue(pending.promise);

    const shown = showPredefinedPicker();
    await flush();
    const overlay = openOverlay();
    const status = overlay.querySelector('.team-picker-status') as HTMLElement;
    expect(status.textContent).not.toBe(''); // the loading line

    close(overlay);
    pending.reject(new Error('github down'));
    await expect(shown).resolves.toBeUndefined();

    // CI-11: the catch wrote `state.status.textContent` straight after the
    // await, so a dismissed picker's detached status line took the error text.
    expect(status.textContent).not.toContain('github down');
    expect(overlay.isConnected).toBe(false);
  });

  it('shares one in-flight fetch with a picker re-opened mid-load', async () => {
    const pending = Promise.withResolvers<TeamMember[]>();
    mockFetch.mockReturnValue(pending.promise);

    const first = showPredefinedPicker();
    await flush();
    close(openOverlay());
    const second = showPredefinedPicker();
    await flush();

    // CI-11: the re-open used to fire its own GitHub round-trip and let both
    // responses race into the shared cache.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    pending.resolve([]);
    await Promise.all([first, second]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('predefined-picker focus (CI-18)', () => {
  it('autofocuses the search input on open and restores focus to the opener on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const pending = Promise.withResolvers<TeamMember[]>();
    mockFetch.mockReturnValue(pending.promise);
    const shown = showPredefinedPicker();
    await flush();

    const overlay = openOverlay();
    expect(overlay.tabIndex).toBe(-1);
    // Keystrokes must land in the dialog, never the PTY behind it.
    expect(document.activeElement).toBe(overlay.querySelector('.team-picker-search'));

    close(overlay);
    expect(document.activeElement).toBe(trigger);
    pending.resolve([]);
    await shown;
  });

  it('the nested detail overlay takes focus and hands it back to the card', async () => {
    mockFetch.mockResolvedValue([suggestion]);
    await showPredefinedPicker();
    const card = document.querySelector('.team-picker-card') as HTMLElement;
    expect(card).toBeTruthy();
    card.focus();

    card.click(); // opens the detail overlay
    const detail = document.querySelector('.team-picker-detail-overlay') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(detail);

    (detail.querySelector('.team-picker-close') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(card);
  });
});

describe('predefined-picker success after dispose (C4TM-04)', () => {
  it('writes the shared cache but leaves the disposed dialog alone', async () => {
    const pending = Promise.withResolvers<TeamMember[]>();
    mockFetch.mockReturnValue(pending.promise);
    const setCache = vi.mocked(appState.setTeamPredefinedCache);

    const shown = showPredefinedPicker();
    await flush();
    const overlay = openOverlay();
    close(overlay);

    pending.resolve([suggestion]);
    await shown;
    await flush();

    // The shared-cache write stays valid for the next open…
    expect(setCache).toHaveBeenCalledWith([suggestion]);
    // …the dead dialog is not repopulated behind it.
    expect(overlay.isConnected).toBe(false);
    expect(overlay.querySelectorAll('.team-picker-card')).toHaveLength(0);
  });
});
