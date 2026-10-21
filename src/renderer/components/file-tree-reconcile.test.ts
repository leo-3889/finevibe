// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsChange } from '../../shared/types';

vi.mock('../state.js', () => ({
  appState: { addFileReaderSession: vi.fn(), addBrowserTabSession: vi.fn() },
}));
vi.mock('./modal.js', () => ({ showConfirmModal: vi.fn(), showPropertiesDialog: vi.fn() }));
vi.mock('./board/board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('../file-url.js', () => ({ pathToFileURL: (p: string) => `file://${p}` }));

import { renderFileTree, _resetForTesting, DirEntry, isExpanded, FILE_MANAGER } from './file-tree.js';
import { showContextMenu, MenuOption } from './board/board-context-menu.js';

// --- Fake filesystem backing window.finevibe.fs ---
let dirContents: Map<string, DirEntry[]>;
let fsChangeCb: ((changes: FsChange[]) => void) | null = null;
const watchedDirs = new Set<string>();

function entry(name: string, dir: string, isDirectory: boolean): DirEntry {
  return { name, path: `${dir}/${name}`, isDirectory };
}

beforeEach(() => {
  _resetForTesting();
  dirContents = new Map();
  fsChangeCb = null;
  watchedDirs.clear();
  (globalThis as any).window = globalThis;
  (globalThis as any).finevibe = {
    fs: {
      listDir: vi.fn((dir: string) => Promise.resolve(dirContents.get(dir) ?? [])),
      showInFolder: vi.fn(() => Promise.resolve({ ok: true })),
      watchDir: vi.fn((dir: string) => { watchedDirs.add(dir); }),
      unwatchDir: vi.fn((dir: string) => { watchedDirs.delete(dir); }),
      onFsChange: vi.fn((cb: (c: FsChange[]) => void) => { fsChangeCb = cb; return () => { fsChangeCb = null; }; }),
    },
  };
});

// Resolve microtasks (listDir promises) and drain queued rAF callbacks until the
// reconcile pipeline (async loadEntries + DOM patch) has fully settled.
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    const cbs: FrameRequestCallback[] = (globalThis as any).__rafQueue ?? [];
    (globalThis as any).__rafQueue = [];
    for (const cb of cbs) cb(0);
    await Promise.resolve();
  }
}

// jsdom provides rAF, but we want deterministic control — stub it into a queue.
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  ((globalThis as any).__rafQueue ??= []).push(cb);
  return 1;
};

// jsdom does not implement CSS.escape.
if (!(globalThis as any).CSS) (globalThis as any).CSS = { escape: (s: string) => s };

function rows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.file-tree-row'))
    .map((r) => (r as HTMLElement).dataset.entryPath!)
    .filter(Boolean);
}

function emit(changes: FsChange[]): void {
  fsChangeCb?.(changes);
}

/** Right-click a row and return the menu options handed to showContextMenu. */
function openMenu(container: HTMLElement, entryPath: string): MenuOption[] {
  vi.mocked(showContextMenu).mockClear();
  const row = container.querySelector(`[data-entry-path="${entryPath}"]`) as HTMLElement;
  row.dispatchEvent(new MouseEvent('contextmenu', { clientX: 5, clientY: 6 }));
  return vi.mocked(showContextMenu).mock.calls[0][2];
}

describe('file tree reconciliation', () => {
  it('adds a new file at the correct sorted position without rebuilding', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('c.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    expect(rows(container)).toEqual(['/proj/a.ts', '/proj/c.ts']);

    // Capture the existing 'a.ts' node — it must survive the reconcile (identity preserved).
    const aNode = container.querySelector('[data-entry-path="/proj/a.ts"]');

    dirContents.set('/proj', [
      entry('a.ts', '/proj', false),
      entry('b.ts', '/proj', false),
      entry('c.ts', '/proj', false),
    ]);
    emit([{ path: '/proj/b.ts', dir: '/proj', type: 'add' }]);
    await settle();

    expect(rows(container)).toEqual(['/proj/a.ts', '/proj/b.ts', '/proj/c.ts']);
    expect(container.querySelector('[data-entry-path="/proj/a.ts"]')).toBe(aNode);
  });

  it('inserts many new files at once in correct sorted order', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('z.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const next = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'z.ts'].map((n) => entry(n, '/proj', false));
    dirContents.set('/proj', next);
    emit(next.slice(1, 5).map((e) => ({ path: e.path, dir: '/proj', type: 'add' as const })));
    await settle();

    expect(rows(container)).toEqual([
      '/proj/a.ts', '/proj/b.ts', '/proj/c.ts', '/proj/d.ts', '/proj/e.ts', '/proj/z.ts',
    ]);
  });

  it('removes a deleted entry', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('b.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    emit([{ path: '/proj/b.ts', dir: '/proj', type: 'unlink' }]);
    await settle();

    expect(rows(container)).toEqual(['/proj/a.ts']);
  });

  it('preserves an expanded subtree when a sibling changes', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true), entry('z.ts', '/proj', false)]);
    dirContents.set('/proj/src', [entry('deep.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    // Expand /proj/src (the click handler toggles + renders).
    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    srcRow.dispatchEvent(new Event('click'));
    await settle();
    expect(isExpanded('p1', '/proj/src')).toBe(true);
    expect(rows(container)).toContain('/proj/src/deep.ts');

    // A new sibling file appears at the root.
    dirContents.set('/proj', [
      entry('src', '/proj', true),
      entry('y.ts', '/proj', false),
      entry('z.ts', '/proj', false),
    ]);
    emit([{ path: '/proj/y.ts', dir: '/proj', type: 'add' }]);
    await settle();

    // The expanded subtree's deep child is still present (subtree was not rebuilt).
    expect(rows(container)).toContain('/proj/src/deep.ts');
    expect(rows(container)).toContain('/proj/y.ts');
  });

  it('unwatches a removed directory subtree', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    dirContents.set('/proj/src', [entry('deep.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    srcRow.dispatchEvent(new Event('click'));
    await settle();
    expect(watchedDirs.has('/proj/src')).toBe(true);

    // Delete /proj/src
    dirContents.set('/proj', []);
    emit([{ path: '/proj/src', dir: '/proj', type: 'unlinkDir' }]);
    await settle();

    expect(rows(container)).toEqual([]);
    expect(watchedDirs.has('/proj/src')).toBe(false);
    expect(isExpanded('p1', '/proj/src')).toBe(false);
  });

  it('re-reads the root listing from disk when the panel re-renders', async () => {
    // Gap 1: the root cache survives the whole session, so a missed watcher
    // event at the project root was never manually recoverable.
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    expect(rows(container)).toEqual(['/proj/a.ts']);

    // Filesystem change with NO watcher event, then a panel re-render
    // (reopen / project switch / preferences-changed).
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('b.ts', '/proj', false)]);
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    expect(rows(container)).toEqual(['/proj/a.ts', '/proj/b.ts']);
  });

  it('re-reads a folder from disk on every expand', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    dirContents.set('/proj/src', [entry('a.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    const listDir = vi.mocked(window.finevibe.fs.listDir);
    const callsFor = (dir: string) => listDir.mock.calls.filter((c) => c[0] === dir).length;

    srcRow.dispatchEvent(new Event('click')); // expand
    await settle();
    expect(rows(container)).toContain('/proj/src/a.ts');

    srcRow.dispatchEvent(new Event('click')); // collapse
    await settle();

    // fs change while collapsed, with no watcher event.
    dirContents.set('/proj/src', [entry('a.ts', '/proj/src', false), entry('b.ts', '/proj/src', false)]);
    const before = callsFor('/proj/src');
    srcRow.dispatchEvent(new Event('click')); // re-expand
    await settle();
    expect(callsFor('/proj/src')).toBe(before + 1);
    expect(rows(container)).toContain('/proj/src/b.ts');
  });

  it('expand re-reads even while a stale listing read is in flight', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    dirContents.set('/proj/src', [entry('a.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    // The first expand's /proj/src read stays in flight; later reads hit disk.
    const listDir = vi.mocked(window.finevibe.fs.listDir);
    const baseImpl = listDir.getMockImplementation()!;
    const callsFor = (dir: string) => listDir.mock.calls.filter((c) => c[0] === dir).length;
    let resolveStale: (entries: DirEntry[]) => void = () => {};
    listDir.mockImplementationOnce((dir: string) =>
      dir === '/proj/src'
        ? new Promise<DirEntry[]>((res) => { resolveStale = res; })
        : baseImpl(dir),
    );

    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    srcRow.dispatchEvent(new Event('click')); // expand #1 — read in flight
    await settle();

    dirContents.set('/proj/src', [entry('a.ts', '/proj/src', false), entry('b.ts', '/proj/src', false)]);
    srcRow.dispatchEvent(new Event('click')); // collapse
    srcRow.dispatchEvent(new Event('click')); // expand #2 — must start a fresh read
    await settle();
    expect(callsFor('/proj/src')).toBe(2);
    expect(rows(container)).toContain('/proj/src/b.ts');

    // The stale in-flight read lands late; it must not repopulate the cache
    // (guarded in loadEntries), so it is silently dropped.
    resolveStale([entry('a.ts', '/proj/src', false)]);
    await settle();
  });
});

describe('show in file manager menu option', () => {
  it('opens a folder in the file manager', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/src');
    expect(options.map((o) => o.label)).toEqual([`Open in ${FILE_MANAGER}`, 'Copy Path', 'Delete']);

    options[0].action();
    expect((globalThis as any).finevibe.fs.showInFolder).toHaveBeenCalledWith('/proj/src');
  });

  it('reveals a file in the file manager', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/a.ts');
    expect(options.map((o) => o.label)).toEqual([
      'Open in Browser', `Reveal in ${FILE_MANAGER}`, 'Copy Path', 'Properties', 'Delete',
    ]);

    options[1].action();
    expect((globalThis as any).finevibe.fs.showInFolder).toHaveBeenCalledWith('/proj/a.ts');
  });

  it('copies the absolute path of a folder to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/src');
    options.find((o) => o.label === 'Copy Path')!.action();
    expect(writeText).toHaveBeenCalledWith('/proj/src');
    vi.unstubAllGlobals();
  });
});
