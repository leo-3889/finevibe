import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCost, onChange, parseCost, setCostData, _resetForTesting } from './session-cost';

// P5 (R4): the fallback cost scan ran a `stripAnsi` regex over EVERY PTY
// chunk — CPU paid on every paste-echo frame. The structured
// `session:costData` channel is the primary source; the fallback now scans
// leading-edge immediately and coalesces a burst to ONE trailing scan of
// the newest chunk per window, so the final cost of a burst still lands.

describe('parseCost throttle (P5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTesting();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans the leading chunk of a session immediately', () => {
    const seen: Array<[string, number]> = [];
    onChange((id, cost) => seen.push([id, cost.totalCostUsd]));

    parseCost('s1', 'total cost $1.25');

    expect(seen).toEqual([['s1', 1.25]]);
  });

  it('coalesces a burst to one trailing scan of the newest chunk', () => {
    const seen: number[] = [];
    onChange((_id, cost) => seen.push(cost.totalCostUsd));

    parseCost('s1', '$1.00');
    parseCost('s1', 'noise without a cost');
    parseCost('s1', '$3.00');

    // Leading edge scanned; the window coalesced the rest into one timer.
    expect(seen).toEqual([1]);

    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([1, 3]);

    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([1, 3]);
  });

  it('structured cost data disables the fallback scan entirely', () => {
    const seen: number[] = [];
    onChange((_id, cost) => seen.push(cost.totalCostUsd));
    setCostData('s1', { cost: { total_cost_usd: 5 }, context_window: { total_input_tokens: 100 }, model: 'm' } as never);
    expect(seen).toEqual([5]);

    parseCost('s1', '$9.99');
    vi.advanceTimersByTime(5000);

    expect(seen).toEqual([5]);
    expect(getCost('s1')!.totalCostUsd).toBe(5);
  });
});
