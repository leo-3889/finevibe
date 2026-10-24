// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
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
      state.cleanups.length = 0;
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
    // C2R-11: the sidebar registers a suggest-debounce teardown through
    // registerModalCleanup; the mini-modal runs the callbacks on close, the
    // same funnel as the real modal's cleanup().
    cleanups: [] as Array<() => void>,
    registerModalCleanup: vi.fn((fn: () => void) => { state.cleanups.push(fn); }),
    closeModal: vi.fn(() => {
      for (const fn of state.cleanups.splice(0, state.cleanups.length)) fn();
    }),
    showConfirmDialog: vi.fn(),
  };
  return state;
});

vi.mock('./modal.js', () => ({
  showModal: modalMock.showModal,
  setModalError: modalMock.setModalError,
  closeModal: modalMock.closeModal,
  showConfirmDialog: modalMock.showConfirmDialog,
  registerModalCleanup: modalMock.registerModalCleanup,
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
vi.mock('./file-tree.js', () => ({ renderFileTree: vi.fn(), clearProjectState: vi.fn(), closeFileTree: vi.fn(), FILE_MANAGER: 'Files' }));
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
  ensureDirectory: Mock;
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
    ensureDirectory: vi.fn(async (p: string) => ({ ok: true, path: p })),
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

describe('Add-project Select label (existing-directory probe)', () => {
  // The probe chain (expandPath → isDirectory) is pure microtasks; one
  // macrotask tick settles it.
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // A blur probe needs a real focus move: FocusEvent carries the element the
  // focus lands on, and the sidebar ignores a null target (dismissal) and any
  // move into the modal footer (Cancel/Confirm).
  const blurTo = (el: Element | null) => new FocusEvent('blur', { relatedTarget: el });
  // Longer than the 100 ms autocomplete debounce: a keystroke probe would
  // surface inside the sleep, i.e. before the assertion, not after it.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const browseField = () => (modalMock.showModal.mock.calls[0][1] as unknown as Array<{
    id: string;
    onButtonClick?: (input: HTMLInputElement) => Promise<void> | void;
  }>).find((f) => f.id === 'project-path')!.onButtonClick!;

  it('probes the open prefill: an existing default folder reads Select', async () => {
    // The prefill is the default projects folder — an allowlisted root in
    // main — so probing it at open can never raise a native dialog, and the
    // label is right without the user ever touching the field.
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalledTimes(1);
    expect(fsStub.isDirectory).toHaveBeenCalledWith('/home/u/projects');
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('probes the open prefill: a missing default folder stays Create', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    fsStub.isDirectory.mockResolvedValue(false);
    promptNewProject();
    await flush();
    expect(confirmBtn().textContent).toBe('Create');
  });

  it('never probes at open when the path field is empty', async () => {
    const { promptNewProject } = await setup('');
    promptNewProject();
    await sleep(150);
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
    expect(confirmBtn().textContent).toBe('Create');
  });

  it('never probes on the keystroke path; blur probes and flips to Select', async () => {
    const { promptNewProject } = await setup('');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = '/home/u/demo';
    pathInput.dispatchEvent(new Event('input'));
    await sleep(150);
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
    expect(confirmBtn().textContent).toBe('Create');
    pathInput.dispatchEvent(blurTo(input('modal-project-name')));
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalledWith('/home/u/demo');
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('keeps Checkout and create precedence: Select yields to a typed URL', async () => {
    const { promptNewProject } = await setup('');
    promptNewProject();
    const pathInput = input('modal-project-path');
    // Earn Select on a local dir first: an implementation that re-probes (or
    // repaints Select) on the URL's blur would keep the wrong label here.
    pathInput.value = '/home/u/demo';
    pathInput.dispatchEvent(new Event('input'));
    pathInput.dispatchEvent(blurTo(input('modal-project-name')));
    await flush();
    expect(confirmBtn().textContent).toBe('Select');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    pathInput.dispatchEvent(blurTo(input('modal-project-name')));
    await flush();
    expect(fsStub.expandPath).not.toHaveBeenCalledWith(URL_HTTPS);
    expect(fsStub.isDirectory).not.toHaveBeenCalledWith(URL_HTTPS);
    expect(confirmBtn().textContent).toBe('Checkout and create');
  });

  it('probes after Browse fills the field', async () => {
    const { promptNewProject } = await setup('');
    fsStub.browseDirectory.mockResolvedValueOnce('/picked/dir');
    promptNewProject();
    await browseField()(input('modal-project-path'));
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalledWith('/picked/dir');
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('restores the plain label when the probed directory does not exist', async () => {
    const { promptNewProject } = await setup('');
    fsStub.isDirectory.mockResolvedValueOnce(false);
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = '/home/u/gone';
    pathInput.dispatchEvent(blurTo(input('modal-project-name')));
    await flush();
    expect(confirmBtn().textContent).toBe('Create');
  });

  it('never probes on a Cancel dismissal: a blur into the footer is not a focus move', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    // The open probe of the prefill is legitimate; this case is about the
    // dismissal blurs that come after it.
    await flush();
    fsStub.isDirectory.mockClear();
    const actions = document.createElement('div');
    actions.id = 'modal-actions';
    const cancel = document.createElement('button');
    actions.appendChild(cancel);
    document.body.appendChild(actions);
    // Cancel/Confirm blur: the footer owns the click, so no probe.
    input('modal-project-path').dispatchEvent(blurTo(cancel));
    // Esc hides the overlay: a dismissal carries no relatedTarget at all.
    input('modal-project-path').dispatchEvent(new Event('blur'));
    await flush();
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
    // The dismissal blurs paint nothing: the label the open probe earned
    // for the prefill stands untouched.
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('drops a stale probe reply over the name rewrite; the rewrite probes its own value', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    // The prefill exists; the `<folder>/demo` the name sync builds does not.
    fsStub.isDirectory.mockImplementation(async (p: string) => p === '/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    await flush();
    expect(confirmBtn().textContent).toBe('Select');
    // Queue a probe for the prefill whose reply is delayed past the rewrite.
    let resolveStale: (v: boolean) => void = () => {};
    fsStub.isDirectory.mockImplementationOnce(
      () => new Promise<boolean>((r) => { resolveStale = r; }),
    );
    pathInput.dispatchEvent(blurTo(input('modal-project-name')));
    await flush();
    const nameInput = input('modal-project-name');
    nameInput.value = 'demo';
    nameInput.dispatchEvent(new Event('input'));
    expect(pathInput.value).toBe('/home/u/projects/demo');
    // The programmatic rewrite probes the value it just wrote: Create is
    // earned by that reply, not by wiping the flag.
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalledWith('/home/u/projects/demo');
    expect(confirmBtn().textContent).toBe('Create');
    resolveStale(true);
    await flush();
    expect(confirmBtn().textContent).toBe('Create');
  });

  it('re-probes the name rewrite into Select when the new folder exists', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    fsStub.isDirectory.mockImplementation(async (p: string) => p === '/home/u/projects/demo');
    promptNewProject();
    await flush();
    expect(confirmBtn().textContent).toBe('Create');
    const nameInput = input('modal-project-name');
    nameInput.value = 'demo';
    nameInput.dispatchEvent(new Event('input'));
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalledWith('/home/u/projects/demo');
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('drops a late probe reply when the modal closes first (C2R-11 pattern)', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    modalMock.closeModal();
    await flush();
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

  it('fills a Windows default folder with backslashes as the name is typed', async () => {
    const { promptNewProject } = await setup('E:\\AI');
    promptNewProject();
    expect(input('modal-project-path').value).toBe('E:\\AI');
    const nameInput = input('modal-project-name');
    nameInput.value = 'Brillance';
    nameInput.dispatchEvent(new Event('input'));
    expect(input('modal-project-path').value).toBe('E:\\AI\\Brillance');
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

  it('joins the clone target with the parent folder\'s separator style', async () => {
    const { promptNewProject, addProject } = await setup('E:\\AI');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    expect(fsStub.cloneRepo).toHaveBeenCalledWith(URL_HTTPS, 'E:\\AI\\repo');
    expect(addProject).toHaveBeenCalledWith('repo', 'E:\\AI\\repo', undefined);
  });

  it('skips the directory probe and the create call for a URL', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!({ 'project-name': 'repo', 'project-path': URL_HTTPS, profile: '' });
    // A typed URL owns the field: nothing in the modal — open, blur,
    // confirm — may probe it, and confirm never creates it; the clone owns
    // the destination.
    expect(fsStub.isDirectory).not.toHaveBeenCalledWith(URL_HTTPS);
    expect(fsStub.expandPath).not.toHaveBeenCalledWith(URL_HTTPS);
    expect(fsStub.ensureDirectory).not.toHaveBeenCalled();
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

  it('keeps the manual path/name flow: confirm creates the directory and registers it', async () => {
    const { promptNewProject, addProject } = await setup('');
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '/home/u/demo', profile: '' });
    expect(fsStub.ensureDirectory).toHaveBeenCalledWith('/home/u/demo');
    // The confirm no longer gates on the consent-gated stat: main resolves
    // the raw path itself, so the modal neither expands nor stats it.
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
    expect(fsStub.expandPath).not.toHaveBeenCalledWith('/home/u/demo');
    expect(fsStub.cloneRepo).not.toHaveBeenCalled();
    expect(addProject).toHaveBeenCalledWith('demo', '/home/u/demo', undefined);
  });

  it('registers the path main resolved, not the spelling that was typed', async () => {
    const { promptNewProject, addProject } = await setup('');
    fsStub.ensureDirectory.mockResolvedValueOnce({ ok: true, path: 'E:\\AI\\Brillance' });
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': 'Brillance', 'project-path': 'E:\\AI/Brillance', profile: '' });
    expect(addProject).toHaveBeenCalledWith('Brillance', 'E:\\AI\\Brillance', undefined);
  });

  it('keeps the manual flow gated: a directory main cannot create shows the error', async () => {
    const { promptNewProject, addProject } = await setup('');
    fsStub.ensureDirectory.mockResolvedValueOnce({ ok: false, error: 'EACCES: permission denied' });
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '/home/u/gone', profile: '' });
    expect(modalMock.setModalError).toHaveBeenCalledWith(
      'project-path',
      'Could not create the directory: EACCES: permission denied',
    );
    expect(modalMock.closeModal).not.toHaveBeenCalled();
    expect(addProject).not.toHaveBeenCalled();
  });
});

describe('Add-project clone busy guard (SR2-b)', () => {
  const values = (url: string) => ({ 'project-name': 'repo', 'project-path': url, profile: '' });

  it('swallows a re-confirm while a clone is in flight', async () => {
    // The modal's Enter keydown fires the confirm handler even with the
    // button disabled; the `cloning` guard must be armed before the first
    // await so the second trigger never reaches fs.cloneRepo.
    const { promptNewProject, addProject } = await setup('/home/u/projects');
    let resolveClone: (v: { ok: boolean }) => void = () => {};
    fsStub.cloneRepo.mockImplementationOnce(() => new Promise((r) => { resolveClone = r; }));
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    const first = modalMock.onConfirm!(values(URL_HTTPS));
    await modalMock.onConfirm!(values(URL_HTTPS));
    expect(fsStub.cloneRepo).toHaveBeenCalledTimes(1);
    resolveClone({ ok: true });
    await first;
    expect(fsStub.cloneRepo).toHaveBeenCalledTimes(1);
    expect(addProject).toHaveBeenCalledTimes(1);
  });

  it('disarms after a failed clone so a retry can start', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    fsStub.cloneRepo.mockResolvedValueOnce({ ok: false, error: 'boom' });
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = URL_HTTPS;
    pathInput.dispatchEvent(new Event('input'));
    await modalMock.onConfirm!(values(URL_HTTPS));
    expect(fsStub.cloneRepo).toHaveBeenCalledTimes(1);
    await modalMock.onConfirm!(values(URL_HTTPS));
    expect(fsStub.cloneRepo).toHaveBeenCalledTimes(2);
  });
});

describe('session-row surgical patch (S3-05)', () => {
  it('patches the count pill in place on close; the open Files panel survives', async () => {
    vi.resetModules();
    stubDom();
    const { appState } = await import('../state.js');
    const fileTree = await import('./file-tree.js');
    const { initSidebar } = await import('./sidebar.js');
    initSidebar();
    const p = appState.addProject('P', '/p');
    appState.setActiveProject(p.id);
    appState.addSession(p.id, 'S1');
    appState.addSession(p.id, 'S2');

    const filesBtn = Array.from(document.querySelectorAll('.project-action-btn'))
      .find((b) => b.querySelector('.action-label')?.textContent === 'Files') as HTMLButtonElement;
    filesBtn.click();
    const renderFileTreeMock = fileTree.renderFileTree as Mock;
    expect(renderFileTreeMock).toHaveBeenCalledTimes(1);
    const panel = document.querySelector('.project-panel-files');
    expect(panel).not.toBeNull();
    renderFileTreeMock.mockClear();

    appState.removeSession(p.id, appState.activeProject!.sessions[1].id);

    // The tree module was never re-entered: no panel wipe, no cache eviction.
    expect(renderFileTreeMock).not.toHaveBeenCalled();
    expect(document.querySelector('.project-panel-files')).toBe(panel);
    // The row's pill moved 2 → 1 in place.
    expect(document.querySelector('.project-item.active .project-session-count')!.textContent).toBe('1');
  });
});

describe('session-row batch-close gate (CI-06)', () => {
  it('defers the row refresh for batched removals and flushes it on the kick', async () => {
    vi.resetModules();
    stubDom();
    const { appState } = await import('../state.js');
    const { initSidebar } = await import('./sidebar.js');
    initSidebar();
    const p = appState.addProject('P', '/p');
    appState.setActiveProject(p.id);
    appState.addSession(p.id, 'S1');
    appState.addSession(p.id, 'S2');

    const row = document.querySelector('.project-item.active')!;
    const pill = row.querySelector('.project-session-count')!;
    expect(pill.textContent).toBe('2');

    // Close All marks every per-session removal `deferRender`. The old handler
    // ignored the flag and ran the full render() once per removal — wiping the
    // row nodes N times for one batch.
    appState.removeSession(p.id, appState.activeProject!.sessions[1].id, { deferRender: true });
    expect(document.querySelector('.project-item.active')).toBe(row);
    expect(pill.textContent).toBe('2');

    // The batch's trailing kick (a session-changed without deferRender)
    // repaints the touched project once.
    (appState as unknown as { emit(e: string, d?: unknown): void }).emit('session-changed', {
      sessionId: 'kick', kind: 'remove',
    });
    expect(document.querySelector('.project-item.active .project-session-count')!.textContent).toBe('1');
  });
});

describe('Add-project path autocomplete teardown (C2R-11)', () => {
  it('cancels the pending fs.listDirs burst when the modal closes', async () => {
    const { promptNewProject } = await setup('/home/u/projects');
    promptNewProject();
    const pathInput = input('modal-project-path');
    pathInput.value = '/home/u/projects/de';

    vi.useFakeTimers();
    try {
      pathInput.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(50); // inside the 100 ms debounce window
      expect(fsStub.listDirs).not.toHaveBeenCalled();

      // Esc / Cancel / Create all funnel through closeModal; the in-flight
      // debounce used to survive it and paint a detached dropdown.
      modalMock.closeModal();
      vi.advanceTimersByTime(500);
      expect(fsStub.listDirs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
