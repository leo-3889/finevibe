/**
 * Row 26 slice 5 seam gate: the fs:* domain registration.
 *
 * The fs behaviours themselves are covered in ipc-handlers.test.ts (they run
 * the real `registerIpcHandlers`, which now calls `registerFsDomains`), so this
 * file pins only the two things the split can silently break:
 *
 *  1. the whole fs domain registers from ipc/fs-domains.ts — a handler dropped
 *     in the move would leave a channel preload calls unregistered, which fails
 *     silently at runtime (the exact class ipc-channel-parity.test.ts gates,
 *     one level finer: per-domain, not per-boundary);
 *  2. ipc-handlers.ts registers no fs channel and no fs domain module imports
 *     back into ipc-handlers.ts (the slice-1 seam contract — an import back
 *     would move the coupling, not the domain).
 */
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Set<string>());

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getFocusedWindow(): null { return null; }
  },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: {
    handle: (channel: string) => { handlers.add(channel); },
    on: (channel: string) => { handlers.add(channel); },
  },
  shell: { trashItem: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));
// The domain reaches the store only through loadState (preferences for the
// picker's defaultPath); everything else stays a stub so no ssh2/pty/watcher
// module loads.
vi.mock('../store', () => ({ loadState: () => ({ preferences: {} }) }));
vi.mock('../hosts/remote-fs', () => ({
  invalidateRemoteHome: vi.fn(),
  isRemotePathInKnownProject: vi.fn(), listRemoteDir: vi.fn(), readRemoteFile: vi.fn(),
  statRemotePath: vi.fn(), walkRemoteFiles: vi.fn(),
}));
vi.mock('../hosts/remote-watch', () => ({
  setRemoteWatchWindow: vi.fn(), unwatchRemoteDir: vi.fn(), watchRemoteDir: vi.fn(),
}));
vi.mock('../file-watcher', () => ({ watchDir: vi.fn(), unwatchDir: vi.fn(), setFileWatcherWindow: vi.fn() }));
vi.mock('../main-window', () => ({ getMainWindow: () => null }));
vi.mock('../finevibeignore', () => ({ buildFineVibeIgnoreMatcher: () => () => false }));

import { registerFsDomains } from './fs-domains';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEFS_CHANNELS = [
  'fs:browseDirectory', 'fs:cloneRepo', 'fs:ensureDirectory', 'fs:exists', 'fs:expandPath',
  'fs:isDirectory', 'fs:listDir', 'fs:listDirs', 'fs:listFiles', 'fs:readFile', 'fs:readImage',
  'fs:showInFolder', 'fs:stat', 'fs:topFilesByTokens', 'fs:trashItem', 'fs:unwatchDir', 'fs:watchDir',
];

describe('fs domain seam (row 26 slice 5)', () => {
  it('registers every fs:* channel from ipc/fs-domains.ts', () => {
    registerFsDomains();
    expect([...handlers].sort()).toEqual([...THEFS_CHANNELS].sort());
  });

  it('ipc-handlers.ts registers no fs channel (the whole domain moved)', () => {
    const text = readFileSync(path.join(MAIN, 'ipc-handlers.ts'), 'utf8');
    expect([...text.matchAll(/ipcMain\.(?:handle|on)\(\s*'(fs:[^']+)'/g)].map((m) => m[1])).toEqual([]);
  });

  it('no ipc/ domain module imports back into ipc-handlers.ts', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const importers = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /from\s+['"]\.\.\/ipc-handlers['"]/.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(importers).toEqual([]);
  });
});
