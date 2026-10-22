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
vi.mock('../file-reader.js', () => ({ renderMarkdownContent: () => {} }));

import { showPredefinedPicker } from './predefined-picker.js';

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
  document.body.innerHTML = '';
  mockFetch.mockReset();
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
