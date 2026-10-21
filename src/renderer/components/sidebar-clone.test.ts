// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// "Checkout and create" (plan 65-67) in the Add-project modal: a git URL in
// the path field flips the confirm label, fills the name from the repo, and
// confirm clones into `<default projects folder>/<repo>` before registering.
// The modal is mocked with a mini-modal that renders the real element ids
// (#modal-<field>, #modal-confirm), because the sidebar drives the confirm
// button's label/state directly from the DOM.

const modalMock = vi.hoisted(() => {
  const state = {
    onConfirm: null as null | ((values: Record<string, string>) => Promise<void> | void),
    showModal: vi.fn((_title: string, fields: Array<{ id: string; defaultValue?: string }>, onConfirm: (values: Record<string, string>) => Promise<void> | void, options?: { confirmLabel?: string }) => {
      state.onConfirm = onConfirm;
      const body = document.getElementById('modal-body')!;
      body.innerHTML = '';
      for (const f of fields) {
        const input = document.createElement('input');
        input.id = `modal-${f.id}`;
        input.type = 'text';
        input.value = f.defaultValue ?? '';
        body.appendChild(input);
      }
      const confirm = document.getElementById('modal-confirm') as HTMLButtonElement;
      confirm.textContent = options?.confirmLabel ?? 'Create';
      confirm.disabled = false;
    }),
    setModalError: vi.fn(),
    closeModal: vi.fn(),
    showConfirmDialog: vi.fn(),
  };
  return state;
});

vi.mock('./modal.js', () => ({
  showModal: modalMock.showModal,
  setModalError: modalMock.setModalError,
  closeModal: modalMock.closeModal,
  showConfirmDialog: modalMock.showConfirmDialog,
}));
vi.mock('../provider-availability.js', () => ({
  loadProviderMetas: vi.fn(async () => {}),
  loadProviderAvailability: vi.fn(async () => {}),
  hasMultipleAvailableProviders: vi.fn(() => false),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getCachedProviderMetas: vi.fn(() => []),
  getAvailableProviderMetas: vi.fn(() => []),
  getTeamChatProviderMetas: vi.fn(() => []),
  getTeamCapableProviderIds: vi.fn(() => new Set()),
  getProviderCapabilities: vi.fn(() => ({ profiles: false })),
  getProviderDisplayName: vi.fn((id: string) => id),
}));
vi.mock('./preferences-modal.js', () => ({ showPreferencesModal: vi.fn() }));
vi.mock('./file-tree.js', () => ({ renderFileTree: vi.fn(), clearProjectState: vi.fn(), closeFileTree: vi.fn() }));
vi.mock('./session-history.js', () => ({ renderSessionHistory: vi.fn(), closeSessionHistory: vi.fn(), clearProjectState: vi.fn() }));
vi.mock('./hover-card.js', () => ({ attachHoverCard: vi.fn() }));
vi.mock('./git-panel.js', () => ({ mountGitPanel: vi.fn(), closeGitPanel: vi.fn() }));
vi.mock('./project-settings.js', () => ({ promptProjectSettings: vi.fn() }));
vi.mock('../session-unread.js', () => ({ hasUnreadInProject: vi.fn(() => false), onChange: vi.fn() }));
vi.mock('../session-activity.js', () => ({ onChange: vi.fn(), STATUS_GLYPH: {} }));
vi.mock('../git-status.js', () => ({ gitChangeCount: vi.fn(() => null), onChange: vi.fn() }));
vi.mock('../discussions-badge.js', () => ({
  init: vi.fn(),
  getNewCount: vi.fn(() => 0),
  markSeen: vi.fn(),
  onChange: vi.fn(),
  DISCUSSIONS_URL: 'https://example.com/discussions',
}));

const IDS = [
  'project-list', 'btn-add-project', 'btn-preferences', 'sidebar', 'sidebar-resize-handle',
  'sidebar-discussions', 'btn-toggle-sidebar', 'sidebar-active-sessions',
  'modal-body', 'modal-overlay', 'modal-confirm',
];

interface FsStub {
  expandPath: Mock;
  isDirectory: Mock;
  listDirs: Mock;
  browseDirectory: Mock;
  cloneRepo: Mock;
}

function testWindow(): { finevibe: { app: { openExternal: Mock }; store: { load: Mock; save: Mock }; fs: FsStub } } {
  return window as unknown as { finevibe: { app: { openExternal: Mock }; store: { load: Mock; save: Mock }; fs: FsStub } };
}

let fsStub: FsStub;

function stubDom() {
  document.body.innerHTML = '';
  for (const id of IDS) {
    const el = document.createElement(id === 'modal-confirm' ? 'button' : 'div');
    el.id = id;
    document.body.appendChild(el);
  }
  fsStub = {
    expandPath: vi.fn(async (p: string) => p),
    isDirectory: vi.fn(async () => true),
    listDirs: vi.fn(async () => [] as string[]),
    browseDirectory: vi.fn(async () => null as string | null),
    cloneRepo: vi.fn(async () => ({ ok: true })),
  };
  testWindow().finevibe = {
    app: { openExternal: vi.fn() },
    store: { load: vi.fn(), save: vi.fn(async () => {}) },
    fs: fsStub,
  };
}

async function setup(defaultProjectsFolder = '/home/u/projects') {
  // sidebar.ts grabs DOM nodes at module load — re-import after stubbing.
  vi.resetModules();
  modalMock.showModal.mockClear();
  modalMock.setModalError.mockClear();
  modalMock.closeModal.mockClear();
  stubDom();
  const { appState } = await import('../state.js');
  const { promptNewProject } = await import('./sidebar.js');
  if (defaultProjectsFolder) appState.setPreference('defaultProjectsFolder', defaultProjectsFolder);
  const addProject = vi.spyOn(appState, 'addProject').mockImplementation(() => undefined as never);
  return { appState, promptNewProject, addProject };
}

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function confirmBtn(): HTMLButtonElement {
  return document.getElementById('modal-confirm') as HTMLButtonElement;
}

const URL_SSH = 'git@github.com:owner/repo.git';
const URL_HTTPS = 'https://github.com/owner/repo';

describe('Add-project git-URL detection', () => {
  it('flips the confirm label to Checkout and create and fills the repo name', async () => {
    const { promptNewProject } = await setup();
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    expect(confirmBtn().textContent).toBe('Checkout and create');
    expect(input('modal-project-name').value).toBe('repo');
  });

  it('restores the plain label when the URL is removed', async () => {
    const { promptNewProject } = await setup();
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    pathInput.value = '/some/local/path';
    pathInput.dispatchEvent(new Event('input'));
    expect(confirmBtn().textContent).toBe('Create');
  });
});

describe('Add-project default-projects-folder prefill', () => {
  it('pre-fills the path with the folder and syncs while the name is edited', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    expect(input('modal-project-path').value).toBe('/home/u/projects');
    const nameInput = input('modal-project-name');
    nameInput.value = 'demo';
    nameInput.dispatchEvent(new Event('input'));
    expect(input('modal-project-path').value).toBe('/home/u/projects/demo');
  });

  it('leaves the path alone once the user edited it', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = '/elsewhere/kept';
    pathInput.dispatchEvent(new Event('input'));
    const nameInput = input('modal-project-name');
    nameInput.value = 'demo';
    nameInput.dispatchEvent(new Event('input'));
    expect(pathInput.value).toBe('/elsewhere/kept');
  });

  it('keeps the empty path field when no default folder is set', async () => {
    const { promptNewProject } = await setup('');
    promptNewProject();
    expect(input('modal-project-path').value).toBe('');
  });
});

describe('Add-project checkout-and-create flow', () => {
  it('clones into <default folder>/<repo> and registers the project', async () => {
    const { promptNewProject, addProject } = await setup('/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_SSH;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_SSH, profile: '' });
    expect(fsStub.cloneRepo).toHaveBeenCalledWith(URL_SSH, '/home/u/projects/repo');
    expect(modalMock.closeModal).toHaveBeenCalled();
    expect(addProject).toHaveBeenCalledWith('repo', '/home/u/projects/repo', undefined);
  });

  it('skips the isDirectory gate for a URL', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
  });

  it('prompts for the parent folder when no default folder is set', async () => {
    const { promptNewProject } = await setup('');
    fsStub.browseDirectory.mockResolvedValueOnce('/picked');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    expect(fsStub.browseDirectory).toHaveBeenCalled();
    expect(fsStub.cloneRepo).toHaveBeenCalledWith(URL_HTTPS, '/picked/repo');
  });

  it('keeps the modal open when the browse prompt is cancelled', async () => {
    const { promptNewProject, addProject } = await setup('');
    fsStub.browseDirectory.mockResolvedValueOnce(null);
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    expect(fsStub.cloneRepo).not.toHaveBeenCalled();
    expect(modalMock.closeModal).not.toHaveBeenCalled();
    expect(addProject).not.toHaveBeenCalled();
  });

  it('shows the clone failure inline and keeps the modal open', async () => {
    const { promptNewProject, addProject } = await setup('/home/u/projects');
    fsStub.cloneRepo.mockResolvedValueOnce({ ok: false, error: 'git clone failed: repository not found' });
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    expect(modalMock.setModalError).toHaveBeenCalledWith('project-path', expect.stringContaining('Clone failed'));
    expect(modalMock.setModalError).toHaveBeenCalledWith('project-path', expect.stringContaining('repository not found'));
    expect(modalMock.closeModal).not.toHaveBeenCalled();
    expect(addProject).not.toHaveBeenCalled();
    expect(confirmBtn().disabled).toBe(false);
    expect(confirmBtn().textContent).toBe('Checkout and create');
  });

  it('keeps the manual path/name flow: an existing directory registers directly', async () => {
    const { promptNewProject, addProject } = await setup('');
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '/home/u/demo', profile: '' });
    expect(fsStub.isDirectory).toHaveBeenCalled();
    expect(fsStub.cloneRepo).not.toHaveBeenCalled();
    expect(addProject).toHaveBeenCalledWith('demo', '/home/u/demo', undefined);
  });

  it('keeps the manual flow gated: a missing directory shows the existing error', async () => {
    const { promptNewProject, addProject } = await setup('');
    fsStub.isDirectory.mockResolvedValueOnce(false);
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '/home/u/gone', profile: '' });
    expect(modalMock.setModalError).toHaveBeenCalledWith('project-path', expect.stringContaining('Directory does not exist'));
    expect(addProject).not.toHaveBeenCalled();
  });
});
