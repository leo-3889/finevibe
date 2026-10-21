// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// tab-bar/dom.ts grabs #tab-list at module load, so the strip must exist
// before the modules below are imported.
document.body.innerHTML = '<div id="tab-list"></div><div id="git-status"></div>';

const setActiveSession = vi.fn();
const reorderSession = vi.fn();
const renameSession = vi.fn();
let activeProject: Record<string, unknown> | null = null;

vi.mock('../../state.js', () => ({
  MAX_SESSION_NAME_LENGTH: 100,
  appState: {
    get activeProject() { return activeProject; },
    setActiveSession,
    reorderSession,
    renameSession,
    preferences: {},
  },
}));
vi.mock('../../provider-availability.js', () => ({
  hasMultipleAvailableProviders: () => false,
  getCachedProviderMetas: () => [],
  getProviderCapabilities: () => ({}),
}));
vi.mock('../../session-close.js', () => ({
  closeSessionWithConfirm: vi.fn(),
  closeAllSessionsWithConfirm: vi.fn(),
  closeOtherSessionsWithConfirm: vi.fn(),
  closeSessionsFromRightWithConfirm: vi.fn(),
  closeSessionsFromLeftWithConfirm: vi.fn(),
}));
vi.mock('../share-dialog.js', () => ({ showShareDialog: vi.fn() }));
vi.mock('../../sharing/peer-host.js', () => ({ isSharing: () => false }));
vi.mock('../../sharing/share-manager.js', () => ({ endShare: vi.fn() }));
vi.mock('../session-inspector.js', () => ({
  openInspector: vi.fn(),
  isInspectorOpen: () => false,
  getInspectedSessionId: () => null,
  closeInspector: vi.fn(),
}));
vi.mock('../resume-with-provider-menu.js', () => ({ buildResumeWithProviderItems: () => [] }));

const { render, updateTabStatus } = await import('./tab-list.js');
const { setActiveContextMenu, getActiveContextMenu } = await import('./menu.js');
const { _resetForTesting } = await import('./tab-scroll.js');

const tabListEl = document.getElementById('tab-list')!;
// jsdom has no layout: `scrollLeft` is hard-wired to 0 there, so the strip
// gets an in-memory offset — exactly the read/write pair render() performs.
let stripScroll = 0;
Object.defineProperty(tabListEl, 'scrollLeft', {
  configurable: true,
  get: () => stripScroll,
  set: (v: number) => { stripScroll = v; },
});

function cliSession(id: string, name: string) {
  return { id, name, cliSessionId: `cli-${id}`, providerId: 'claude' };
}
function project(id: string, sessions: ReturnType<typeof cliSession>[], activeSessionId: string | null = sessions[0]?.id ?? null) {
  return { id, name: `Project ${id}`, path: `/repo/${id}`, sessions, activeSessionId };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  tabListEl.innerHTML = '';
  stripScroll = 0;
  document.body.querySelectorAll('.tab-context-menu').forEach((m) => m.remove());
  setActiveContextMenu(null);
  activeProject = project('p1', [cliSession('s1', 'alpha')]);
});

describe('dblclick rename (P2-103)', () => {
  it('does not open the rename input when the double-click lands on ×', () => {
    render();
    const tab = tabListEl.querySelector('.tab-item')!;
    tab.querySelector('.tab-close')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(tab.querySelector('.tab-name input')).toBeNull();
  });

  it('opens the rename input on a body double-click (the guarded case still works)', () => {
    render();
    const tab = tabListEl.querySelector('.tab-item')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(tab.querySelector('.tab-name input')).not.toBeNull();
  });
});

describe('rename-time hand-scroll banking (P2-119)', () => {
  it('banks a scroll made during an open rename, so the project returns to it', () => {
    render(); // p1 commits at 0
    stripScroll = 120; // the user drags the strip by hand
    const tab = tabListEl.querySelector('.tab-item')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); // rename input open
    render(); // the chatty render that early-returns must bank 120 first

    // Trip through another project and back: p1 must restore the hand-scroll.
    activeProject = project('p2', [cliSession('s2', 'beta')]);
    render();
    activeProject = project('p1', [cliSession('s1', 'alpha')]);
    render();
    expect(tabListEl.scrollLeft).toBe(120);
  });
});

describe('updateTabStatus tooltips (P3-9)', () => {
  it('keeps a special tab\'s path tooltip across a status tick', () => {
    const fileTab = { id: 'fr', name: 'notes.md', type: 'file-reader', fileReaderPath: '/repo/notes.md' };
    activeProject = project('p1', [cliSession('s1', 'alpha'), fileTab as never]);
    render();
    const el = tabListEl.querySelector('.tab-item[data-session-id="fr"]')!;
    const pathTooltip = el.title;
    expect(pathTooltip).toContain('/repo/notes.md');

    updateTabStatus('fr', 'working');
    expect(el.title).toBe(pathTooltip);

    // The CLI tab next to it does take the status tooltip.
    const cliEl = tabListEl.querySelector('.tab-item[data-session-id="s1"]')!;
    updateTabStatus('s1', 'working');
    expect(cliEl.title).toContain('working');
    expect(cliEl.title).not.toBe(pathTooltip);
  });
});

describe('shared context-menu singleton (P2-107, tab side)', () => {
  it('opening the tab menu closes the sidebar\'s project menu', () => {
    render();
    // The sidebar's project menu, registered exactly as sidebar.ts now does
    // it: the shared singleton plus a `.tab-context-menu` node on <body>.
    const projectMenu = document.createElement('div');
    projectMenu.className = 'tab-context-menu';
    document.body.appendChild(projectMenu);
    setActiveContextMenu(projectMenu);

    tabListEl.querySelector('.tab-item')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(document.body.contains(projectMenu)).toBe(false);
    const menus = document.querySelectorAll('.tab-context-menu');
    expect(menus).toHaveLength(1);
    expect(getActiveContextMenu()).toBe(menus[0]);
  });
});
