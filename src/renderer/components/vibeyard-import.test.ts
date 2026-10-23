// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

const addProject: Mock = vi.hoisted(() => vi.fn());
// The live project list the component reads at open time AND at confirm time;
// tests push into it to simulate a project appearing while the modal is open.
const projects: Array<{ name: string; path: string }> = vi.hoisted(() => []);

vi.mock('../state.js', () => ({ appState: { projects, addProject } }));
vi.mock('../i18n.js', () => ({ t: (key: string) => key, onLocaleChange: vi.fn() }));
// Deterministic path identity: the win32 case fold is covered by the
// separator/trailing-separator case below, not by the host platform.
vi.mock('../platform.js', () => ({ isMac: false, isWin: false, isLinux: true }));

const OVERLAY_ID = 'vibeyard-import-overlay';
const BUTTON_ID = 'btn-import-vibeyard';

let listImportableProjects: Mock;

/** Flush the pending microtask chain — the mocked IPC makes no real timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function button(): HTMLElement {
  return document.getElementById(BUTTON_ID)!;
}

function overlay(): HTMLElement {
  return document.getElementById(OVERLAY_ID)!;
}

function confirmButton(): HTMLButtonElement {
  return overlay().querySelector('.modal-actions .btn-primary') as HTMLButtonElement;
}

function rows(): NodeListOf<Element> {
  return overlay().querySelectorAll('.vibeyard-import-row');
}

let showVibeyardImportModal: () => Promise<void>;
let initVibeyardImport: () => void;

beforeEach(async () => {
  vi.resetModules();
  addProject.mockReset();
  projects.length = 0;
  // Dynamic import is deliberate (the `vi.resetModules()` exception to the
  // static-import rule): the component keeps module-scope state — the cached
  // scan, the single-flight open flag, the dismissal teardown — and a static
  // import would pin one generation across every test here.
  document.body.innerHTML =
    `<div id="sidebar-header"><button id="${BUTTON_ID}" class="icon-btn hidden"></button></div>`;
  listImportableProjects = vi.fn(async () => []);
  (window as unknown as { finevibe: unknown }).finevibe = { vibeyard: { listImportableProjects } };
  const mod = await import('./vibeyard-import.js');
  showVibeyardImportModal = mod.showVibeyardImportModal;
  initVibeyardImport = mod.initVibeyardImport;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('vibeyard-import', () => {
  it('keeps the header entry point hidden and offers the empty state when there is nothing to import', async () => {
    listImportableProjects.mockResolvedValue([]);
    initVibeyardImport();
    await flush();
    expect(button().classList.contains('hidden')).toBe(true);

    await showVibeyardImportModal();
    expect(overlay().querySelector('.vibeyard-import-empty')!.textContent).toBe('legacyImport.empty');
    expect(rows()).toHaveLength(0);
    expect(confirmButton().disabled).toBe(true);
    expect(addProject).not.toHaveBeenCalled();
  });

  it('reveals the entry point after init when the legacy state lists projects', async () => {
    listImportableProjects.mockResolvedValue([{ name: 'Alpha', path: 'C:/repos/alpha', sessions: 1 }]);
    initVibeyardImport();
    await flush();
    expect(button().classList.contains('hidden')).toBe(false);
    expect(button().title).toBe('legacyImport.buttonTitle');
  });

  it('renders one checked row per importable project with name, path and session count', async () => {
    listImportableProjects.mockResolvedValue([
      { name: 'Alpha', path: 'C:/repos/alpha', sessions: 3 },
      { name: 'Beta', path: 'C:/repos/beta', sessions: 1 },
    ]);
    await showVibeyardImportModal();

    expect(rows()).toHaveLength(2);
    const first = rows()[0]!;
    expect(first.querySelector('.vibeyard-import-name')!.textContent).toBe('Alpha');
    expect(first.querySelector('.vibeyard-import-path')!.textContent).toBe('C:/repos/alpha');
    expect(first.querySelector('.vibeyard-import-sessions')!.textContent).toBe('legacyImport.sessionsOther');
    expect(rows()[1]!.querySelector('.vibeyard-import-sessions')!.textContent).toBe('legacyImport.sessionsOne');
    for (const input of overlay().querySelectorAll<HTMLInputElement>('.vibeyard-import-check')) {
      expect(input.checked).toBe(true);
    }
  });

  it('never offers a project FineVibe already lists, comparing paths separator-insensitively', async () => {
    listImportableProjects.mockResolvedValue([
      { name: 'Alpha', path: 'C:/repos/alpha', sessions: 0 },
      { name: 'Gamma', path: 'C:/repos/gamma', sessions: 2 },
    ]);
    projects.push({ name: 'Gamma (cloned)', path: 'C:\\repos\\gamma\\' });

    await showVibeyardImportModal();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector('.vibeyard-import-name')!.textContent).toBe('Alpha');
  });

  it('adds each selected project once through appState.addProject and leaves the unselected alone', async () => {
    listImportableProjects.mockResolvedValue([
      { name: 'Alpha', path: 'C:/repos/alpha', sessions: 0 },
      { name: 'Beta', path: 'C:/repos/beta', sessions: 0 },
    ]);
    await showVibeyardImportModal();
    (rows()[1]!.querySelector('.vibeyard-import-check') as HTMLInputElement).checked = false;
    confirmButton().click();
    await flush();

    expect(addProject.mock.calls).toEqual([['Alpha', 'C:/repos/alpha']]);
    expect(overlay().querySelector('.vibeyard-import-result')!.textContent).toBe('legacyImport.resultOne');
    // The result state closes on its Close button.
    confirmButton().click();
    expect(overlay().style.display).toBe('none');
  });

  it('skips a project whose path became known while the modal was open', async () => {
    listImportableProjects.mockResolvedValue([
      { name: 'Alpha', path: 'C:/repos/alpha', sessions: 0 },
      { name: 'Beta', path: 'C:/repos/beta', sessions: 0 },
    ]);
    await showVibeyardImportModal();
    projects.push({ name: 'Beta (added meanwhile)', path: 'C:/repos/beta' });
    confirmButton().click();
    await flush();

    expect(addProject.mock.calls).toEqual([['Alpha', 'C:/repos/alpha']]);
    expect(overlay().querySelector('.vibeyard-import-result')!.textContent).toBe('legacyImport.resultOne');
    expect(overlay().querySelector('.vibeyard-import-skipped')!.textContent).toBe('legacyImport.skippedOne');
    confirmButton().click();
  });

  it('hides the entry point once every scanned project has been imported', async () => {
    listImportableProjects.mockResolvedValue([{ name: 'Alpha', path: 'C:/repos/alpha', sessions: 0 }]);
    initVibeyardImport();
    await flush();
    expect(button().classList.contains('hidden')).toBe(false);

    await showVibeyardImportModal();
    confirmButton().click();
    await flush();
    expect(button().classList.contains('hidden')).toBe(true);
    confirmButton().click();
  });

  it('survives a rejected scan and keeps the entry point hidden', async () => {
    listImportableProjects.mockRejectedValue(new Error('corrupt ~/.vibeyard/state.json'));
    expect(() => initVibeyardImport()).not.toThrow();
    await flush();
    expect(button().classList.contains('hidden')).toBe(true);

    await expect(showVibeyardImportModal()).resolves.toBeUndefined();
    expect(overlay().querySelector('.vibeyard-import-empty')!.textContent).toBe('legacyImport.empty');
    expect(addProject).not.toHaveBeenCalled();
  });

  it('adds nothing when the confirm happens with every row unchecked', async () => {
    listImportableProjects.mockResolvedValue([{ name: 'Alpha', path: 'C:/repos/alpha', sessions: 0 }]);
    await showVibeyardImportModal();
    (rows()[0]!.querySelector('.vibeyard-import-check') as HTMLInputElement).checked = false;
    confirmButton().click();
    await flush();

    expect(addProject).not.toHaveBeenCalled();
    expect(overlay().querySelector('.vibeyard-import-empty')!.textContent).toBe('legacyImport.empty');
    confirmButton().click();
  });
});
