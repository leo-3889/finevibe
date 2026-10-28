// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitFileEntry } from '../../shared/types';

// git-panel pulls in a lot of unrelated modules at import time; stub them so the
// only behavior under test is the mount/refresh load flow.
vi.mock('../state.js', () => ({ appState: { on: vi.fn(), activeProjectId: null, activeProject: null } }));
vi.mock('../git-status.js', () => ({
  onChange: vi.fn(),
  gitChangeCount: vi.fn(),
  gitStatusErrored: vi.fn(),
  getActiveGitPath: vi.fn(),
  getWorktrees: vi.fn(),
  setActiveWorktree: vi.fn(),
  onWorktreeChange: vi.fn(),
}));
vi.mock('../session-activity.js', () => ({ onChange: vi.fn() }));
vi.mock('./file-viewer.js', () => ({ showFileViewer: vi.fn() }));
vi.mock('../dom-utils.js', async (importOriginal) => ({
  // Real esc (quote-safe, P2-102); areaLabel stays the identity stub the
  // header assertions are written against.
  ...(await importOriginal<typeof import('../dom-utils.js')>()),
  areaLabel: (area: string) => area,
}));

import { _resetForTesting, initGitPanel, mountGitPanel, closeGitPanel } from './git-panel.js';
import { appState } from '../state.js';
import {
  onChange as onGitStatusChange,
  gitChangeCount,
  gitStatusErrored,
  getActiveGitPath,
  getWorktrees,
} from '../git-status.js';

const FILES_A: GitFileEntry[] = [{ path: 'a.ts', status: 'modified', area: 'working' }];
const FILES_B: GitFileEntry[] = [{ path: 'b.ts', status: 'added', area: 'staged' }];

const project = { id: 'p1' } as never;

/** A promise whose resolution is controlled by the test, so we can inspect the
 *  DOM in the window between the load starting and getFiles resolving. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const getFiles = vi.fn();

function setActiveProject(id: string): void {
  (appState as { activeProject: unknown }).activeProject = { id };
  (appState as { activeProjectId: string | null }).activeProjectId = id;
}

function makeContainer(): HTMLElement {
  const c = document.createElement('div');
  document.body.appendChild(c);
  return c;
}

function hasLoader(root: ParentNode): boolean {
  return root.querySelector('.git-loading') !== null;
}

/** Mount the panel — the public load trigger — and capture the deferred
 *  getFiles call the mount kicks off, so the test controls the in-flight load. */
function mountLoading(container = makeContainer()) {
  const d = deferred<GitFileEntry[]>();
  getFiles.mockReturnValueOnce(d.promise);
  mountGitPanel(project, container);
  return { container, ...d };
}

/** Mount the panel and drive the cold load to completion with `files`. */
async function prime(files: GitFileEntry[]): Promise<HTMLElement> {
  const { container, resolve, promise } = mountLoading();
  resolve(files);
  await promise;
  return container;
}

/** Fire the git-status subscription initGitPanel registered. */
function fireGitStatusChange(counts: { staged: number; modified: number; untracked: number; conflicted: number }): void {
  const handler = vi.mocked(onGitStatusChange).mock.calls.at(-1)![0];
  handler('p1', counts as never);
}

beforeEach(() => {
  _resetForTesting();
  getFiles.mockReset();
  vi.mocked(onGitStatusChange).mockReset();
  document.body.innerHTML = '';
  (window as unknown as { finevibe: unknown }).finevibe = { git: { getFiles } };
  setActiveProject('p1');
  vi.mocked(gitChangeCount).mockReturnValue(2);
  vi.mocked(gitStatusErrored).mockReturnValue(false);
  vi.mocked(getActiveGitPath).mockReturnValue('/repo');
  vi.mocked(getWorktrees).mockReturnValue(null);
});

describe('git-panel mount/refresh loads — cold-load vs refresh', () => {
  it('shows the loader on the first (cold) mount, then renders files', async () => {
    const { container, resolve, promise } = mountLoading();

    // While the git call is in flight, the spinner is visible.
    expect(hasLoader(container)).toBe(true);

    resolve(FILES_A);
    await promise;

    // Once data arrives the loader is replaced by the file rows.
    expect(hasLoader(container)).toBe(false);
    expect(container.textContent).toContain('a.ts');
  });

  it('stays silent on a background refresh of the same path', async () => {
    initGitPanel();
    const container = await prime(FILES_A);

    // Refresh the same path with changed files.
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    fireGitStatusChange({ staged: 1, modified: 1, untracked: 0, conflicted: 0 });

    // No spinner flash — the existing rows remain on screen while loading.
    expect(hasLoader(container)).toBe(false);
    expect(container.textContent).toContain('a.ts');

    d.resolve(FILES_B);
    await d.promise;

    expect(hasLoader(container)).toBe(false);
    expect(container.textContent).toContain('b.ts');
    expect(container.textContent).not.toContain('a.ts');
  });

  it('shows the loader and clears stale rows when the panel switches project path', async () => {
    const container = await prime(FILES_A);

    // Switch to a different project: the body still holds repoA's rows.
    const other = { id: 'p2' } as never;
    setActiveProject('p2');
    vi.mocked(getActiveGitPath).mockReturnValue('/repoB');
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    mountGitPanel(other, container);

    // Loader appears and the previous path's rows are gone (no cross-project bleed).
    expect(hasLoader(container)).toBe(true);
    expect(container.textContent).not.toContain('a.ts');

    d.resolve(FILES_B);
    await d.promise;

    expect(hasLoader(container)).toBe(false);
    expect(container.textContent).toContain('b.ts');
  });

  it('skips the DOM rebuild when a same-path refresh returns identical files', async () => {
    initGitPanel();
    const container = await prime(FILES_A);
    const renderedNode = container.firstElementChild;
    const renderedHtml = container.innerHTML;

    // Same path, identical file list (fresh objects, same serialization).
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    fireGitStatusChange({ staged: 1, modified: 1, untracked: 0, conflicted: 0 });
    d.resolve(FILES_A.map((f) => ({ ...f })));
    await d.promise;

    // Dedup short-circuits: the rendered nodes are untouched (no churn, no loader).
    expect(hasLoader(container)).toBe(false);
    expect(container.firstElementChild).toBe(renderedNode);
    expect(container.innerHTML).toBe(renderedHtml);
  });

  it('treats the next load as cold after a failed fetch (loader returns)', async () => {
    initGitPanel();
    const container = await prime(FILES_A);

    // A failed refresh clears the panel and forgets the displayed path.
    const failed = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(failed.promise);
    fireGitStatusChange({ staged: 1, modified: 1, untracked: 0, conflicted: 0 });
    failed.reject(new Error('git failed'));
    await failed.promise.catch(() => undefined);
    expect(container.querySelector('.git-panel-body')!.textContent).toBe('');

    // The subsequent same-path refresh is therefore cold again — loader shows.
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    fireGitStatusChange({ staged: 0, modified: 2, untracked: 0, conflicted: 0 });
    expect(hasLoader(container)).toBe(true);
    d.resolve(FILES_A);
    await d.promise;
    expect(container.textContent).toContain('a.ts');
  });
});

describe('git-panel load generation — stale response guard', () => {
  it('drops a slow previous-project response that resolves after the new project loaded', async () => {
    const container = makeContainer();
    const slowA = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(slowA.promise);
    mountGitPanel(project, container);

    // Switch to project B while repoA's getFiles is still in flight.
    setActiveProject('p2');
    vi.mocked(getActiveGitPath).mockReturnValue('/repoB');
    const fastB = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(fastB.promise);
    mountGitPanel({ id: 'p2' } as never, container);

    // B resolves first, then the slow A response lands.
    fastB.resolve(FILES_B);
    await fastB.promise;
    slowA.resolve(FILES_A);
    await slowA.promise;

    // Pre-fix, the stale A payload repainted B's rows (lastFilesKey bleed).
    expect(container.textContent).toContain('b.ts');
    expect(container.textContent).not.toContain('a.ts');
  });

  it('drops an in-flight load when the switched-to project has no changes', async () => {
    const container = makeContainer();
    const inflight = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(inflight.promise);
    mountGitPanel(project, container);

    setActiveProject('p2');
    vi.mocked(gitChangeCount).mockReturnValue(0);
    mountGitPanel({ id: 'p2' } as never, container);
    expect(container.textContent).toContain('No uncommitted changes');

    inflight.resolve(FILES_A);
    await inflight.promise;

    expect(container.textContent).not.toContain('a.ts');
    expect(container.textContent).toContain('No uncommitted changes');
  });

  it('drops an in-flight load after the panel is closed', async () => {
    const container = makeContainer();
    const inflight = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(inflight.promise);
    mountGitPanel(project, container);
    const mount = container.querySelector('.git-panel-mount')!;

    closeGitPanel();
    inflight.resolve(FILES_A);
    await inflight.promise;

    // The detached node keeps its loader; the abandoned response never painted.
    expect(hasLoader(mount)).toBe(true);
    expect(mount.textContent).not.toContain('a.ts');
  });
});

describe('git-panel mountGitPanel — reload gating', () => {
  // Detached on purpose: the sidebar mounts the panel during buildProjectRow,
  // before the row is appended to the document — so refreshMounted must render
  // without depending on DOM connectivity.
  function makeDetachedContainer(): HTMLElement {
    return document.createElement('div');
  }

  beforeEach(() => {
    getFiles.mockResolvedValue(FILES_A);
  });

  it('loads files on first mount but not on a same-project re-mount', () => {
    const c1 = makeDetachedContainer();
    mountGitPanel(project, c1);
    expect(getFiles).toHaveBeenCalledTimes(1);

    // A plain sidebar re-render reparents the panel into a fresh container —
    // this must NOT trigger another getFiles IPC.
    const c2 = makeDetachedContainer();
    mountGitPanel(project, c2);
    expect(getFiles).toHaveBeenCalledTimes(1);
    // The persistent node was moved, not duplicated.
    expect(c1.querySelector('.git-panel-mount')).toBeNull();
    expect(c2.querySelector('.git-panel-mount')).not.toBeNull();
  });

  it('reloads when the active project switches', () => {
    mountGitPanel(project, makeDetachedContainer());
    expect(getFiles).toHaveBeenCalledTimes(1);

    const other = { id: 'p2' } as never;
    setActiveProject('p2');
    vi.mocked(getActiveGitPath).mockReturnValue('/repoB');
    mountGitPanel(other, makeDetachedContainer());
    expect(getFiles).toHaveBeenCalledTimes(2);
  });

  it('reloads on the next open after close', () => {
    mountGitPanel(project, makeDetachedContainer());
    expect(getFiles).toHaveBeenCalledTimes(1);

    closeGitPanel();
    mountGitPanel(project, makeDetachedContainer());
    expect(getFiles).toHaveBeenCalledTimes(2);
  });
});

describe('git-panel file rows — path rendering (P2-102)', () => {
  it('renders a filename containing a double quote as a literal, not an attribute injection', async () => {
    const path = 'x" onmouseover="alert(1).ts';
    const container = await prime([{ path, status: 'modified', area: 'working' }]);
    const detail = container.querySelector('.config-item-detail')!;
    // Pre-fix, the raw `"` closed the interpolated title attribute and the
    // payload became a live onmouseover attribute.
    expect(detail.getAttribute('title')).toBe(path);
    expect(detail.textContent).toBe(path);
    expect(detail.getAttribute('onmouseover')).toBeNull();
    expect(container.querySelector('[onmouseover]')).toBeNull();
  });

  it('renders the status badge as a literal letter span', async () => {
    const container = await prime(FILES_A);
    const badge = container.querySelector('.git-file-badge')!;
    expect(badge.textContent).toBe('M');
    expect(badge.className).toBe('git-file-badge modified');
  });

  // Phase 3.5 (gitOn, docs/hosts.md): a remote project renders REAL data -
  // the same worktree selector and file rows as a local project, because
  // every git read routes to the host's git over the exec lane. The retired
  // empty state ("Git runs on this machine") must never come back.
  it('remote project: renders real worktrees/files, no retired empty state', async () => {
    vi.mocked(getWorktrees).mockReturnValue([
      { path: '/wt/main', branch: 'main' },
      { path: '/wt/x', branch: 'x' },
    ] as never);
    const remoteProject = { id: 'p1', path: '/srv/app', hostId: 'host-1' } as never;
    (appState as { activeProject: unknown }).activeProject = remoteProject;
    const container = makeContainer();
    const d = deferred<GitFileEntry[]>();
    getFiles.mockReturnValueOnce(d.promise);
    mountGitPanel(remoteProject, container);
    expect(container.querySelector('.git-worktree-selector')).not.toBeNull();
    expect(container.querySelector('.config-empty')?.textContent ?? '').not.toContain('Git runs on this machine');
    expect(getFiles).toHaveBeenCalled();
    d.resolve([]);
    await d.promise;
  });
});
