// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitFileEntry } from '../../shared/types';

// git-panel pulls in a lot of unrelated modules at import time; stub them so the
// only behavior under test is loadFiles().
vi.mock('../state.js', () => ({ appState: { on: vi.fn(), activeProjectId: null } }));
vi.mock('../git-status.js', () => ({
  onChange: vi.fn(),
  getGitStatus: vi.fn(),
  getActiveGitPath: vi.fn(),
  getWorktrees: vi.fn(),
  setActiveWorktree: vi.fn(),
  onWorktreeChange: vi.fn(),
}));
vi.mock('../session-activity.js', () => ({ onChange: vi.fn() }));
vi.mock('./file-viewer.js', () => ({ showFileViewer: vi.fn() }));
vi.mock('../dom-utils.js', () => ({ areaLabel: (area: string) => area }));

import { _test, _resetForTesting } from './git-panel.js';

const { loadFiles } = _test;

const FILES_A: GitFileEntry[] = [{ path: 'a.ts', status: 'modified', area: 'working' }];
const FILES_B: GitFileEntry[] = [{ path: 'b.ts', status: 'added', area: 'staged' }];

/** A promise whose resolution is controlled by the test, so we can inspect the
 *  DOM in the window between loadFiles being called and getFiles resolving. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const getFiles = vi.fn();

function makeBody(): HTMLElement {
  const body = document.createElement('div');
  document.body.appendChild(body);
  return body;
}

/** Drive a full load to completion and return the body with rendered rows. */
async function primeWithFiles(body: HTMLElement, gitPath: string, files: GitFileEntry[]) {
  const d = deferred<GitFileEntry[]>();
  getFiles.mockReturnValueOnce(d.promise);
  const p = loadFiles(body, gitPath);
  d.resolve(files);
  await p;
}

function hasLoader(body: HTMLElement): boolean {
  return body.querySelector('.git-loading') !== null;
}

beforeEach(() => {
  _resetForTesting();
  getFiles.mockReset();
  document.body.innerHTML = '';
  (window as unknown as { vibeyard: unknown }).vibeyard = { git: { getFiles } };
});

describe('git-panel loadFiles — cold-load vs refresh', () => {
  it('shows the loader on the first (cold) load, then renders files', async () => {
    const body = makeBody();
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);

    const p = loadFiles(body, '/repo');

    // While the git call is in flight, the spinner is visible.
    expect(hasLoader(body)).toBe(true);

    d.resolve(FILES_A);
    await p;

    // Once data arrives the loader is replaced by the file rows.
    expect(hasLoader(body)).toBe(false);
    expect(body.textContent).toContain('a.ts');
  });

  it('stays silent on a background refresh of the same path', async () => {
    const body = makeBody();
    await primeWithFiles(body, '/repo', FILES_A);

    // Refresh the same path with changed files.
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    const p = loadFiles(body, '/repo');

    // No spinner flash — the existing rows remain on screen while loading.
    expect(hasLoader(body)).toBe(false);
    expect(body.textContent).toContain('a.ts');

    d.resolve(FILES_B);
    await p;

    expect(hasLoader(body)).toBe(false);
    expect(body.textContent).toContain('b.ts');
    expect(body.textContent).not.toContain('a.ts');
  });

  it('shows the loader and clears stale rows when the path switches', async () => {
    const body = makeBody();
    await primeWithFiles(body, '/repoA', FILES_A);

    // Switch to a different worktree/project path: body still holds repoA's rows.
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    const p = loadFiles(body, '/repoB');

    // Loader appears and the previous path's rows are gone (no cross-project bleed).
    expect(hasLoader(body)).toBe(true);
    expect(body.textContent).not.toContain('a.ts');

    d.resolve(FILES_B);
    await p;

    expect(hasLoader(body)).toBe(false);
    expect(body.textContent).toContain('b.ts');
  });

  it('skips the DOM rebuild when a same-path refresh returns identical files', async () => {
    const body = makeBody();
    await primeWithFiles(body, '/repo', FILES_A);
    const renderedNode = body.firstElementChild;
    const renderedHtml = body.innerHTML;

    // Same path, identical file list (fresh objects, same serialization).
    await primeWithFiles(body, '/repo', FILES_A.map((f) => ({ ...f })));

    // Dedup short-circuits: the rendered nodes are untouched (no churn, no loader).
    expect(hasLoader(body)).toBe(false);
    expect(body.firstElementChild).toBe(renderedNode);
    expect(body.innerHTML).toBe(renderedHtml);
  });

  it('treats the next load as cold after a failed fetch (loader returns)', async () => {
    const body = makeBody();
    await primeWithFiles(body, '/repo', FILES_A);

    // A failed refresh clears the panel and forgets the displayed path.
    const failed = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(failed.promise);
    const pFail = loadFiles(body, '/repo');
    failed.reject(new Error('git failed'));
    await pFail;
    expect(body.textContent).toBe('');

    // The subsequent same-path load is therefore cold again — loader shows.
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    const p = loadFiles(body, '/repo');
    expect(hasLoader(body)).toBe(true);
    d.resolve(FILES_A);
    await p;
    expect(body.textContent).toContain('a.ts');
  });
});
