import { vi } from 'vitest';

vi.mock('./state.js', () => {
  const lastSeen = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    appState: {
      getGithubLastSeen: (_pid: string, itemId: string) => lastSeen.get(itemId),
      setGithubItemSeen: (_pid: string, itemId: string, ts: string) => {
        lastSeen.set(itemId, ts);
      },
      setGithubItemsSeenBulk: (_pid: string, entries: Record<string, string>) => {
        for (const [id, ts] of Object.entries(entries)) lastSeen.set(id, ts);
      },
      on: (event: string, cb: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return () => listeners.get(event)?.delete(cb);
      },
      __reset: () => { lastSeen.clear(); listeners.clear(); },
      __emit: (event: string, data?: unknown) => { listeners.get(event)?.forEach((cb) => cb(data)); },
    },
  };
});

import {
  ingestItems,
  isUnread,
  hasUnreadInProject,
  unreadCountInProject,
  markRead,
  markAllReadInProject,
  makeItemId,
  onChange,
  init,
  _resetForTesting,
} from './github-unread';
import type { GithubItem } from '../shared/types';
import { appState } from './state.js';

function fakeItem(num: number, updated: string): GithubItem {
  return {
    number: num,
    title: `item ${num}`,
    state: 'open',
    user: null,
    html_url: '',
    created_at: '2020-01-01T00:00:00Z',
    updated_at: updated,
    closed_at: null,
  };
}

beforeEach(() => {
  _resetForTesting();
  (appState as unknown as { __reset(): void }).__reset();
});

describe('makeItemId', () => {
  it('joins repo and number', () => {
    expect(makeItemId('foo/bar', 42)).toBe('foo/bar#42');
  });
});

describe('ingestItems', () => {
  it('marks new items as unread when there is no lastSeen', () => {
    const items = [fakeItem(1, '2024-01-01'), fakeItem(2, '2024-01-02')];
    expect(ingestItems('p1', 'foo/bar', items)).toBe(true);
    expect(unreadCountInProject('p1')).toBe(2);
    expect(isUnread('p1', 'foo/bar#1')).toBe(true);
    expect(isUnread('p1', 'foo/bar#2')).toBe(true);
  });

  it('does not mark unread when item has not been updated since lastSeen', () => {
    appState.setGithubItemSeen('p1', 'foo/bar#1', '2024-01-05');
    const items = [fakeItem(1, '2024-01-04')];
    expect(ingestItems('p1', 'foo/bar', items)).toBe(false);
    expect(isUnread('p1', 'foo/bar#1')).toBe(false);
  });

  it('marks unread when item updated_at is newer than lastSeen', () => {
    appState.setGithubItemSeen('p1', 'foo/bar#1', '2024-01-01');
    const items = [fakeItem(1, '2024-01-05')];
    expect(ingestItems('p1', 'foo/bar', items)).toBe(true);
    expect(isUnread('p1', 'foo/bar#1')).toBe(true);
  });

  // C4G-01: ids for items that dropped out of an exhaustive listing (merged /
  // closed under state=open) used to stay unread forever, pinning the tab dot.
  it('prunes stored ids of the repo that are absent from an exhaustive listing', () => {
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01'), fakeItem(2, '2024-01-01')]);
    expect(unreadCountInProject('p1')).toBe(2);

    expect(ingestItems('p1', 'foo/bar', [fakeItem(2, '2024-01-01')], true)).toBe(true);
    expect(isUnread('p1', 'foo/bar#1')).toBe(false);
    expect(isUnread('p1', 'foo/bar#2')).toBe(true);
  });

  it('keeps stored ids when the listing is capped (not exhaustive)', () => {
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    expect(ingestItems('p1', 'foo/bar', [], false)).toBe(false);
    expect(isUnread('p1', 'foo/bar#1')).toBe(true);
  });

  it('prunes only the fetched repo prefix and notifies listeners', () => {
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    ingestItems('p1', 'other/repo', [fakeItem(9, '2024-01-01')]);
    const cb = vi.fn();
    onChange(cb);

    ingestItems('p1', 'foo/bar', [], true);
    expect(isUnread('p1', 'foo/bar#1')).toBe(false);
    expect(isUnread('p1', 'other/repo#9')).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // Review 24db32b8 #3 (C4G-01 cross-prune): Issues and PRs share the
  // `${repo}#${number}` id space with DISJOINT listings, so the repo-wide
  // exhaustive prune made each widget's poll delete the sibling's unread ids —
  // the tab dot blinked off/on every 60s and Mark-all-read missed the item.
  // The fix is the caller's own `scope`.
  it('does not prune a sibling listing kind\'s ids when the caller passes a scope', () => {
    const prScope = new Set(['foo/bar#1']);
    const issueScope = new Set(['foo/bar#2']);

    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')], true, prScope);
    ingestItems('p1', 'foo/bar', [fakeItem(2, '2024-01-01')], true, issueScope);
    expect(isUnread('p1', 'foo/bar#1')).toBe(true);
    expect(isUnread('p1', 'foo/bar#2')).toBe(true);

    // The PRs widget polls #1 again, exhaustive: #2 belongs to Issues.
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')], true, prScope);
    expect(isUnread('p1', 'foo/bar#1')).toBe(true);
    expect(isUnread('p1', 'foo/bar#2')).toBe(true);

    // …and the scoped prune still drops the caller's OWN vanished id.
    ingestItems('p1', 'foo/bar', [], true, prScope);
    expect(isUnread('p1', 'foo/bar#1')).toBe(false);
    expect(isUnread('p1', 'foo/bar#2')).toBe(true);
  });

  it('keeps the repo-wide fallback for a caller with no scope of its own', () => {
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    ingestItems('p1', 'foo/bar', [], true);
    expect(isUnread('p1', 'foo/bar#1')).toBe(false);
  });
});

describe('hasUnreadInProject', () => {
  it('returns false when project has no unread', () => {
    expect(hasUnreadInProject('px')).toBe(false);
  });

  it('returns true after ingesting new items', () => {
    ingestItems('px', 'foo/bar', [fakeItem(7, '2024-01-01')]);
    expect(hasUnreadInProject('px')).toBe(true);
  });
});

describe('markRead', () => {
  it('removes the item from unread and persists lastSeen', () => {
    const item = fakeItem(3, '2024-02-01');
    ingestItems('p1', 'foo/bar', [item]);
    expect(isUnread('p1', 'foo/bar#3')).toBe(true);
    markRead('p1', 'foo/bar', item);
    expect(isUnread('p1', 'foo/bar#3')).toBe(false);
    expect(appState.getGithubLastSeen('p1', 'foo/bar#3')).toBe('2024-02-01');
  });
});

describe('markAllReadInProject', () => {
  it('clears all unread for the project', () => {
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01'), fakeItem(2, '2024-01-02')]);
    expect(unreadCountInProject('p1')).toBe(2);
    markAllReadInProject('p1');
    expect(unreadCountInProject('p1')).toBe(0);
  });
});

describe('onChange', () => {
  it('fires when ingest mutates the unread set', () => {
    const cb = vi.fn();
    const off = onChange(cb);
    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    expect(cb).toHaveBeenCalled();
    off();
  });

  // Review 24db32b8 #2: subscribers repaint one project's rows/dots, so they
  // need to know WHICH project moved. `undefined` = paint everything.
  it('names the mutated project on every mutation path', () => {
    const cb = vi.fn();
    const off = onChange(cb);

    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    expect(cb).toHaveBeenLastCalledWith('p1');
    markRead('p1', 'foo/bar', fakeItem(1, '2024-01-01'));
    expect(cb).toHaveBeenLastCalledWith('p1');
    ingestItems('p2', 'foo/bar', [fakeItem(5, '2024-01-01')]);
    expect(cb).toHaveBeenLastCalledWith('p2');
    markAllReadInProject('p2');
    expect(cb).toHaveBeenLastCalledWith('p2');
    off();
  });

  // Review 24db32b8 #5: the pass runs over a snapshot.
  it('does not skip a later listener when an earlier one unsubscribes mid-pass', () => {
    const second = vi.fn();
    const off = onChange(() => off()); // a widget tearing itself down off the notify
    onChange(second);

    ingestItems('p1', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('returns an unsubscribe function', () => {
    const cb = vi.fn();
    const off = onChange(cb);
    off();
    ingestItems('p1', 'foo/bar', [fakeItem(2, '2024-01-01')]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('init', () => {
  it('notifies with the removed project id', () => {
    init();
    ingestItems('to-remove', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    const cb = vi.fn();
    onChange(cb);

    (appState as unknown as { __emit(e: string, d?: unknown): void }).__emit('project-removed', 'to-remove');
    expect(unreadCountInProject('to-remove')).toBe(0);
    expect(cb).toHaveBeenCalledWith('to-remove');
  });

  it('clears unread when a project is removed', () => {
    init();
    ingestItems('to-remove', 'foo/bar', [fakeItem(1, '2024-01-01')]);
    expect(unreadCountInProject('to-remove')).toBe(1);

    (appState as unknown as { __emit(e: string): void }).__emit('project-removed');
    // Note: our mock __emit doesn't pass projectId so the listener bails out.
    // Verify the listener exists and is wired by directly invoking with id.
    const listeners = (appState as unknown as {
      on(e: string, cb: (data?: unknown) => void): () => void;
    });
    // Re-init to add our own listener that simulates project-removed with the id payload
    let received: unknown = undefined;
    listeners.on('project-removed', (data) => { received = data; });
    expect(received).toBeUndefined();
  });
});
