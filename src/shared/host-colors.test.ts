import { describe, it, expect } from 'vitest';
import { HOST_PALETTE, isValidHostColor, pickHostColor } from './host-colors';

describe('host colors (per-host providers T1)', () => {
  it('palette entries all pass the style-attribute gate', () => {
    for (const color of HOST_PALETTE) expect(isValidHostColor(color)).toBe(true);
  });

  it('gate accepts only #rrggbb', () => {
    expect(isValidHostColor('#4c9aff')).toBe(true);
    expect(isValidHostColor('#4C9AFF')).toBe(true);
    for (const bad of ['#fff', 'red', 'url(x)', '#4c9affx', '', '#4c9agg', null, 42]) {
      expect(isValidHostColor(bad)).toBe(false);
    }
  });

  it('pickHostColor round-robins over untaken colors, then cycles', () => {
    expect(pickHostColor([])).toBe(HOST_PALETTE[0]);
    expect(pickHostColor([HOST_PALETTE[0], undefined])).toBe(HOST_PALETTE[1]);
    const all = [...HOST_PALETTE];
    // All taken: cycle by count (deleted hosts refill in order).
    expect(pickHostColor(all)).toBe(HOST_PALETTE[all.length % HOST_PALETTE.length]);
    expect(pickHostColor([all[0], 'bogus'])).toBe(HOST_PALETTE[1]); // invalid taken entries ignored
  });
});
