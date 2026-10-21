import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testHome = vi.hoisted(() => ({ path: '' }));
vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  homedir: () => testHome.path,
}));

let store: typeof import('./store');

beforeAll(async () => {
  testHome.path = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-store-test-'));
  store = await import('./store');
});

afterAll(() => {
  fs.rmSync(testHome.path, { recursive: true, force: true });
});

describe('state persistence on disk', () => {
  it('commits and loads a state file', () => {
    const state = store.loadState();
    state.activeProjectId = 'saved-project';
    store.saveStateSync(state);
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file + '.tmp')).toBe(false);
    expect(store.loadState().activeProjectId).toBe('saved-project');
  });

  it('recovers a valid temp state when the main file is corrupt', () => {
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    const state = store.loadState();
    state.activeProjectId = 'recovered-project';
    fs.writeFileSync(file, '{corrupt');
    fs.writeFileSync(file + '.tmp', JSON.stringify(state));
    expect(store.loadState().activeProjectId).toBe('recovered-project');
  });

  // writeStateAtomically fsyncs state.json.tmp BEFORE renaming it over
  // state.json, so a crash with the data durable and the rename not durable
  // leaves BOTH files valid: state.json = the previous save, .tmp = the newest
  // one. Loading state.json there silently reverts the whole app to an older
  // snapshot, and the first save then opens .tmp with 'w' and destroys the
  // newest copy. Recovery must take the newer mtime and consume the .tmp.
  it('recovers the newer temp snapshot when both files are valid', () => {
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    const older = { ...store.loadState(), activeProjectId: 'older-commit' };
    store.saveStateSync(older);
    const newer = { ...store.loadState(), activeProjectId: 'newest-crash' };
    fs.writeFileSync(file + '.tmp', JSON.stringify(newer));
    // Deterministic mtimes: 12 s apart, .tmp last.
    const t = Date.now();
    fs.utimesSync(file, new Date(t - 12_000), new Date(t - 12_000));
    fs.utimesSync(file + '.tmp', new Date(t), new Date(t));
    store.invalidateStateCache();

    expect(store.loadState().activeProjectId).toBe('newest-crash');
    // Consumed: the next save must not read, nor be shadowed by, the copy.
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('keeps state.json and discards a stale temp copy', () => {
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    store.saveStateSync({ ...store.loadState(), activeProjectId: 'current-commit' });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...store.loadState(), activeProjectId: 'abandoned-write' }));
    const t = Date.now();
    fs.utimesSync(file, new Date(t), new Date(t));
    fs.utimesSync(file + '.tmp', new Date(t - 12_000), new Date(t - 12_000));
    store.invalidateStateCache();

    expect(store.loadState().activeProjectId).toBe('current-commit');
    // A leftover .tmp is exactly what a later corrupt state.json would
    // resurrect, so recovery removes it even when it loses.
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('does not lose the temp snapshot to the next save after recovery', () => {
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    fs.writeFileSync(file, '{corrupt');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...store.loadState(), activeProjectId: 'only-copy' }));
    store.invalidateStateCache();
    expect(store.loadState().activeProjectId).toBe('only-copy');

    store.saveStateSync(store.loadState());
    store.invalidateStateCache();
    expect(store.loadState().activeProjectId).toBe('only-copy');
  });

  // P1-2: the old trailing debounce kept the WHOLE 300ms window exposed to
  // a crash — a mutation burst wrote nothing until the timer fired. The
  // leading-edge throttle writes the first mutation through at once and
  // coalesces the rest into one trailing write of the latest state.
  it('writes the leading edge immediately and lands a final write after a burst', () => {
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1_000); // clear any throttle window left by earlier sync saves
      store.saveState({ ...store.loadState(), activeProjectId: 'v1-leading' });
      // Leading edge: the burst's first mutation is already on disk.
      store.invalidateStateCache();
      expect(store.loadState().activeProjectId).toBe('v1-leading');

      store.saveState({ ...store.loadState(), activeProjectId: 'v2' });
      store.saveState({ ...store.loadState(), activeProjectId: 'v3-final' });
      // Inside the throttle window: only the armed trailing write is pending.
      store.invalidateStateCache();
      expect(store.loadState().activeProjectId).toBe('v1-leading');

      // The coalesced trailing write lands with the LATEST state.
      vi.advanceTimersByTime(300);
      store.invalidateStateCache();
      expect(store.loadState().activeProjectId).toBe('v3-final');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the armed trailing save on quit and disarms its timer', () => {
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1_000);
      store.saveState({ ...store.loadState(), activeProjectId: 'quit-leading' }); // leading write
      store.saveState({ ...store.loadState(), activeProjectId: 'quit-pending' }); // trailing armed

      // `before-quit` -> flushState(): written without waiting for the timer.
      store.flushState();
      store.invalidateStateCache();
      expect(store.loadState().activeProjectId).toBe('quit-pending');

      // The flush disarmed the trailing timer, so nothing writes after teardown.
      const mtime = fs.statSync(file).mtimeMs;
      vi.advanceTimersByTime(1000);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    } finally {
      vi.useRealTimers();
    }
  });

  // P2-101: state.json can hold secrets (`project.defaultEnv`). The atomic
  // writer opens the temp file 0600 (fs.openSync mode + fchmod for a .tmp
  // left behind by an older build), and the rename carries that mode onto
  // state.json, so no other local user, backup, or dotfile sync can read it.
  it('writes state.json owner-read/write-only on POSIX', () => {
    // Windows NTFS ignores the mode argument (ACL semantics); skip there.
    if (process.platform === 'win32') return;
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    store.saveStateSync({ ...store.loadState(), activeProjectId: 'mode-check' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('upgrades a 0644 state.json written by an older build', () => {
    if (process.platform === 'win32') return;
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    fs.writeFileSync(file, '{corrupt');
    fs.chmodSync(file, 0o644);
    store.saveStateSync({ ...store.loadState(), activeProjectId: 'mode-upgrade' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.invalidateStateCache();
    expect(store.loadState().activeProjectId).toBe('mode-upgrade');
  });
});

describe('main-owned gate root set (P1-12)', () => {
  const projectAt = (projectPath: string) => ({
    id: 'p',
    name: 'P',
    path: projectPath,
    sessions: [],
    activeSessionId: null,
    layout: { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' },
  });

  it('refuses a peer-written gate root at load and keeps real projects', () => {
    const realDir = fs.mkdtempSync(path.join(testHome.path, 'proj-'));
    const file = path.join(testHome.path, '.finevibe', 'state.json');
    const poison = process.platform === 'win32' ? 'C:\\' : '/';
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      projects: [projectAt(realDir), projectAt(poison), projectAt(path.join(testHome.path, 'nope-gone'))],
      activeProjectId: null,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.invalidateStateCache();
    const loaded = store.loadState();
    // A peer-written state.json must not persist a gate root across boots:
    // the real project survives load, the fabricated root and vanished dir
    // are dropped (logged). The root set itself is written by the main-side
    // save path — the quit-path flushState -> saveStateSync round-trip
    // carries exactly the validated set, and a reload keeps it.
    store.saveStateSync(loaded);
    expect(store.getKnownProjectPaths()).toEqual([fs.realpathSync(realDir)]);
    store.invalidateStateCache();
    expect(store.loadState().projects.map(p => p.path)).toEqual([realDir]);
    warn.mockRestore();
  });
});
