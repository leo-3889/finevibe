// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../state.js', () => ({
  appState: { projects: [{ id: 'p1', path: '/repo' }], on: () => () => {} },
}));
vi.mock('../../../github-unread.js', () => ({
  ingestItems: vi.fn(), isUnread: () => false, makeItemId: vi.fn(),
  markRead: vi.fn(), markAllReadInProject: vi.fn(),
}));

import { createGithubPRsWidget } from './github-widgets';
import * as githubUnread from '../../../github-unread.js';
import type { WidgetHost } from './widget-host';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('GitHub widget refresh ordering', () => {
  it('does not display an older error after a newer successful fetch', async () => {
    const first = deferred<{ ok: boolean; error?: string; items?: [] }>();
    const second = deferred<{ ok: boolean; error?: string; items?: [] }>();
    const listPRs = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    Object.assign(window, {
      finevibe: { github: { isAvailable: async () => true, listPRs } },
    });
    const host = {
      projectId: 'p1', widgetId: 'w1', widgetType: 'github-prs',
      getConfig: () => ({ repo: 'owner/repo' }),
      setConfig: vi.fn(), openSettings: vi.fn(), requestRefresh: vi.fn(),
    } as WidgetHost;
    const widget = createGithubPRsWidget(host);
    await vi.waitFor(() => expect(listPRs).toHaveBeenCalledTimes(1));
    widget.refresh?.();
    await vi.waitFor(() => expect(listPRs).toHaveBeenCalledTimes(2));
    second.resolve({ ok: true, items: [] });
    await vi.waitFor(() => expect(widget.element.textContent).toContain('No pull requests'));
    first.resolve({ ok: false, error: 'stale network error' });
    await Promise.resolve();
    expect(widget.element.textContent).not.toContain('stale network error');
    widget.destroy();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function makeHost(getConfig: () => Record<string, unknown>): WidgetHost {
  return {
    projectId: 'p1', widgetId: 'w1', widgetType: 'github-prs',
    getConfig, setConfig: vi.fn(), openSettings: vi.fn(), requestRefresh: vi.fn(),
  } as WidgetHost;
}

function stubGithub(stub: Record<string, unknown>): void {
  Object.assign(window, { finevibe: stub });
}

function prItem(n: number) {
  return {
    number: n, title: `PR ${n}`, state: 'open' as const, user: null,
    html_url: `https://github.com/owner/repo/pull/${n}`,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', closed_at: null,
  };
}

// C4G-02: every widget in every window used to spawn a `gh` run on each
// window-show; the interval poll already covers staleness.
describe('GitHub widget visibility throttle (C4G-02)', () => {
  it('skips the visibilitychange refresh inside 30 s and refreshes after it', async () => {
    vi.useFakeTimers();
    const listPRs = vi.fn(async () => ({ ok: true, items: [] }));
    stubGithub({ github: { isAvailable: async () => true, listPRs } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', refreshSeconds: 300 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPRs).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPRs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 31_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPRs).toHaveBeenCalledTimes(2);
    widget.destroy();
  });
});

// C4G-04 (C2M-05 shape): a rate-limited or logged-out widget must stop
// re-spawning `gh` at the configured cadence.
describe('GitHub widget gh-failure backoff (C4G-04)', () => {
  it('doubles the poll cadence per gh failure and resets on success', async () => {
    vi.useFakeTimers();
    const listPRs = vi.fn(async () => ({ ok: false, error: 'gh: You have exceeded a secondary rate limit (HTTP 403)' }));
    stubGithub({ github: { isAvailable: async () => true, listPRs } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', refreshSeconds: 60 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(listPRs).toHaveBeenCalledTimes(1);

    // 1st failure arms 2×60 s: the 60 s tick is a no-op, the 120 s tick retries.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(2);

    // 2nd failure arms 4×60 s: the retry lands on the 360 s tick.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(listPRs).toHaveBeenCalledTimes(2);

    // That retry succeeds → the window clears and the base 60 s cadence is back.
    listPRs.mockResolvedValue({ ok: true, items: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(4);
    widget.destroy();
  });

  it('caps the backoff at 30 minutes', async () => {
    vi.useFakeTimers();
    const listPRs = vi.fn(async () => ({ ok: false, error: 'gh: Not logged in to any account, run "gh auth login"' }));
    stubGithub({ github: { isAvailable: async () => true, listPRs } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', refreshSeconds: 60 })));
    await vi.advanceTimersByTimeAsync(0);
    // Walk the doubling ladder: 2, 4, 8, 16 minutes of armed window.
    for (const window of [120_000, 240_000, 480_000, 960_000]) {
      await vi.advanceTimersByTimeAsync(window);
    }
    expect(listPRs).toHaveBeenCalledTimes(5);

    // The 6th window would be 32 minutes uncapped; the cap keeps it at 30.
    await vi.advanceTimersByTimeAsync(1_740_000);
    expect(listPRs).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(6);
    widget.destroy();
  });

  it('keeps the configured cadence for a transient listing error', async () => {
    vi.useFakeTimers();
    const listPRs = vi.fn(async () => ({ ok: false, error: 'gh api returned invalid JSON for repos/owner/repo/pulls' }));
    stubGithub({ github: { isAvailable: async () => true, listPRs } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', refreshSeconds: 60 })));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listPRs).toHaveBeenCalledTimes(2);
    widget.destroy();
  });
});

// C4G-05: the repo caches lived for the widget's lifetime.
describe('GitHub widget repo-cache invalidation (C4G-05)', () => {
  it('re-detects the repo after git:changed and unsubscribes on destroy', async () => {
    vi.useFakeTimers();
    const subs: { cb: (() => void) | null; offs: number } = { cb: null, offs: 0 };
    const detectRepo = vi.fn(async () => ({ owner: 'owner', repo: 'repo' }));
    const listPRs = vi.fn(async () => ({ ok: true, items: [] }));
    stubGithub({
      github: { isAvailable: async () => true, detectRepo, listPRs },
      git: {
        onChanged: (cb: () => void) => {
          subs.cb = cb;
          return () => { subs.cb = null; subs.offs++; };
        },
      },
    });
    const widget = createGithubPRsWidget(makeHost(() => ({ refreshSeconds: 300 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(detectRepo).toHaveBeenCalledTimes(1);

    subs.cb?.();
    widget.refresh?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(detectRepo).toHaveBeenCalledTimes(2);

    widget.destroy();
    expect(subs.offs).toBe(1);
  });
});

describe('GitHub widget mark-all label (C4G-03)', () => {
  it('names every GitHub item in the project, not just the visible ones', async () => {
    vi.useFakeTimers();
    stubGithub({ github: { isAvailable: async () => true, listPRs: async () => ({ ok: true, items: [] }) } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', refreshSeconds: 300 })));
    const btn = widget.element.querySelector('.widget-github-mark-all') as HTMLButtonElement | null;
    expect(btn?.textContent).toBe('Mark all GitHub items in this project read');
    expect(btn?.title).toContain('pull requests and issues');
    widget.destroy();
  });
});

// C4G-01: the widget tells the unread store when the listing is the whole truth.
describe('GitHub widget exhaustive-listing ingest (C4G-01)', () => {
  it('passes exhaustive=true under the cap and false at the cap', async () => {
    vi.useFakeTimers();
    const items = [prItem(1), prItem(2)];
    const listPRs = vi.fn(async () => ({ ok: true, items }));
    stubGithub({ github: { isAvailable: async () => true, listPRs } });
    const widget = createGithubPRsWidget(makeHost(() => ({ repo: 'owner/repo', max: 10, refreshSeconds: 300 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(githubUnread.ingestItems).toHaveBeenCalledWith('p1', 'owner/repo', items, true);

    const capped = Array.from({ length: 10 }, (_, i) => prItem(i + 1));
    listPRs.mockResolvedValue({ ok: true, items: capped });
    widget.refresh?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(githubUnread.ingestItems).toHaveBeenLastCalledWith('p1', 'owner/repo', capped, false);
    widget.destroy();
  });
});
