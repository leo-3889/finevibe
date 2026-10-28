// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state.js', () => ({
  appState: {
    activeProject: { id: 'p1', path: '/proj' },
    addDiffViewerSession: vi.fn(),
  },
}));
vi.mock('../session-close.js', () => ({ closeSessionIfFileMissing: vi.fn(async () => false) }));
vi.mock('./search-bar.js', () => ({ destroySearchBar: vi.fn() }));

import {
  createFileViewerPane,
  showFileViewerPane,
  getFileViewerInstance,
} from './file-viewer.js';

interface Deferred {
  promise: Promise<string>;
  resolve: (v: string) => void;
}

function defer(): Deferred {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((res) => { resolve = res; });
  return { promise, resolve };
}

interface FinevibeStub {
  git: { getDiff: (worktree: string, filePath: string, area: string) => Promise<string> };
  fs: {
    watchDir: (dir: string) => void;
    unwatchDir: (dir: string) => void;
    onFsChange: (cb: (changes: { path: string; dir: string; type: string }[]) => void) => () => void;
  };
}

const diffByFile = new Map<string, Deferred>();

beforeEach(() => {
  diffByFile.clear();
  document.body.innerHTML = '';
  const stub: FinevibeStub = {
    git: {
      getDiff: (_worktree: string, filePath: string) => {
        const d = defer();
        diffByFile.set(filePath, d);
        return d.promise;
      },
    },
    fs: {
      watchDir: vi.fn(),
      unwatchDir: vi.fn(),
      onFsChange: vi.fn(() => () => {}),
    },
  };
  (globalThis as unknown as { window: { finevibe: FinevibeStub } }).window.finevibe = stub;
});

function bodyText(sessionId: string): string {
  const inst = getFileViewerInstance(sessionId)!;
  return inst.element.querySelector('.file-viewer-body')?.textContent ?? '';
}

describe('file viewer concurrent loads', () => {
  it('two panes loading concurrently both render their own diff', async () => {
    createFileViewerPane('s1', 'a.ts', 'staged');
    createFileViewerPane('s2', 'b.ts', 'staged');
    showFileViewerPane('s1', false);
    showFileViewerPane('s2', false);
    // Both loads must be in flight before any resolves.
    expect(diffByFile.size).toBe(2);

    // Resolve s2's diff first, s1's second.
    diffByFile.get('b.ts')!.resolve('+added b\n context b');
    diffByFile.get('a.ts')!.resolve('+added a\n context a');
    await vi.waitFor(() => {
      expect(getFileViewerInstance('s1')!.loaded).toBe(true);
      expect(getFileViewerInstance('s2')!.loaded).toBe(true);
    });

    // Each pane renders its own diff — a shared generation counter made the
    // pane whose response arrived first render nothing and stay unloaded.
    expect(bodyText('s1')).toContain('added a');
    expect(bodyText('s1')).not.toContain('b');
    expect(bodyText('s2')).toContain('added b');
  });
});

describe('CRLF rendering (git diff viewer)', () => {
  // Under white-space:pre, splitting a CRLF diff on '\n' left a trailing
  // '\r' on every line — the pre-formatted CR renders as a second, visibly
  // empty row: every diff line shows double-height. renderDiff normalizes
  // CRLF/CR to LF before splitting.
  async function renderDiff(sessionId: string, file: string, diff: string): Promise<Element> {
    createFileViewerPane(sessionId, file, 'working');
    showFileViewerPane(sessionId, false);
    diffByFile.get(file)!.resolve(diff);
    await vi.waitFor(() => expect(getFileViewerInstance(sessionId)!.loaded).toBe(true));
    return getFileViewerInstance(sessionId)!.element.querySelector('.file-viewer-body')!;
  }

  const rowsIn = (body: Element) => [...body.querySelectorAll('.diff-line')];

  it('renders a CRLF diff with one row per source line (no double-height)', async () => {
    const body = await renderDiff('crlf', 'crlf.ts', '--- a/crlf.ts\r\n+++ b/crlf.ts\r\n@@ -1 +1 @@\r\n+a\r\n+b');
    const rows = rowsIn(body);
    // 3 headers + hunk + 2 added lines — one row per source line.
    expect(rows).toHaveLength(5);
    // '+a'/'+b' plus the '+++' header carry the added class.
    expect(rows.filter((r) => r.classList.contains('added'))).toHaveLength(3);
    // Double-height would mean an extra empty row per content line: none
    // (blank rows carry a non-breaking space, never an empty string).
    expect(rows.filter((r) => r.textContent === '')).toHaveLength(0);
    expect(body.textContent).not.toMatch(/\r/);
  });

  it('renders a CR-only diff with one row per source line', async () => {
    const body = await renderDiff('cr', 'cr.ts', '+a\rb\rc');
    const rows = rowsIn(body);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toBe('+a');
    expect(rows[1].textContent).toBe('b');
    expect(rows[2].textContent).toBe('c');
  });

  it('leaves a pure-LF diff unchanged', async () => {
    const body = await renderDiff('lf', 'lf.ts', '+a\nb\nc');
    expect(rowsIn(body)).toHaveLength(3);
  });
});
