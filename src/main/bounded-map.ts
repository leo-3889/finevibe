/**
 * Row 29 (code-cleanup audit 2026-10-28): one home for the bounded-map
 * eviction idiom.
 *
 * src/main grew ~14 hand-rolled copies of the same four lines
 * (`keys().next().value` → `delete`): `ipc-handlers.ts` ×3, `fs-utils.ts` ×2,
 * `codex-session-watcher.ts`, `launch-session-dir.ts`,
 * `pi-compatible-transcripts.ts`, `hook-status.ts`, `file-watcher.ts`. Each
 * copy re-decided the same questions (evict before or after insert, `>` vs
 * `>=`, touch-on-write), which is exactly how one of them ended up with
 * off-by-one capacity. `module-map-governance.test.ts` already requires every
 * module-level Map/Set to declare a bound (`capped:<CONST>`); this is the
 * eviction that bound refers to.
 *
 * Semantics, deliberately fixed here:
 *  - the Map's insertion order is the LRU order: the head is the eviction
 *    candidate, the tail is the most recent;
 *  - `boundedSet` TOUCHES on write (delete + set moves an existing key to the
 *    tail), matching the `fs-utils`/`file-watcher`/`pi-compatible-transcripts`
 *    idiom the comments already document;
 *  - the cap is inclusive: after `boundedSet`/`evictOldest` the map holds at
 *    most `max` entries;
 *  - `onEvict` runs AFTER the entry is removed, so a re-entrant
 *    delete/unwatch cannot observe a half-evicted map.
 *
 * Not for: byte/char budgets (`session-deep-search.ts` evicts on a character
 * budget, not an entry count) and non-LRU picks (e.g.
 * `codex-session-watcher`'s "the single pending session" head read) — those
 * keep their own code, which is a different contract, not a duplicate.
 */

/** Drop the oldest entries (Map head first) until the map fits `max`. */
export function evictOldest<K>(
  map: Map<K, unknown> | Set<K>,
  max: number,
  onEvict?: (key: K) => void,
): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
    onEvict?.(oldest);
  }
}

/** Insert `key`/`value` as the newest entry, evicting oldest past `max`. */
export function boundedSet<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
  onEvict?: (key: K) => void,
): void {
  map.delete(key);
  map.set(key, value);
  evictOldest(map, max, onEvict);
}
