import { describe, expect, it, vi } from 'vitest';
import { boundedSet, evictOldest } from './bounded-map.js';

describe('bounded-map (row 29)', () => {
  it('boundedSet keeps the cap inclusive and the head is the eviction candidate', () => {
    const m = new Map<string, number>();
    for (const [k, v] of [['a', 1], ['b', 2], ['c', 3]] as const) boundedSet(m, k, v, 2);
    expect([...m.keys()]).toEqual(['b', 'c']);
    expect(m.size).toBe(2);
  });

  it('boundedSet touches an existing key to the tail (LRU write)', () => {
    const m = new Map<string, number>();
    boundedSet(m, 'a', 1, 2);
    boundedSet(m, 'b', 2, 2);
    boundedSet(m, 'a', 11, 2);       // refresh 'a'
    boundedSet(m, 'c', 3, 2);        // evicts 'b', not 'a'
    expect([...m.entries()]).toEqual([['a', 11], ['c', 3]]);
  });

  it('onEvict sees the entry WHILE it is still in the map, then the delete follows', () => {
    // Contract flipped by review e43c639d 🔴1: the repo's stateful callbacks
    // (file-watcher unwatchDir, remote-watch dropWatch) look the entry up to
    // release its external resource; a post-delete callback no-ops and leaks
    // the interval/watch. A self-deleting callback makes the following delete
    // a no-op, so the map is never half-evicted.
    const m = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]] as const);
    const seen: Array<[string, number | undefined]> = [];
    evictOldest(m, 1, (k) => seen.push([k, m.get(k)]));
    expect(seen).toEqual([['a', 1], ['b', 2]]);
    expect([...m.keys()]).toEqual(['c']);
  });

  it('a callback that deletes the entry itself keeps the map consistent (no half-eviction)', () => {
    const m = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]] as const);
    evictOldest(m, 1, (k) => { m.delete(k); });
    expect([...m.keys()]).toEqual(['c']);
  });

  it('max 0 empties the map, on a Set too, and an empty map is a no-op', () => {
    const s = new Set(['x', 'y']);
    const evicted: string[] = [];
    evictOldest(s, 0, (k) => evicted.push(k));
    expect(evicted).toEqual(['x', 'y']);
    expect(s.size).toBe(0);
    const before = vi.fn();
    evictOldest(new Map<string, number>(), 0, before);
    expect(before).not.toHaveBeenCalled();
  });

  it('boundedSet reports the evicted key (file-watcher unwatch path)', () => {
    const m = new Map<string, number>();
    const onEvict = vi.fn();
    boundedSet(m, 'a', 1, 1);
    boundedSet(m, 'b', 2, 1, onEvict);
    expect(onEvict).toHaveBeenCalledWith('a');
    expect([...m.keys()]).toEqual(['b']);
  });
});
