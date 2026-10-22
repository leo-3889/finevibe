// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// PA-30 pins the entryCache LRU. The cache helpers are pure module state,
// so every DOM-flavored import of file-tree.ts is stubbed to keep the
// module graph importable without the app's IPC surface.
vi.mock('../state.js', () => ({
  appState: { on: vi.fn(() => () => {}), preferences: {} },
}));
vi.mock('../open-file-reader.js', () => ({ openFileReaderChecked: vi.fn() }));
vi.mock('../file-url.js', () => ({ pathToFileURL: (p: string) => `file://${p}` }));
vi.mock('./board/board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('./modal.js', () => ({ showConfirmModal: vi.fn(), showPropertiesDialog: vi.fn() }));
vi.mock('../platform.js', () => ({ isMac: false, isWin: true, isLinux: false }));

import { _cacheForTesting, _resetForTesting, type DirEntry } from './file-tree.js';

function entry(name: string): DirEntry {
  return { name, path: `/p/${name}`, isDirectory: false };
}

describe('entryCache LRU cap (PA-30)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('caps the cache at the configured directory count, evicting the oldest', () => {
    const cap = _cacheForTesting.max;
    for (let i = 0; i < cap + 1; i++) _cacheForTesting.set(`/d${i}`, [entry(`f${i}`)]);
    expect(_cacheForTesting.size()).toBe(cap);
    expect(_cacheForTesting.keys()).not.toContain('/d0');
    expect(_cacheForTesting.get(`/d${cap}`)).toBeDefined();
  });

  it('touches on hit: a recently read directory survives the next eviction', () => {
    const cap = _cacheForTesting.max;
    for (let i = 0; i < cap; i++) _cacheForTesting.set(`/d${i}`, [entry(`f${i}`)]);
    // Hit on /d0 moves it to most-recent; the next overflow must evict /d1.
    expect(_cacheForTesting.get('/d0')).toBeDefined();
    _cacheForTesting.set('/fresh', [entry('x')]);
    expect(_cacheForTesting.size()).toBe(cap);
    expect(_cacheForTesting.get('/d0')).toBeDefined();
    expect(_cacheForTesting.keys()).not.toContain('/d1');
    expect(_cacheForTesting.keys()).toContain('/fresh');
  });

  it('re-inserting an existing directory updates in place without growing', () => {
    _cacheForTesting.set('/d', [entry('a')]);
    _cacheForTesting.set('/d', [entry('b')]);
    expect(_cacheForTesting.size()).toBe(1);
    expect(_cacheForTesting.get('/d')![0].name).toBe('b');
  });
});
