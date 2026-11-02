/**
 * Row 26 slice 6 seam gate: the git:* domain registration.
 *
 * The git behaviours themselves (root gate, remote routing, watched-worktree
 * admission, path escapes) stay covered in ipc-handlers.test.ts — that suite
 * runs the real `registerIpcHandlers`, which now calls `registerGitDomains`.
 * This file pins only what the split can silently break, in the
 * `ipc/fs-domains.test.ts` idiom:
 *
 *  1. every git channel registers from ipc/git-domains.ts (a dropped handler
 *     leaves a channel preload calls unregistered — silent at runtime);
 *  2. ipc-handlers.ts registers no git channel, and no ipc/ domain module
 *     imports back into ipc-handlers.ts (the slice-1 seam contract);
 *  3. the ONE injected dep is the emitter: a mutating channel fires
 *     `notifyGitChanged`, a read channel does not (the PA-07 cache
 *     invalidation the renderer depends on rides that call);
 *  4. `requireGitRoot` is exported from here — the app/support lanes take it
 *     from ipc-handlers, which forwards this module's binding.
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const knownProject = vi.hoisted(() => ({ value: true }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn); },
    on: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn); },
  },
  shell: { openPath: vi.fn(() => Promise.resolve('')) },
}));
vi.mock('../git-on', () => ({
  gitOnStatus: vi.fn(), gitOnFiles: vi.fn(), gitOnDiff: vi.fn(), gitOnWorktrees: vi.fn(),
  gitOnRemoteUrl: vi.fn(), gitOnBranches: vi.fn(), gitOnStageFile: vi.fn(async () => {}),
  gitOnUnstageFile: vi.fn(async () => {}), gitOnDiscardFile: vi.fn(async () => {}),
  gitOnCheckoutBranch: vi.fn(async () => {}), gitOnCreateBranch: vi.fn(async () => {}),
}));
vi.mock('../git-watcher', () => ({ startGitWatcher: vi.fn() }));
vi.mock('../hosts/host-registry', () => ({ getHost: vi.fn(() => null) }));
vi.mock('../main-window', () => ({ getMainWindow: () => null }));
vi.mock('../project-gates', () => ({
  isWithinKnownProject: () => knownProject.value,
  remoteProjectOwnerOf: () => undefined,
}));

import { registerGitDomains, requireGitRoot } from './git-domains';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIT_CHANNELS = [
  'git:checkoutBranch', 'git:createBranch', 'git:discardFile', 'git:getDiff', 'git:getFiles',
  'git:getRemoteUrl', 'git:getStatus', 'git:getWorktrees', 'git:listBranches', 'git:openInEditor',
  'git:stageFile', 'git:unstageFile', 'git:watchProject',
];

describe('git domain seam (row 26 slice 6)', () => {
  const notifyGitChanged = vi.fn();

  it('registers every git:* channel from ipc/git-domains.ts', () => {
    registerGitDomains({ notifyGitChanged });
    expect([...handlers.keys()].sort()).toEqual([...GIT_CHANNELS].sort());
  });

  it('ipc-handlers.ts registers no git channel (the whole domain moved)', () => {
    const text = readFileSync(path.join(MAIN, 'ipc-handlers.ts'), 'utf8');
    expect([...text.matchAll(/ipcMain\.(?:handle|on)\(\s*'(git:[^']+)'/g)].map((m) => m[1])).toEqual([]);
  });

  it('no ipc/ domain module imports back into ipc-handlers.ts', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /from\s+['"]\.\.\/ipc-handlers['"]/.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(importers).toEqual([]);
  });

  it('the mutating channels fire the injected git:changed emitter, reads never do', async () => {
    notifyGitChanged.mockClear();
    const project = '/proj';
    await handlers.get('git:stageFile')!({}, project, 'a.ts');
    await handlers.get('git:unstageFile')!({}, project, 'a.ts');
    await handlers.get('git:discardFile')!({}, project, 'a.ts', 'working');
    await handlers.get('git:checkoutBranch')!({}, project, 'main');
    await handlers.get('git:createBranch')!({}, project, 'feat');
    expect(notifyGitChanged).toHaveBeenCalledTimes(5);

    notifyGitChanged.mockClear();
    handlers.get('git:getStatus')!({}, project);
    handlers.get('git:getFiles')!({}, project);
    handlers.get('git:listBranches')!({}, project);
    expect(notifyGitChanged).not.toHaveBeenCalled();
  });

  it('requireGitRoot refuses a path outside the known-project set', () => {
    knownProject.value = false;
    expect(() => requireGitRoot('git:getStatus', '/nowhere')).toThrow(/not within a known project/);
    knownProject.value = true;
    expect(requireGitRoot('git:getStatus', '/proj')).toBe(path.resolve('/proj'));
  });
});
