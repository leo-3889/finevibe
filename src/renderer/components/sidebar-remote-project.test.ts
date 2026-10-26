// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// T5 (plan §6, UR-6): the Add-project modal under a NON-local active tab.
// Every path verb (prefill, Browse, probe, create, clone, autocomplete) must
// run on the host over the hosts:* lanes; the local fs:* lanes and the local
// directory dialog must never be touched. Harness mirrors
// sidebar-clone.test.ts: mini-modal rendering the real element ids, sidebar
// re-imported after the DOM stub (module-load DOM grabs).

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

const showRemoteDirBrowser: Mock = vi.fn();
vi.mock('./remote-dir-browser.js', () => ({
  showRemoteDirBrowser: (opts: unknown) => showRemoteDirBrowser(opts),
}));

const HOST = {
  id: 'h1', name: 'strix', user: 'dev', host: '10.0.0.2', port: 22,
  authKind: 'key', managedKey: true, enrollmentStatus: 'enrolled',
  defaultFolder: '/home/dev/dev',
};
vi.mock('../host-registry.js', () => ({
  getHost: vi.fn((id: string) => (id === 'h1' ? HOST : null)),
  getHostColor: vi.fn(() => '#ff0000'),
  getHostName: vi.fn((id: string) => (id === 'h1' ? 'strix' : 'Local')),
  onHostsChange: vi.fn(() => () => {}),
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
interface HostsStub {
  list: Mock;
  listDirs: Mock;
  stat: Mock;
  ensureDir: Mock;
  cloneRepo: Mock;
}

let fsStub: FsStub;
let hostsStub: HostsStub;

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
  hostsStub = {
    list: vi.fn(async () => [HOST]),
    listDirs: vi.fn(async () => ({ ok: true, dirs: [] as string[] })),
    stat: vi.fn(async () => ({ ok: true, isDirectory: true })),
    ensureDir: vi.fn(async (_id: string, p: string) => ({ ok: true, path: p })),
    cloneRepo: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { finevibe: unknown }).finevibe = {
    app: { openExternal: vi.fn() },
    store: { load: vi.fn(), save: vi.fn(async () => {}) },
    fs: fsStub,
    hosts: hostsStub,
  };
}

async function setup(hostId: string) {
  vi.resetModules();
  modalMock.showModal.mockClear();
  showRemoteDirBrowser.mockReset();
  stubDom();
  const { appState } = await import('../state.js');
  const { promptNewProject } = await import('./sidebar.js');
  appState.setPreference('defaultProjectsFolder', '/local/projects');
  if (hostId !== 'local') appState.setActiveHost(hostId);
  const addProject = vi.spyOn(appState, 'addProject').mockImplementation(() => undefined as never);
  return { promptNewProject, addProject };
}

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const confirmBtn = () => document.getElementById('modal-confirm') as HTMLButtonElement;
const flush = () => new Promise((r) => setTimeout(r, 0));
const URL_HTTPS = 'https://github.com/owner/repo';

describe('Add-project under a host tab (T5, UR-6)', () => {
  it('prefills the host defaultFolder and probes it over hosts:stat', async () => {
    const { promptNewProject } = await setup('h1');
    promptNewProject();
    await flush();
    expect(input('modal-project-path').value).toBe('/home/dev/dev');
    expect(hostsStub.stat).toHaveBeenCalledWith('h1', '/home/dev/dev');
    expect(fsStub.isDirectory).not.toHaveBeenCalled();
    expect(fsStub.expandPath).not.toHaveBeenCalled();
    expect(confirmBtn().textContent).toBe('Select');
  });

  it('falls back to remote ~ when the record has no defaultFolder', async () => {
    HOST.defaultFolder = undefined as unknown as string;
    try {
      const { promptNewProject } = await setup('h1');
      promptNewProject();
      await flush();
      expect(input('modal-project-path').value).toBe('~');
      expect(hostsStub.stat).toHaveBeenCalledWith('h1', '~');
    } finally {
      HOST.defaultFolder = '/home/dev/dev';
    }
  });

  it('Browse opens the remote browser, never the local dialog', async () => {
    const { promptNewProject } = await setup('h1');
    promptNewProject();
    const browse = (modalMock.showModal.mock.calls[0][1] as Array<{
      id: string; onButtonClick?: (i: HTMLInputElement) => void;
    }>).find((f) => f.id === 'project-path')!.onButtonClick!;
    browse(input('modal-project-path'));
    expect(showRemoteDirBrowser).toHaveBeenCalledTimes(1);
    expect(showRemoteDirBrowser.mock.calls[0][0]).toMatchObject({ hostId: 'h1', startPath: '/home/dev/dev' });
    expect(fsStub.browseDirectory).not.toHaveBeenCalled();
  });

  it('Create runs mkdir on the host and registers with the host id', async () => {
    const { promptNewProject, addProject } = await setup('h1');
    promptNewProject();
    hostsStub.ensureDir.mockResolvedValueOnce({ ok: true, path: '/home/dev/dev/demo' });
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '~/dev/demo', profile: '' });
    expect(hostsStub.ensureDir).toHaveBeenCalledWith('h1', '~/dev/demo');
    expect(fsStub.ensureDirectory).not.toHaveBeenCalled();
    expect(addProject).toHaveBeenCalledWith('demo', '/home/dev/dev/demo', undefined, 'h1');
  });

  it('Clone runs on the host, joins the remote parent without local expandPath', async () => {
    const { promptNewProject, addProject } = await setup('h1');
    promptNewProject();
    await modalMock.onConfirm!({ 'project-name': '', 'project-path': URL_HTTPS, profile: '' });
    expect(hostsStub.cloneRepo).toHaveBeenCalledWith('h1', URL_HTTPS, '/home/dev/dev/repo');
    expect(fsStub.cloneRepo).not.toHaveBeenCalled();
    expect(fsStub.expandPath).not.toHaveBeenCalled();
    expect(addProject).toHaveBeenCalledWith('repo', '/home/dev/dev/repo', undefined, 'h1');
  });

  it('autocomplete lists dirs over hosts:listDirs', async () => {
    const { promptNewProject } = await setup('h1');
    promptNewProject();
    hostsStub.listDirs.mockResolvedValueOnce({ ok: true, dirs: ['/home/dev/dev/demo'] });
    const pathInput = input('modal-project-path');
    pathInput.value = '/home/dev/dev/de';
    pathInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    // The sidebar's split keeps the parent's trailing slash; main's
    // normalizeRemotePath trims it.
    expect(hostsStub.listDirs).toHaveBeenCalledWith('h1', '/home/dev/dev/', 'de');
    expect(fsStub.listDirs).not.toHaveBeenCalled();
  });

  it('the Local tab keeps the fs lanes untouched by the remote branch', async () => {
    const { promptNewProject, addProject } = await setup('local');
    promptNewProject();
    await flush();
    expect(fsStub.isDirectory).toHaveBeenCalled();
    expect(hostsStub.stat).not.toHaveBeenCalled();
    await modalMock.onConfirm!({ 'project-name': 'demo', 'project-path': '/local/projects/demo', profile: '' });
    expect(fsStub.ensureDirectory).toHaveBeenCalled();
    expect(hostsStub.ensureDir).not.toHaveBeenCalled();
    // Pre-T5 3-arg call: no hostId on a local path.
    expect(addProject).toHaveBeenCalledWith('demo', '/local/projects/demo', undefined);
  });
});
