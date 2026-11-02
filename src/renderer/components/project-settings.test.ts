// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { ProjectRecord } from '../../shared/types';

const save = vi.hoisted(() => vi.fn());
const saveLead = vi.hoisted(() => vi.fn());
vi.mock('../state.js', () => ({
  appState: {
    preferences: { defaultProvider: 'claude' },
    setProjectCodingDefaults: save,
    setProjectLead: saveLead,
    getTeamMembers: () => [{ id: 'tech-lead', name: 'Tech Lead' }],
    team: { predefinedCache: { fetchedAt: Date.now(), suggestions: [{ id: 'architect', name: 'Architect' }] } },
  },
}));
vi.mock('../profile-utils.js', () => ({ providerProfileOptions: (id: string) => id === 'omp' ? [{ value: 'work', label: 'OMP Work' }] : [] }));
vi.mock('../provider-availability.js', () => ({ getCachedProviderMetas: () => [{ id: 'claude', displayName: 'Claude' }, { id: 'omp', displayName: 'OMP' }] }));
vi.mock('../i18n.js', () => ({ t: (key: string) => key }));

let close: () => void;
beforeEach(() => {
  vi.resetModules();
  save.mockClear();
  saveLead.mockClear();
  document.body.innerHTML = '<textarea id="terminal"></textarea><div id="modal-overlay" class="hidden"><h2 id="modal-title"></h2><div id="modal-body"></div><div id="modal-actions"><button id="modal-cancel"></button><button id="modal-confirm"></button></div></div>';
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => close?.());

it('offers providers without profiles, scopes profiles on change, saves and takes keyboard focus', async () => {
  const { promptProjectSettings } = await import('./project-settings');
  close = (await import('./modal')).closeModal;
  document.getElementById('terminal')!.focus();
  promptProjectSettings({ id: 'project', defaultProvider: 'claude' } as ProjectRecord);
  const selects = document.querySelectorAll('.custom-select');
  const trigger = selects[0].querySelector('button')!;
  // The lead card adds a text row, so the shared modal now takes focus on the
  // next frame (its text-field path) instead of synchronously on the first
  // control. Flush that frame and pin the contract: focus lands in the dialog.
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(document.activeElement).toBe(document.getElementById('modal-lead-name'));
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect((document.getElementById('modal-provider') as HTMLInputElement).value).toBe('omp');
  expect(save).not.toHaveBeenCalled();
  expect(selects[1].textContent).toContain('OMP Work');
  (selects[1].querySelector('[data-value="work"]') as HTMLElement).click();
  document.getElementById('modal-confirm')!.click();
  expect(save).toHaveBeenCalledWith('project', 'omp', 'work');
});

it('resets the selected profile when changing providers', async () => {
  const { promptProjectSettings } = await import('./project-settings');
  close = (await import('./modal')).closeModal;
  promptProjectSettings({ id: 'project', defaultProvider: 'omp', defaultProfileId: 'work' } as ProjectRecord);
  (document.querySelector('.custom-select [data-value="claude"]') as HTMLElement).click();
  expect((document.getElementById('modal-profile') as HTMLInputElement).value).toBe('');
});

describe('lead card (team-lead-persona-plan M1)', () => {
  const charter = () => (document.getElementById('modal-lead-charter') as HTMLTextAreaElement);
  const enable = () => (document.getElementById('modal-lead-enabled') as HTMLInputElement);

  it('offers the bundled personas and the team, prefilled from the stored lead', async () => {
    const { promptProjectSettings } = await import('./project-settings');
    close = (await import('./modal')).closeModal;
    promptProjectSettings({
      id: 'project',
      lead: { personaId: 'tech-lead', name: 'Tech Lead', charter: 'Own the rollout', enabled: true },
    } as unknown as ProjectRecord);
    const personaInput = document.getElementById('modal-lead-persona') as HTMLInputElement;
    expect(personaInput.value).toBe('tech-lead');
    const options = Array.from(document.querySelectorAll('#modal-lead-persona ~ .custom-select-dropdown [data-value]')).map(o => o.getAttribute('data-value'));
    expect(options).toEqual(['', 'tech-lead', 'architect']);
    expect(enable().checked).toBe(true);
    expect(charter().value).toBe('Own the rollout');
  });

  it('writes the enabled lead (persona + name + charter) on Save', async () => {
    const { promptProjectSettings } = await import('./project-settings');
    close = (await import('./modal')).closeModal;
    promptProjectSettings({ id: 'project' } as ProjectRecord);
    enable().click();
    (document.querySelector('#modal-lead-persona ~ .custom-select-dropdown [data-value="architect"]') as HTMLElement).click();
    charter().value = 'Own the release checklist.';
    document.getElementById('modal-confirm')!.click();
    expect(saveLead).toHaveBeenCalledWith('project', {
      personaId: 'architect',
      name: 'Architect',
      charter: 'Own the release checklist.',
      enabled: true,
    });
  });

  it('keeps a stored reviewMode across an edit and never invents one', async () => {
    const { promptProjectSettings } = await import('./project-settings');
    close = (await import('./modal')).closeModal;
    promptProjectSettings({
      id: 'project',
      lead: { name: 'Tech Lead', charter: '', enabled: true, reviewMode: 'on-complete' },
    } as unknown as ProjectRecord);
    charter().value = 'Updated charter.';
    document.getElementById('modal-confirm')!.click();
    expect(saveLead).toHaveBeenCalledWith('project', expect.objectContaining({ reviewMode: 'on-complete', enabled: true }));
  });

  it('writes no lead at all when the card is untouched on a project that never had one', async () => {
    const { promptProjectSettings } = await import('./project-settings');
    close = (await import('./modal')).closeModal;
    promptProjectSettings({ id: 'project' } as ProjectRecord);
    document.getElementById('modal-confirm')!.click();
    expect(saveLead).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('project', undefined, undefined);
  });

  it('rejects a charter over the 4 KiB byte cap and keeps the dialog open', async () => {
    const { promptProjectSettings } = await import('./project-settings');
    close = (await import('./modal')).closeModal;
    promptProjectSettings({ id: 'project' } as ProjectRecord);
    enable().click();
    // 4096 ASCII bytes fit; 4097 do not (the cap is bytes, not characters).
    charter().value = 'a'.repeat(4097);
    document.getElementById('modal-confirm')!.click();
    expect(saveLead).not.toHaveBeenCalled();
    expect(document.getElementById('modal-error-lead-charter')).not.toBeNull();
    charter().value = 'a'.repeat(4096);
    document.getElementById('modal-confirm')!.click();
    expect(saveLead).toHaveBeenCalledWith('project', expect.objectContaining({ enabled: true }));
  });
});
