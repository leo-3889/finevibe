// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StatsCache } from '../../../types.js';
import type { WidgetHost } from './widget-host.js';
import { createUsageStatsWidget } from './usage-stats-widget.js';

/** Only the four summary cards render for this shape; `lastComputedDate` is the marker. */
function payload(marker: string): StatsCache {
  return {
    totalSessions: 1,
    totalMessages: 2,
    firstSessionDate: '2026-01-01T00:00:00.000Z',
    lastComputedDate: marker,
    dailyActivity: [],
    modelUsage: {},
    hourCounts: {},
  } as unknown as StatsCache;
}

/** Flush the pending microtask chain; the widget's render makes no real timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function stubStats(getCache: () => Promise<StatsCache>): void {
  (window as unknown as { finevibe: unknown }).finevibe = { stats: { getCache: vi.fn(getCache) } };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('usage-stats-widget', () => {
  // UI2-10: refresh() re-runs the stats IPC, and the responses can land out of
  // order — an older payload used to overwrite the newer render.
  it('drops a stale stats response when a newer refresh is in flight', async () => {
    const first = Promise.withResolvers<StatsCache>();
    const second = Promise.withResolvers<StatsCache>();
    const queue = [first.promise, second.promise];
    stubStats(() => queue.shift() ?? Promise.resolve(payload('UNQUEUED')));

    const widget = createUsageStatsWidget({} as WidgetHost); // mount render in flight (first)
    widget.refresh(); // second refresh, same tick

    second.resolve(payload('FRESH'));
    await flush();
    expect(widget.element.textContent).toContain('FRESH');

    // The older request lands last: it must not rewrite the widget.
    first.resolve(payload('STALE'));
    await flush();
    expect(widget.element.textContent).toContain('FRESH');
    expect(widget.element.textContent).not.toContain('STALE');
  });

  it('stops writing into the DOM after destroy', async () => {
    const pending = Promise.withResolvers<StatsCache>();
    stubStats(() => pending.promise);

    const widget = createUsageStatsWidget({} as WidgetHost);
    widget.destroy();
    pending.resolve(payload('AFTER-DESTROY'));
    await flush();

    expect(widget.element.textContent).not.toContain('AFTER-DESTROY');
  });
});
