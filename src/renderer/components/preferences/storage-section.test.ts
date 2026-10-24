// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A5 storage report — three layers in one file:
 *  1. the bounded userData scan + the iso-partition removal + the cache
 *     clear from src/main/ipc-handlers.ts, exercised through the registered
 *     IPC handlers on mkdtemp fixtures (path-allowlist assertions included);
 *  2. the Preferences → Storage section rendered against a mocked bridge;
 *  3. en/zh key parity for every key the section adds.
 */

// ---- main-side prologue (mirrors ipc-handlers.test.ts, the house pattern) --
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const appPaths = vi.hoisted(() => ({ userData: '/mock/userData' }));
const mockClearCache = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockClearStorageData = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockFromPartitionClear = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockSweepImportTempDirs = vi.hoisted(() => vi.fn(() => 0));

const autoStub = vi.hoisted(() => () =>
  new Proxy({ __esModule: true } as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (key === '__esModule') return true;
      if (key === 'then' || key === 'catch' || key === 'finally') return undefined;
      if (typeof key === 'symbol') return target[key];
      if (!(key in target)) target[key] = vi.fn();
      return target[key];
    },
  })
);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: vi.fn() } }],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  app: {
    getPath: (name: string) => (name === 'userData' ? appPaths.userData : '/mock/app'),
    getName: () => 'finevibe',
    getVersion: () => 'test',
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })) },
  shell: {
    openExternal: () => Promise.resolve(),
    trashItem: vi.fn(() => Promise.resolve()),
    showItemInFolder: vi.fn(),
    openPath: vi.fn(() => Promise.resolve('')),
  },
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => ''),
    readBuffer: vi.fn(() => { throw new Error('format not on clipboard'); }),
    read: vi.fn(() => ''),
    readHTML: vi.fn(() => ''),
    readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
    availableFormats: vi.fn(() => [] as string[]),
  },
  utilityProcess: { fork: vi.fn(() => null as never) },
  session: {
    defaultSession: {
      clearCache: mockClearCache,
      clearStorageData: mockClearStorageData,
      cookies: { remove: vi.fn(() => Promise.resolve()) },
    },
    fromPartition: () => ({ clearStorageData: mockFromPartitionClear }),
  },
}));

vi.mock('../../../main/pty-manager', autoStub);
vi.mock('../../../main/session-transcript-sync', () => ({
  registerTranscriptSync: vi.fn(),
  unregisterTranscriptSync: vi.fn(),
  getSyncedTranscriptPath: vi.fn(() => null),
}));
vi.mock('../../../main/providers/registry', autoStub);
vi.mock('../../../main/store', () => ({
  loadState: vi.fn(() => ({})),
  saveState: vi.fn(),
  saveStateSync: vi.fn(),
  getKnownProjectPaths: vi.fn(() => []),
  invalidateStateCache: vi.fn(),
}));
vi.mock('../../../main/hook-status', autoStub);
vi.mock('../../../main/claude-cli', autoStub);
vi.mock('../../../main/providers/resume-handoff', autoStub);
vi.mock('../../../main/session-deep-search', autoStub);
vi.mock('../../../main/git-status', autoStub);
vi.mock('../../../main/git-watcher', autoStub);
vi.mock('../../../main/file-watcher', autoStub);
vi.mock('../../../main/mcp-ipc-handlers', autoStub);
vi.mock('../../../main/auto-updater', autoStub);
vi.mock('../../../main/menu', autoStub);
vi.mock('../../../main/readiness/analyzer', autoStub);
vi.mock('../../../main/github-cli', autoStub);
vi.mock('../../../main/legacy-import', autoStub);
vi.mock('../../../main/agentmemory-manager', autoStub);
vi.mock('../../../main/session-export', autoStub);
vi.mock('../../../main/fs-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../main/fs-utils')>(),
  expandUserPath: (p: string) => p,
  isBinaryBuffer: () => false,
  isMacPackagePath: () => false,
}));
vi.mock('../../../main/platform', async () => ({
  ...(autoStub() as object),
  isWin: false,
  isMac: false,
  isLinux: true,
}));
vi.mock('../../../main/chrome-import/importer', autoStub);
vi.mock('../../../main/chrome-import/copy', () => ({ sweepImportTempDirs: mockSweepImportTempDirs }));
vi.mock('../../../main/settings-guard', autoStub);
vi.mock('../../../main/finevibeignore', autoStub);
vi.mock('../../../main/close-state', autoStub);
vi.mock('../../../main/profiles', autoStub);
vi.mock('../../../main/claude-keychain', autoStub);
vi.mock('../../../main/launch-session-dir', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../main/launch-session-dir')>(),
}));

import {
  registerIpcHandlers,
  scanUserDataUsage,
  removeIsoPartitionDirs,
  clearSafeCaches,
} from '../../../main/ipc-handlers';

let tmp: string;

function file(rel: string, bytes: number): void {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-storage-'));
  appPaths.userData = tmp;
  vi.clearAllMocks();
  mockClearCache.mockResolvedValue(undefined);
  mockClearStorageData.mockResolvedValue(undefined);
  mockFromPartitionClear.mockResolvedValue(undefined);
  mockSweepImportTempDirs.mockReturnValue(0);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 1. storage:scan — bounded walk, descending, truncated on caps --------
describe('storage:scan (bounded userData scan)', () => {
  it('sizes each subtree through the shared dirSizeBytes idiom, sorted desc', () => {
    file('pi-sessions/a.json', 1000);
    file('pi-sessions/nested/deep/b.json', 500);
    file('omp-sessions/c.json', 250);
    file('pi-bolt-sessions/d.json', 75);
    file('Partitions/finevibe-browser-iso-s1/cookies', 1234);
    file('Cache/data_1', 99);
    file('legacy-retirement.json', 42);
    registerIpcHandlers();
    const scan = (handlers.get('storage:scan') as () => {
      entries: Array<{ name: string; bytes: number }>;
      truncated: boolean;
    })();
    expect(scan.truncated).toBe(false);
    const byName = Object.fromEntries(scan.entries.map((e) => [e.name, e.bytes]));
    expect(byName['pi-sessions']).toBe(1500);
    expect(byName['omp-sessions']).toBe(250);
    expect(byName['pi-bolt-sessions']).toBe(75);
    expect(byName['Partitions']).toBe(1234);
    expect(byName['Cache']).toBe(99);
    // misc = userData top level minus the five named subtrees.
    expect(byName['misc']).toBe(42);
    const bytes = scan.entries.map((e) => e.bytes);
    expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
  });

  it('marks truncated once a directory exceeds the child cap, sizes the kept slice', () => {
    // STORAGE_SCAN_MAX_CHILDREN = 1000 in ipc-handlers.ts: 1001 one-byte
    // files in Cache cross it; the scan must bound, not hang, and say so.
    const dir = path.join(tmp, 'Cache');
    fs.mkdirSync(dir);
    for (let i = 0; i < 1001; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
    const scan = scanUserDataUsage(tmp);
    expect(scan.truncated).toBe(true);
    const cache = scan.entries.find((e) => e.name === 'Cache')!;
    expect(cache.bytes).toBe(1000); // 1000 kept entries × 1 byte
  });

  it('a missing userData dir is an all-zero report, never a throw', () => {
    const scan = scanUserDataUsage(path.join(tmp, 'nope'));
    expect(scan.truncated).toBe(false);
    expect(scan.entries.every((e) => e.bytes === 0)).toBe(true);
  });
});

// ---- 2. storage:clear — caches ONLY; session dirs are untouchable ---------
describe('storage:clear (path allowlist)', () => {
  it('clears Chromium caches + import temps and NEVER touches session data', async () => {
    file('pi-sessions/a.json', 10);
    file('omp-sessions/b.json', 10);
    file('pi-bolt-sessions/c.json', 10);
    file('Partitions/finevibe-browser-iso-s1/cookies', 10);
    file('Cache/data_1', 10);
    registerIpcHandlers();
    const clear = handlers.get('storage:clear') as () => Promise<{ tempDirsSwept: number }>;
    const result = await clear();
    expect(result).toEqual({ tempDirsSwept: 0 });
    expect(mockClearCache).toHaveBeenCalledTimes(1);
    expect(mockClearStorageData).toHaveBeenCalledTimes(1);
    // Scoped storages only: the unscoped clearStorageData() would wipe the
    // default session's cookies/Local Storage (the imported Chrome jar).
    const arg = mockClearStorageData.mock.calls[0]![0] as { storages: string[] };
    expect(arg.storages).toEqual(expect.arrayContaining(['appcache', 'shadercache', 'serviceworkers', 'cachestorage']));
    for (const forbidden of ['cookies', 'localstorage', 'indexeddb', 'filesystem']) {
      expect(arg.storages).not.toContain(forbidden);
    }
    // The tmp sweep runs with the immediate bound.
    expect(mockSweepImportTempDirs).toHaveBeenCalledWith({ maxAgeMs: 0 });
    // ALLOWLIST ASSERTION: every session-bearing subtree survives, byte-intact.
    for (const keep of ['pi-sessions/a.json', 'omp-sessions/b.json', 'pi-bolt-sessions/c.json', 'Partitions/finevibe-browser-iso-s1/cookies', 'Cache/data_1']) {
      expect(fs.existsSync(path.join(tmp, keep))).toBe(true);
    }
  });

  it('clearSafeCaches survives a rejecting clearCache (renderer gets a rejection, main lives)', async () => {
    mockClearCache.mockRejectedValue(new Error('locked'));
    await expect(clearSafeCaches()).rejects.toThrow('locked');
    expect(mockSweepImportTempDirs).not.toHaveBeenCalled();
  });
});

// ---- 3. iso-partition lifecycle (A5 leak fix) ------------------------------
describe('iso partition removal', () => {
  it('session:release deletes the session iso dir once clearStorageData resolved', async () => {
    file('Partitions/finevibe-browser-iso-sess1/cookies', 5);
    file('Partitions/finevibe-browser-profile-shared/cookies', 5);
    registerIpcHandlers();
    const release = handlers.get('session:release') as (e: unknown, sessionId: string) => void;
    release({}, 'sess1');
    expect(mockFromPartitionClear).toHaveBeenCalledTimes(1);
    // The rm is chained AFTER the async clear resolves — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.existsSync(path.join(tmp, 'Partitions/finevibe-browser-iso-sess1'))).toBe(false);
    // The shared (non-iso) partition is never in scope.
    expect(fs.existsSync(path.join(tmp, 'Partitions/finevibe-browser-profile-shared'))).toBe(true);
  });

  it('releasing a non-browser session touches no partition at all', async () => {
    registerIpcHandlers();
    const release = handlers.get('session:release') as (e: unknown, sessionId: string) => void;
    release({}, 'sess2');
    await Promise.resolve();
    expect(mockFromPartitionClear).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'Partitions'))).toBe(false);
  });

  it('the boot sweep removes every re-validating iso dir and nothing else', () => {
    file('Partitions/finevibe-browser-iso-a/x', 1);
    file('Partitions/finevibe-browser-iso-b/x', 1);
    // An iso-prefixed dir whose suffix is NOT a valid session id (the
    // renderer's partition spelling can never produce it) is left alone.
    file('Partitions/finevibe-browser-iso-bad!name/x', 1);
    file('Partitions/finevibe-browser-profile-shared/x', 1);
    const removed = removeIsoPartitionDirs(tmp);
    expect(removed).toBe(2);
    const left = fs.readdirSync(path.join(tmp, 'Partitions')).sort();
    expect(left).toEqual(['finevibe-browser-iso-bad!name', 'finevibe-browser-profile-shared']);
  });
});

// ---- 4. the Preferences → Storage section ----------------------------------
describe('storage section UI', () => {
  const MB = 1024 * 1024;

  function bridge(scan = { entries: [{ name: 'pi-sessions', bytes: 3.5 * MB }, { name: 'Cache', bytes: 512 * 1024 }], truncated: false }) {
    const scanFn = vi.fn(() => Promise.resolve(scan));
    const clearFn = vi.fn(() => Promise.resolve({ tempDirsSwept: 2 }));
    const retirementFn = vi.fn(() => Promise.resolve([{ id: 'appData', from: 'C:/Users/x/AppData/Roaming/Vibeyard', at: '2026-10-01T00:00:00Z', outcome: 'removed' as const }]));
    (window as unknown as { finevibe: unknown }).finevibe = {
      storage: { scan: scanFn, clear: clearFn, retirement: retirementFn },
    };
    return { scanFn, clearFn, retirementFn };
  }

  async function mount() {
    const { createStorageSection } = await import('./storage-section.js');
    const { t } = await import('../../i18n.js');
    const ctx = { isActiveSection: () => true } as never;
    const container = document.createElement('div');
    createStorageSection(ctx).render(container);
    await vi.waitFor(() => expect(container.querySelectorAll('.storage-usage-row').length).toBeGreaterThan(0));
    return { t, container };
  }

  it('lists subtree sizes as human MB + the retirement status line', async () => {
    bridge();
    const { t, container } = await mount();
    const rows = [...container.querySelectorAll('.storage-usage-row')];
    expect(rows.map((r) => r.textContent)).toEqual([
      `${t('storage.subPi')}3.5 MB`,
      `${t('storage.subCache')}0.5 MB`,
    ]);
    expect(container.textContent).toContain(t('storage.retirementHeading'));
    expect(container.textContent).toContain('AppData/Roaming/Vibeyard');
    expect(container.textContent).toContain(t('storage.outcomeRemoved'));
  });

  it('shows the truncated note when the scan hit its caps', async () => {
    bridge({ entries: [{ name: 'Cache', bytes: 1 }], truncated: true });
    const { t, container } = await mount();
    expect(container.textContent).toContain(t('storage.truncated'));
  });

  it('clear needs a confirm; on accept it clears, reports and rescans', async () => {
    const { clearFn, scanFn } = bridge();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { t, container } = await mount();
    const btn = container.querySelector('button') as HTMLButtonElement;
    btn.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(clearFn).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    btn.click();
    await vi.waitFor(() => expect(clearFn).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain(t('storage.cleared'));
    // The clear rescans: 1 mount scan + 1 post-clear rescan.
    await vi.waitFor(() => expect(scanFn).toHaveBeenCalledTimes(2));
    confirmSpy.mockRestore();
  });

  it('empty retirement log reads as no pending legacy data', async () => {
    const b = bridge();
    b.retirementFn.mockResolvedValue([]);
    const { t, container } = await mount();
    expect(container.textContent).toContain(t('storage.retirementNone'));
  });
});

// ---- 5. locale parity for every key A5 adds --------------------------------
describe('locale parity (A5 keys)', () => {
  it('en.json and zh-CN.json carry identical storage key sets', async () => {
    const en = (await import('../../locales/en.json')).default as Record<string, Record<string, string>>;
    const zh = (await import('../../locales/zh-CN.json')).default as Record<string, Record<string, string>>;
    expect(Object.keys(en['storage']!)).toEqual(Object.keys(zh['storage']!));
    expect(zh['preferencesNav']!['storage']).toBeTruthy();
    expect(zh['preferencesNav']!['storage']).not.toBe(en['preferencesNav']!['storage']);
  });
});
