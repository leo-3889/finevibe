// @vitest-environment jsdom
// Todo #44: the GitHub rows' unread dots are the notification count on the
// overview. These tests pin the render contract: the widget is a subscriber of
// the unread store, so EVERY mutation — its own ingest, the sibling widget's
// ingest / mark-read / mark-all-read, project removal — re-renders the dots.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const lastSeen = new Map<string, string>();
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  return {
    lastSeen,
    on(event: string, cb: (data?: unknown) => void): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => { listeners.get(event)?.delete(cb); };
    },
    emit(event: string, data?: unknown): void {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
    clearListeners(): void { listeners.clear(); },
  };
});

vi.mock('../../../state.js', () => ({
  appState: {
    projects: [{ id: 'p1', path: '/repo' }],
    on(event: string, cb: (data?: unknown) => void) {
      return store.on(event, cb);
    },
    getGithubLastSeen: (_pid: string, itemId: string) => store.lastSeen.get(itemId),
    setGithubItemSeen: (_pid: string, itemId: string, ts: string) => {
      store.lastSeen.set(itemId, ts);
      store.emit('github-unread-changed', 'p1');
    },
    setGithubItemsSeenBulk: (_pid: string, entries: Record<string, string>) => {
      for (const [id, ts] of Object.entries(entries)) store.lastSeen.set(id, ts);
      store.emit('github-unread-changed', 'p1');
    },
  },
}));

import { createGithubPRsWidget } from './github-widgets';
import {
  ingestItems,
  init as initGithubUnread,
  markAllReadInProject,
  unreadCountInProject,
  _resetForTesting,
} from '../../../github-unread';
import type { GithubItem } from '../../../../shared/types';
import type { WidgetHost } from './widget-host';

function prItem(n: number): GithubItem {
  return {
    number: n,
    title: `PR ${n}`,
    state: 'open',
    user: null,
    html_url: `https://github.com/owner/repo/pull/${n}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
  };
}

function makeHost(): WidgetHost {
  return {
    projectId: 'p1', widgetId: 'w1', widgetType: 'github-prs',
    getConfig: () => ({ repo: 'owner/repo', max: 10, refreshSeconds: 300 }),
    setConfig: vi.fn(), openSettings: vi.fn(), requestRefresh: vi.fn(),
  } as WidgetHost;
}

function dots(widget: { element: HTMLElement }): number {
  return widget.element.querySelectorAll('.widget-github-row.unread').length;
}

async function mount(items: GithubItem[]) {
  const listPRs = vi.fn(async () => ({ ok: true, items }));
  Object.assign(window, { finevibe: { github: { isAvailable: async () => true, listPRs } } });
  const widget = createGithubPRsWidget(makeHost());
  await vi.advanceTimersByTimeAsync(0);
  return widget;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTesting();
  store.lastSeen.clear();
  store.clearListeners();
  initGithubUnread();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GitHub widget unread render contract (Todo #44)', () => {
  it('lights the dot for an item the widget itself ingested as unread', async () => {
    const widget = await mount([prItem(3)]);
    expect(dots(widget)).toBe(1);
    widget.destroy();
  });

  it('clears the dot when the sibling widget\'s exhaustive ingest prunes the shared set', async () => {
    const widget = await mount([prItem(3)]);
    expect(dots(widget)).toBe(1);

    // The Issues widget polls the same repo under `state=open` and comes back
    // under the cap: the store takes it as the whole truth for `owner/repo#…`
    // and drops the PR id that vanished. It notifies its subscribers; the
    // appState 'github-unread-changed' event the widget used to listen for is
    // never emitted on this path — so the dot stayed lit forever.
    ingestItems('p1', 'owner/repo', [], true);
    expect(unreadCountInProject('p1')).toBe(0);
    expect(dots(widget)).toBe(0);
    widget.destroy();
  });

  it('clears every dot when Mark-all-read is pressed in the SIBLING widget', async () => {
    const widget = await mount([prItem(3), prItem(4)]);
    expect(dots(widget)).toBe(2);

    markAllReadInProject('p1'); // the other widget's button, same project set
    expect(unreadCountInProject('p1')).toBe(0);
    expect(dots(widget)).toBe(0);
    widget.destroy();
  });

  it('re-renders when the project is removed, and stops listening after destroy', async () => {
    const widget = await mount([prItem(3)]);
    expect(dots(widget)).toBe(1);

    store.emit('project-removed', 'p1');
    expect(unreadCountInProject('p1')).toBe(0);
    expect(dots(widget)).toBe(0);

    widget.destroy();
    // A mutation after teardown must not touch a detached tree (or throw).
    ingestItems('p1', 'owner/repo', [prItem(9)]);
    expect(dots(widget)).toBe(0);
  });
});
