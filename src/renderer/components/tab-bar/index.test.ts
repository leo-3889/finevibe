// @vitest-environment jsdom
// Todo #44: the tab strip is where the unread/notification count is visible
// (the tab dots, and the project tab's GitHub dot). These are component-level
// tests of the store→badge wiring: initTabBar subscribes to the unread stores
// once, and every store mutation repaints the strip — including mutations that
// arrive while the page is not painting, and mutations made by another
// component (the GitHub widget's Mark-all-read).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

document.body.innerHTML = `
  <div id="tab-list"></div>
  <div id="git-status"></div>
  <button id="btn-add-session"></button>
  <button id="btn-add-session-menu"></button>
  <button id="btn-add-browser-tab"></button>
  <button id="btn-more"></button>
  <button id="btn-toggle-terminal"></button>
`;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const lastSeen = new Map<string, string>();
  const statusCbs: Array<(sessionId: string, status: string) => void> = [];
  return {
    listeners,
    lastSeen,
    statusCbs,
    projects: [] as Array<Record<string, unknown>>,
    activeProjectId: null as string | null,
    fire(event: string, data?: unknown): void {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
    fireStatus(sessionId: string, status: string): void {
      for (const cb of statusCbs) cb(sessionId, status);
    },
  };
});

vi.mock('../../state.js', () => ({
  MAX_SESSION_NAME_LENGTH: 100,
  appState: {
    projects: harness.projects,
    get activeProjectId() { return harness.activeProjectId; },
    get activeProject() {
      return harness.projects.find((p) => p.id === harness.activeProjectId) ?? null;
    },
    preferences: {},
    on(event: string, cb: (data?: unknown) => void) {
      if (!harness.listeners.has(event)) harness.listeners.set(event, []);
      harness.listeners.get(event)!.push(cb);
      return () => {
        const list = harness.listeners.get(event);
        if (list) list.splice(list.indexOf(cb), 1);
      };
    },
    getGithubLastSeen: (_pid: string, itemId: string) => harness.lastSeen.get(itemId),
    setGithubItemSeen(_pid: string, itemId: string, ts: string) {
      harness.lastSeen.set(itemId, ts);
      harness.fire('github-unread-changed', _pid);
    },
    setGithubItemsSeenBulk(_pid: string, entries: Record<string, string>) {
      for (const [id, ts] of Object.entries(entries)) harness.lastSeen.set(id, ts);
      harness.fire('github-unread-changed', _pid);
    },
  },
}));
vi.mock('../../session-activity.js', () => ({
  onChange: (cb: (sessionId: string, status: string) => void) => { harness.statusCbs.push(cb); },
  getStatus: () => 'idle',
  STATUS_GLYPH: {},
}));
vi.mock('../../host-registry.js', () => ({
  onHostsChange: () => () => {},
  getHostColor: () => '',
  getHostName: () => '',
  getEnrolledHosts: () => [],
}));
vi.mock('../../provider-availability.js', () => ({
  loadProviderAvailability: async () => {},
  hasMultipleAvailableProviders: () => false,
  getCachedProviderMetas: () => [],
  getProviderCapabilities: () => ({}),
  getProviderAvailabilitySnapshot: () => null,
}));
vi.mock('../../git-status.js', () => ({
  onChange: () => () => {},
  getGitStatus: () => null,
  getActiveGitPath: () => null,
  refreshGitStatus: () => {},
}));
vi.mock('../../session-close.js', () => ({
  closeSessionWithConfirm: vi.fn(),
  closeAllSessionsWithConfirm: vi.fn(),
  closeOtherSessionsWithConfirm: vi.fn(),
  closeSessionsFromRightWithConfirm: vi.fn(),
  closeSessionsFromLeftWithConfirm: vi.fn(),
}));
vi.mock('../../sharing/peer-host.js', () => ({ isSharing: () => false }));
vi.mock('../../sharing/share-manager.js', () => ({ onShareChange: () => () => {}, endShare: vi.fn() }));
vi.mock('../share-dialog.js', () => ({ showShareDialog: vi.fn() }));
vi.mock('../session-inspector.js', () => ({
  openInspector: vi.fn(), isInspectorOpen: () => false,
  getInspectedSessionId: () => null, closeInspector: vi.fn(),
}));
vi.mock('./session-menu.js', () => ({
  showMoreMenu: vi.fn(), promptNewSession: vi.fn(), quickNewSession: vi.fn(),
}));
vi.mock('./git-status-bar.js', () => ({ renderGitStatus: vi.fn(), showBranchContextMenu: vi.fn() }));
vi.mock('./tab-arrows.js', () => ({ initTabArrows: vi.fn(), syncTabArrows: vi.fn() }));

import { init, isUnread, _resetForTesting as resetUnread } from '../../session-unread.js';
import {
  ingestItems, markAllReadInProject, _resetForTesting as resetGithubUnread,
} from '../../github-unread.js';
import type { GithubItem } from '../../../shared/types';

const tabListEl = document.getElementById('tab-list')!;
// jsdom has no layout and no compositor: strip scrollLeft and freeze rAF so the
// hidden-window case (queued frame, no paint) is observable.
let stripScroll = 0;
Object.defineProperty(tabListEl, 'scrollLeft', {
  configurable: true,
  get: () => stripScroll,
  set: (v: number) => { stripScroll = v; },
});
const rafQueue: FrameRequestCallback[] = [];
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
});
function flushRaf(): void {
  const q = rafQueue.splice(0, rafQueue.length);
  for (const cb of q) cb(0);
}

function cliSession(id: string, name: string) {
  return { id, name, cliSessionId: `cli-${id}`, providerId: 'claude' };
}
function overviewTab() {
  return { id: 'overview', name: 'Overview', type: 'project-tab' };
}
function makeProject() {
  return {
    id: 'p1', name: 'Project 1', path: '/repo/p1',
    sessions: [overviewTab(), cliSession('s1', 'alpha'), cliSession('s2', 'beta')],
    activeSessionId: 's1',
  };
}
function tab(sessionId: string): HTMLElement | null {
  return tabListEl.querySelector<HTMLElement>(`.tab-item[data-session-id="${sessionId}"]`);
}

function githubItem(n: number): GithubItem {
  return {
    number: n, title: `PR ${n}`, state: 'open', user: null,
    html_url: `https://github.com/owner/repo/pull/${n}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', closed_at: null,
  };
}

const { initTabBar } = await import('./index.js');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  resetUnread();
  resetGithubUnread();
  harness.listeners.clear();
  harness.statusCbs.length = 0;
  harness.lastSeen.clear();
  harness.projects.length = 0;
  harness.projects.push(makeProject());
  harness.activeProjectId = 'p1';
  rafQueue.length = 0;
  tabListEl.innerHTML = '';
  stripScroll = 0;
  init();
  initTabBar();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tab-bar unread badge wiring (Todo #44)', () => {
  it('lights a background session tab after a frame', () => {
    harness.fireStatus('s2', 'working');
    harness.fireStatus('s2', 'waiting');
    expect(tab('s2')?.classList.contains('unread')).toBe(false); // coalesced
    flushRaf();
    expect(tab('s2')?.classList.contains('unread')).toBe(true);
    expect(isUnread('s2')).toBe(true);
  });

  it('lights the tab when no frame ever arrives (window hidden while the notification landed)', () => {
    harness.fireStatus('s2', 'working');
    harness.fireStatus('s2', 'waiting');
    expect(tab('s2')?.classList.contains('unread')).toBe(false);

    vi.advanceTimersByTime(100);
    expect(tab('s2')?.classList.contains('unread')).toBe(true);
  });

  it('clears a tab dot when a session is closed while the window is hidden', () => {
    harness.fireStatus('s2', 'working');
    harness.fireStatus('s2', 'waiting');
    flushRaf();
    expect(tab('s2')?.classList.contains('unread')).toBe(true);

    // Closing s2 leaves it as the visible tab, so its dot must go with the
    // repaint — and the repaint has to happen without a frame.
    harness.projects[0].activeSessionId = 's2';
    harness.fire('session-removed', { sessionId: 's2' });
    vi.advanceTimersByTime(100);
    expect(isUnread('s2')).toBe(false);
    expect(tab('s2')?.classList.contains('unread')).toBe(false);
  });

  it('clears the project tab GitHub dot when Mark-all-read is pressed in the GitHub widget', () => {
    ingestItems('p1', 'owner/repo', [githubItem(3)]);
    flushRaf();
    expect(tab('overview')?.classList.contains('unread')).toBe(true);

    // The widget owns this mutation; the strip has no call into it.
    markAllReadInProject('p1');
    flushRaf();
    expect(tab('overview')?.classList.contains('unread')).toBe(false);
  });

  it('clears the project tab GitHub dot when the mutation lands in a hidden window', () => {
    ingestItems('p1', 'owner/repo', [githubItem(3)]);
    flushRaf();
    expect(tab('overview')?.classList.contains('unread')).toBe(true);

    markAllReadInProject('p1');
    vi.advanceTimersByTime(100); // no frame: the store notifies synchronously
    expect(tab('overview')?.classList.contains('unread')).toBe(false);
  });

  it('ignores a GitHub notify for a background project (review 24db32b8 #2)', () => {
    // Desync the strip from the model so a strip pass is observable:
    // patchUnread() then returns false and the subscriber falls through to a
    // full render(), which wipes the stray node.
    const ghost = document.createElement('div');
    ghost.className = 'tab-item';
    ghost.dataset.sessionId = 'ghost';
    tabListEl.appendChild(ghost);

    // A background project's widget polled: nothing this strip renders moves.
    ingestItems('p2', 'owner/repo', [githubItem(3)]);
    expect(tabListEl.contains(ghost)).toBe(true);

    ingestItems('p1', 'owner/repo', [githubItem(3)]);
    expect(tabListEl.contains(ghost)).toBe(false);
    expect(tab('overview')?.classList.contains('unread')).toBe(true);
  });

  it('repaints the dots once for a burst that arrives with no frame', () => {
    // Two notifications, one repaint: the store coalesces, the strip patches.
    harness.fireStatus('s2', 'working');
    harness.fireStatus('s1', 'working');
    harness.fireStatus('s2', 'waiting');
    harness.fireStatus('s1', 'waiting');
    vi.advanceTimersByTime(100);
    expect(tab('s2')?.classList.contains('unread')).toBe(true);
  });
});
