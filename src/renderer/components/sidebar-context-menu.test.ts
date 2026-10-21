// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// sidebar.ts grabs its chrome nodes at module load, so they must exist before
// the module imports. The context menu itself lands on <body>.
document.body.innerHTML = `
  <div id="sidebar">
    <div id="project-list"></div>
    <div id="sidebar-discussions"></div>
    <div id="sidebar-resize-handle"></div>
    <div id="btn-toggle-sidebar"></div>
    <div id="btn-add-project"></div>
    <div id="btn-preferences"></div>
  </div>
`;

const appStateMock: Record<string, unknown> = {
  projects: [] as unknown[],
  activeProject: null,
  activeProjectId: null as string | null,
  preferences: { sessionHistoryEnabled: false, theme: 'dark' },
  sidebarCollapsed: false,
  sidebarWidth: 0,
  sidebarView: () => false,
  on: vi.fn(),
  setActiveProject: vi.fn(),
  toggleSidebar: vi.fn(),
};

vi.mock('../state.js', () => ({ MAX_PROJECT_NAME_LENGTH: 100, appState: appStateMock }));
vi.mock('../provider-availability.js', () => ({
  loadProviderMetas: vi.fn(async () => {}),
  loadProviderAvailability: vi.fn(async () => {}),
  hasMultipleAvailableProviders: () => false,
  getProviderAvailabilitySnapshot: () => null,
  getCachedProviderMetas: () => [],
  getAvailableProviderMetas: () => [],
  getTeamChatProviderMetas: () => [],
  getTeamCapableProviderIds: () => new Set(),
  getProviderCapabilities: () => ({ profiles: false }),
  getProviderDisplayName: (id: string) => id,
}));
vi.mock('../session-unread.js', () => ({ hasUnreadInProject: () => false, onChange: vi.fn() }));
vi.mock('../session-activity.js', () => ({
  onChange: vi.fn(),
  STATUS_GLYPH: { working: '…', waiting: '?', input: '?', completed: '✓', idle: '·' },
}));
vi.mock('../project-status.js', () => ({
  getProjectStatus: () => 'idle',
  projectInitial: (name: string) => name.charAt(0),
}));
vi.mock('../discussions-badge.js', () => ({
  init: vi.fn(),
  getNewCount: () => 0,
  markSeen: vi.fn(),
  onChange: vi.fn(),
  DISCUSSIONS_URL: 'https://example.invalid/discussions',
}));
vi.mock('../git-status.js', () => ({ gitChangeCount: () => null, onChange: vi.fn() }));
vi.mock('../profile-utils.js', () => ({
  projectProfileBadge: () => undefined,
  providerProfileOptions: () => [],
}));
vi.mock('./modal.js', () => ({
  showModal: vi.fn(),
  setModalError: vi.fn(),
  closeModal: vi.fn(),
  showConfirmDialog: vi.fn(),
}));
vi.mock('./preferences-modal.js', () => ({ showPreferencesModal: vi.fn() }));
vi.mock('./file-tree.js', () => ({
  renderFileTree: vi.fn(),
  clearProjectState: vi.fn(),
  closeFileTree: vi.fn(),
  FILE_MANAGER: 'Files',
}));
vi.mock('./session-history.js', () => ({
  renderSessionHistory: vi.fn(),
  closeSessionHistory: vi.fn(),
  clearProjectState: vi.fn(),
}));
vi.mock('./hover-card.js', () => ({ attachHoverCard: vi.fn() }));
vi.mock('./git-panel.js', () => ({ mountGitPanel: vi.fn(), closeGitPanel: vi.fn() }));
vi.mock('./project-settings.js', () => ({ promptProjectSettings: vi.fn() }));

const { initSidebar } = await import('./sidebar.js');
const { getActiveContextMenu, setActiveContextMenu } = await import('./tab-bar/menu.js');

(window as unknown as { finevibe: unknown }).finevibe = {
  app: { openExternal: vi.fn() },
  fs: { showInFolder: vi.fn(async () => ({ ok: true })) },
};

function openProjectMenu(): void {
  document.querySelector('.project-item')!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.querySelectorAll('.tab-context-menu').forEach((m) => m.remove());
  setActiveContextMenu(null);
  const p1 = { id: 'p1', name: 'Alpha', path: '/repo/alpha', sessions: [], activeSessionId: null };
  appStateMock.projects = [p1];
  appStateMock.activeProject = p1;
  appStateMock.activeProjectId = 'p1';
  initSidebar();
});

describe('shared context-menu singleton (P2-107, sidebar side)', () => {
  it('opening the project menu closes a tab-bar menu that is open', () => {
    // The tab bar's menu, registered exactly as menu.ts's consumers do it:
    // the shared singleton plus a `.tab-context-menu` node on <body>.
    const tabMenu = document.createElement('div');
    tabMenu.className = 'tab-context-menu';
    document.body.appendChild(tabMenu);
    setActiveContextMenu(tabMenu);

    openProjectMenu();

    expect(document.body.contains(tabMenu)).toBe(false);
    const menus = document.querySelectorAll('.tab-context-menu');
    expect(menus).toHaveLength(1);
    expect(getActiveContextMenu()).toBe(menus[0]);
  });

  it('a second project menu replaces the first', () => {
    openProjectMenu();
    const first = getActiveContextMenu();
    openProjectMenu();
    expect(document.body.contains(first)).toBe(false);
    expect(document.querySelectorAll('.tab-context-menu')).toHaveLength(1);
  });

  it('the sidebar registers its menu on the shared singleton', () => {
    openProjectMenu();
    expect(getActiveContextMenu()).not.toBeNull();
    expect(getActiveContextMenu()!.classList.contains('tab-context-menu')).toBe(true);
  });
});
