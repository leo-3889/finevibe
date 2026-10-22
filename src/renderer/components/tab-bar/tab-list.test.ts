// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// tab-bar/dom.ts grabs #tab-list at module load, so the strip must exist
// before the modules below are imported.
document.body.innerHTML = '<div id="tab-list"></div><div id="git-status"></div>';

const setActiveSession = vi.fn();
const reorderSession = vi.fn();
const renameSession = vi.fn();
const groupSessions = vi.fn();
const renameTabGroup = vi.fn();
const ungroupTabGroup = vi.fn();
let activeProject: Record<string, unknown> | null = null;

vi.mock('../../state.js', () => ({
  MAX_SESSION_NAME_LENGTH: 100,
  appState: {
    get activeProject() { return activeProject; },
    setActiveSession,
    reorderSession,
    renameSession,
    groupSessions,
    renameTabGroup,
    ungroupTabGroup,
    preferences: {},
  },
}));
vi.mock('../../provider-availability.js', () => ({
  hasMultipleAvailableProviders: () => false,
  getCachedProviderMetas: () => [],
  getProviderCapabilities: () => ({}),
  getProviderAvailabilitySnapshot: () => null,
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
vi.mock('../../session-unread.js', () => ({
  isUnread: vi.fn(() => false),
}));


const { render, updateTabStatus, handleSessionChanged, patchUnread } = await import('./tab-list.js');
const { isUnread } = await import('../../session-unread.js');
const { setActiveContextMenu, getActiveContextMenu } = await import('./menu.js');
const { _resetForTesting } = await import('./tab-scroll.js');
const { t } = await import('../../i18n.js');

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
function project(id: string, sessions: ReturnType<typeof cliSession>[], activeSessionId: string | null = sessions[0]?.id ?? null, tabGroups?: { id: string; name: string; sessionIds: string[]; colorIndex: number }[]) {
  return { id, name: `Project ${id}`, path: `/repo/${id}`, sessions, activeSessionId, tabGroups };
}
function tabGroup(id: string, name: string, sessionIds: string[], colorIndex = 0) {
  return { id, name, sessionIds, colorIndex };
}
function stubRect(el: HTMLElement, left: number, width: number) {
  el.getBoundingClientRect = () => ({
    left, right: left + width, width, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON: () => ({}),
  }) as DOMRect;
}
function fakeDataTransfer(id: string) {
  return { getData: (type: string) => (type === 'text/plain' ? id : ''), setData: vi.fn(), effectAllowed: '', dropEffect: '' };
}
function fireDrag(el: HTMLElement, type: string, clientX = 0, dataTransfer = fakeDataTransfer('s1')) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer });
  el.dispatchEvent(e);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  tabListEl.innerHTML = '';
  stripScroll = 0;
  for (const m of document.body.querySelectorAll('.tab-context-menu')) m.remove();
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

describe('rename-time structural events (SR2-e)', () => {
  it('replays the banked strip rebuild when the rename commits', () => {
    render();
    const tab = tabListEl.querySelector('.tab-item')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    // Close s1 while the rename input owns the strip: the event is banked,
    // not dropped — the input survives the chatty render().
    (activeProject as { sessions: unknown[] }).sessions = [];
    handleSessionChanged({ sessionId: 's1', kind: 'remove' });
    const input = tabListEl.querySelector('.tab-name input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(tabListEl.querySelectorAll('.tab-item')).toHaveLength(1);

    input.value = 'renamed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(renameSession).toHaveBeenCalledWith('p1', 's1', 'renamed', true);
    // The banked rebuild replayed: the strip mirrors the (now empty) model,
    // so the closed session is no longer a clickable ghost tab.
    expect(tabListEl.querySelector('.tab-item')).toBeNull();
  });

  it('replays the banked rebuild when the rename cancels', () => {
    render();
    const tab = tabListEl.querySelector('.tab-item')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    (activeProject as { sessions: unknown[] }).sessions = [];
    handleSessionChanged({ sessionId: 's1', kind: 'remove' });
    const input = tabListEl.querySelector('.tab-name input') as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tabListEl.querySelector('.tab-item')).toBeNull();
  });

  it('skips renders for deferred (batch-close) events and rebuilds on the kick', () => {
    activeProject = project('p1', [cliSession('s1', 'alpha'), cliSession('s2', 'beta')]);
    render();
    expect(tabListEl.querySelectorAll('.tab-item')).toHaveLength(2);

    handleSessionChanged({ sessionId: 's1', kind: 'remove', deferRender: true });
    // Deferred: the strip keeps the stale tab until the batch's kick.
    expect(tabListEl.querySelectorAll('.tab-item')).toHaveLength(2);

    (activeProject as { sessions: unknown[] }).sessions = [cliSession('s2', 'beta')];
    handleSessionChanged({ sessionId: 's1', kind: 'remove' });
    expect(tabListEl.querySelectorAll('.tab-item')).toHaveLength(1);
  });
});

describe('tab groups', () => {
  function groupedProject() {
    const sessions = [cliSession('s1', 'a'), cliSession('s2', 'b'), cliSession('s3', 'c')];
    activeProject = project('p1', sessions, 's1', [tabGroup('g1', 'Group 1', ['s1', 's2'])]);
    render();
  }

  it('renders one wrapper per run with label, count, and tabs that keep [data-session-id]', () => {
    groupedProject();
    const wrappers = tabListEl.querySelectorAll('.tab-group');
    expect(wrappers).toHaveLength(1);
    const wrapper = wrappers[0] as HTMLElement;
    expect(wrapper.className).toContain('tab-group-color-0');
    expect(wrapper.dataset.groupId).toBe('g1');
    expect(wrapper.querySelector('.tab-group-name')!.textContent).toBe('Group 1');
    expect(wrapper.querySelector('.tab-group-count')!.textContent).toBe('2');
    expect(wrapper.querySelectorAll('.tab-item[data-session-id]')).toHaveLength(2);
    expect(wrapper.querySelector('.tab-item')!.classList.contains('in-group')).toBe(true);
    // The label must not carry .tab-name (split-layout's rename-focus guard).
    expect(wrapper.querySelector('.tab-group-label .tab-name')).toBeNull();
    // The ungrouped tab stays a direct child of the strip.
    expect(tabListEl.querySelectorAll(':scope > .tab-item[data-session-id="s3"]')).toHaveLength(1);
  });

  it('label contextmenu yields Rename group + Ungroup; tab menu only for grouped tabs', () => {
    groupedProject();
    const openItems = (el: Element) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      const items = [...getActiveContextMenu()!.querySelectorAll('.tab-context-menu-item')].map((i) => i.textContent);
      getActiveContextMenu()!.remove();
      setActiveContextMenu(null);
      return items;
    };

    const labelItems = openItems(tabListEl.querySelector('.tab-group-label')!);
    expect(labelItems).toEqual([t('contextMenu.tab.renameGroup'), t('contextMenu.tab.ungroup')]);

    const groupedItems = openItems(tabListEl.querySelector('.tab-item[data-session-id="s1"]')!);
    expect(groupedItems).toContain(t('contextMenu.tab.renameGroup'));
    expect(groupedItems).toContain(t('contextMenu.tab.ungroup'));

    const plainItems = openItems(tabListEl.querySelector('.tab-item[data-session-id="s3"]')!);
    expect(plainItems).not.toContain(t('contextMenu.tab.renameGroup'));
    expect(plainItems).not.toContain(t('contextMenu.tab.ungroup'));
  });

  it('group rename: Enter commits, Escape reverts, a live rename survives re-render', () => {
    groupedProject();
    const label = tabListEl.querySelector('.tab-group-label') as HTMLElement;

    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = label.querySelector('.tab-group-name input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.maxLength).toBe(100);

    // render() during a group rename early-returns: the input survives.
    render();
    expect(label.querySelector('.tab-group-name input')).not.toBeNull();

    input.value = 'Frontend';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(renameTabGroup).toHaveBeenCalledWith('p1', 'g1', 'Frontend');

    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input2 = label.querySelector('.tab-group-name input') as HTMLInputElement;
    input2.value = 'Nope';
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(renameTabGroup).toHaveBeenCalledTimes(1);
    // render() rebuilt the strip: read the fresh label, not the detached one.
    const freshLabel = tabListEl.querySelector('.tab-group-label')!;
    expect(freshLabel.querySelector('.tab-group-name')!.textContent).toBe('Group 1');
  });

  it('Ungroup from a member tab dissolves the wrapper', () => {
    groupedProject();
    tabListEl.querySelector('.tab-item[data-session-id="s1"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    const ungroupItem = [...getActiveContextMenu()!.querySelectorAll('.tab-context-menu-item')]
      .find((i) => i.textContent === t('contextMenu.tab.ungroup')) as HTMLElement;
    ungroupItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ungroupTabGroup).toHaveBeenCalledWith('p1', 'g1');

    (activeProject as { tabGroups?: unknown }).tabGroups = undefined;
    render();
    expect(tabListEl.querySelector('.tab-group')).toBeNull();
    expect(tabListEl.querySelectorAll('.tab-item')).toHaveLength(3);
  });

  it('center-zone drop groups; edge drop reorders', () => {
    activeProject = project('p1', [cliSession('s1', 'a'), cliSession('s2', 'b')]);
    render();
    const source = tabListEl.querySelector('.tab-item[data-session-id="s1"]') as HTMLElement;
    const target = tabListEl.querySelector('.tab-item[data-session-id="s2"]') as HTMLElement;
    stubRect(target, 0, 90);
    fireDrag(source, 'dragstart', 0, fakeDataTransfer('s1'));

    fireDrag(target, 'drop', 45, fakeDataTransfer('s1'));
    expect(groupSessions).toHaveBeenCalledWith('p1', 's1', 's2');
    expect(reorderSession).not.toHaveBeenCalled();

    fireDrag(target, 'drop', 2, fakeDataTransfer('s1'));
    expect(reorderSession).toHaveBeenCalledWith('p1', 's1', 0);
  });

  it('center dwell highlights the target and its group; dragend sweeps', () => {
    vi.useFakeTimers();
    try {
      groupedProject();
      const source = tabListEl.querySelector('.tab-item[data-session-id="s3"]') as HTMLElement;
      const target = tabListEl.querySelector('.tab-item[data-session-id="s2"]') as HTMLElement;
      stubRect(target, 0, 90);
      fireDrag(source, 'dragstart', 0, fakeDataTransfer('s3'));
      fireDrag(target, 'dragover', 45, fakeDataTransfer('s3'));
      expect(target.classList.contains('drag-over-group')).toBe(false);

      vi.advanceTimersByTime(500);
      expect(target.classList.contains('drag-over-group')).toBe(true);
      expect(tabListEl.querySelector('.tab-item[data-session-id="s1"]')!.classList.contains('drag-over-group')).toBe(true);

      fireDrag(target, 'dragend', 45, fakeDataTransfer('s3'));
      expect(tabListEl.querySelectorAll('.drag-over-group')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a non-groupable target never lights the center zone', () => {
    const kanban = { id: 'kb', name: 'kanban', type: 'kanban' };
    activeProject = project('p1', [cliSession('s1', 'a'), kanban as never]);
    render();
    const target = tabListEl.querySelector('.tab-item[data-session-id="kb"]') as HTMLElement;
    stubRect(target, 0, 90);
    fireDrag(tabListEl.querySelector('.tab-item[data-session-id="s1"]') as HTMLElement, 'dragstart', 0, fakeDataTransfer('s1'));
    fireDrag(target, 'dragover', 45, fakeDataTransfer('s1'));
    vi.useFakeTimers();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(target.classList.contains('drag-over-group')).toBe(false);

    fireDrag(target, 'drop', 45, fakeDataTransfer('s1'));
    expect(groupSessions).not.toHaveBeenCalled();
    expect(reorderSession).not.toHaveBeenCalled();
  });

  it('updateTabStatus still patches a grouped tab dot', () => {
    groupedProject();
    updateTabStatus('s2', 'working');
    const dot = tabListEl.querySelector('.tab-group .tab-item[data-session-id="s2"] .tab-status') as HTMLElement;
    expect(dot.className).toContain('working');
  });
});

describe('session-changed patching (PA-12)', () => {
  beforeEach(() => {
    activeProject = project('p1', [cliSession('s1', 'alpha'), cliSession('s2', 'beta')]);
    render();
  });

  it('metadata change patches the tab in place — no strip rebuild', () => {
    const tab1 = tabListEl.querySelector<HTMLElement>('[data-session-id="s1"]')!;
    const tab2 = tabListEl.querySelector<HTMLElement>('[data-session-id="s2"]')!;
    const s1 = (activeProject as unknown as { sessions: { name: string; cliSessionId: string | null }[] }).sessions[0];
    s1.name = 'renamed';
    s1.cliSessionId = 'cli-adopted';

    handleSessionChanged({ sessionId: 's1', kind: 'metadata' });

    expect(tabListEl.querySelector('[data-session-id="s1"]')).toBe(tab1);
    expect(tabListEl.querySelector('[data-session-id="s2"]')).toBe(tab2);
    expect(tab1.querySelector('.tab-name')!.textContent).toBe('renamed');
    expect(tab1.dataset.cliSessionId).toBe('cli-adopted');
    expect(tab1.dataset.tabName).toBe('renamed');
  });

  it('payload-less session-changed keeps the full rebuild', () => {
    const tab1 = tabListEl.querySelector('[data-session-id="s1"]');
    handleSessionChanged();
    expect(tabListEl.querySelector('[data-session-id="s1"]')).not.toBe(tab1);
  });

  it('add / remove / reorder kinds keep the full rebuild', () => {
    const tab1 = tabListEl.querySelector('[data-session-id="s1"]');
    for (const kind of ['add', 'remove', 'reorder']) {
      handleSessionChanged({ sessionId: 's1', kind });
      expect(tabListEl.querySelector('[data-session-id="s1"]')).not.toBe(tab1);
    }
  });

  it('activate moves .active and the unread mask without rebuilding tabs', () => {
    vi.mocked(isUnread).mockImplementation((id: string) => id === 's2');
    render(); // re-render with s2 unread
    const tab1 = tabListEl.querySelector<HTMLElement>('[data-session-id="s1"]')!;
    const tab2 = tabListEl.querySelector<HTMLElement>('[data-session-id="s2"]')!;
    expect(tab1.classList.contains('active')).toBe(true);
    expect(tab2.classList.contains('unread')).toBe(true);

    (activeProject as { activeSessionId: string | null }).activeSessionId = 's2';
    handleSessionChanged({ sessionId: 's2', kind: 'activate' });

    expect(tabListEl.querySelector('[data-session-id="s1"]')).toBe(tab1);
    expect(tabListEl.querySelector('[data-session-id="s2"]')).toBe(tab2);
    expect(tab1.classList.contains('active')).toBe(false);
    expect(tab2.classList.contains('active')).toBe(true);
    expect(tab2.classList.contains('unread')).toBe(false); // active tab masks unread
  });

  it('metadata that changed group membership falls back to a full render', () => {
    const tab1 = tabListEl.querySelector('[data-session-id="s1"]');
    (activeProject as { tabGroups?: unknown[] }).tabGroups = [tabGroup('g1', 'Work', ['s1', 's2'])];

    handleSessionChanged({ sessionId: 's1', kind: 'metadata' });

    // Structural change → rebuild: the group wrapper now exists.
    expect(tabListEl.querySelector('[data-session-id="s1"]')).not.toBe(tab1);
    expect(tabListEl.querySelector('.tab-group')).not.toBeNull();
  });

  it('metadata for a session of another project triggers the safe rebuild', () => {
    const tab1 = tabListEl.querySelector('[data-session-id="s1"]');
    handleSessionChanged({ sessionId: 'zz', kind: 'metadata' });
    expect(tabListEl.querySelector('[data-session-id="s1"]')).not.toBe(tab1);
  });
});

describe('patchUnread (PA-11)', () => {
  it('flips unread classes in place and reports success', () => {
    activeProject = project('p1', [cliSession('s1', 'alpha'), cliSession('s2', 'beta')]);
    vi.mocked(isUnread).mockImplementation((id: string) => id === 's2');
    render();
    const tab2 = tabListEl.querySelector<HTMLElement>('[data-session-id="s2"]')!;
    expect(tab2.classList.contains('unread')).toBe(true);

    vi.mocked(isUnread).mockReturnValue(false);
    expect(patchUnread()).toBe(true);
    expect(tabListEl.querySelector('[data-session-id="s2"]')).toBe(tab2);
    expect(tab2.classList.contains('unread')).toBe(false);
  });

  it('reports failure when the strip no longer mirrors the model', () => {
    activeProject = project('p1', [cliSession('s1', 'alpha')]);
    render();
    (activeProject as { sessions: unknown[] }).sessions.push(cliSession('s2', 'beta'));
    expect(patchUnread()).toBe(false);
  });
});
