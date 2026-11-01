import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const testHome = vi.hoisted(() => ({ path: '' }));
vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  homedir: () => testHome.path,
}));

// The phantom-host regression below walks a created record all the way to the
// remote dir-browser gate, so ssh-client must never touch a socket. Only the
// three verbs `listRemoteDirs` uses are scripted; every other export of the
// module stays unavailable to this file by construction.
const ssh = vi.hoisted(() => ({ listDirEntries: vi.fn(), stat: vi.fn(), exec: vi.fn(), close: vi.fn() }));
vi.mock('./hosts/ssh-client', () => ({
  sftpListDirEntries: (...args: unknown[]) => ssh.listDirEntries(...args),
  sftpStat: (...args: unknown[]) => ssh.stat(...args),
  exec: (...args: unknown[]) => ssh.exec(...args),
  closeConnection: (...args: unknown[]) => ssh.close(...args),
  sftpRead: vi.fn(),
  sftpReadRange: vi.fn(),
  connect: vi.fn(),
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

// Phantom host (owner screenshot, demo-host / host-a.local): the sidebar showed a
// host tab whose every verb answered `Unknown host 27b17b23-…`, while
// state.json held `"hosts": []`. The chain: Settings → Hosts calls
// `hosts:create` (main persists), the renderer's own `state.hosts` stays the
// boot-time `store:load` snapshot, the next renderer persist ships `hosts: []`,
// `graftMainOwnedHosts`' empty-list early return grades that as "nothing to
// graft", and `saveState` writes the shortened list through BOTH the cache
// (`listHosts`/`getHost`/`gateHost` go blind) and disk. The sidebar tab survives
// because `host-registry.ts` caches `hosts:list` separately and reloads only on
// `hosts:status`. This is the end-to-end shape of that bug: a key-auth host on
// an unreachable LAN name (the create must not care about reachability), a
// whole-state persist with a stale host list, and the browse gate afterwards.
describe('host registry survives a renderer whole-state persist', () => {
  let registry: typeof import('./hosts/host-registry');
  let remoteFs: typeof import('./hosts/remote-fs');

  const keyPath = () => path.join(testHome.path, '.ssh', 'id_ed25519');
  const draft = (name = 'demo-host') => ({
    name,
    user: 'leo',
    host: 'host-a.local',
    port: 22,
    authKind: 'key',
    privateKeyPath: keyPath(),
    enrollmentStatus: 'draft',
  });

  function stateFile(): string {
    return path.join(testHome.path, '.finevibe', 'state.json');
  }

  function diskHostIds(): string[] {
    // `createHost` saves through the debounced writer; flush so this reads the
    // commit under test instead of the previous file.
    store.flushState();
    return (JSON.parse(fs.readFileSync(stateFile(), 'utf-8')).hosts as Array<{ id: string }>).map((h) => h.id);
  }

  beforeAll(async () => {
    registry = await import('./hosts/host-registry');
    remoteFs = await import('./hosts/remote-fs');
  });

  beforeEach(() => {
    // Clean slate per case. Written to disk + reloaded rather than saved: the
    // graft (rightly) refuses to let a whole-state payload drop hosts main has,
    // so a save-based reset would resurrect the previous case's records.
    store.invalidateStateCache();
    fs.writeFileSync(stateFile(), JSON.stringify({ version: 1, projects: [], activeProjectId: null, hosts: [] }));
    store.loadState();
    ssh.listDirEntries.mockReset().mockResolvedValue([{ name: 'dev', isDirectory: true }, { name: 'notes.md', isDirectory: false }]);
  });

  it('a valid key-auth draft for an unreachable host lands in listHosts() and on disk, and the browse gate stops refusing it', async () => {
    const record = registry.createHost(draft());

    // (a) visible to main's readers AND durable: the phantom's signature was a
    // record the renderer could see and main could not find.
    expect(registry.listHosts().map((h) => h.id)).toEqual([record.id]);
    expect(registry.getHost(record.id)?.name).toBe('demo-host');
    expect(diskHostIds()).toEqual([record.id]);

    // (b) the browse gate on a draft host: refused for not being ENROLLED, i.e.
    // the record resolved. `Unknown host <id>` is the phantom's answer.
    const asDraft = await remoteFs.listRemoteDirs(record.id, '~');
    expect(asDraft.error).toContain('is not enrolled');

    registry.setEnrollmentStatus(record.id, 'enrolled');
    expect(await remoteFs.listRemoteDirs(record.id, '~')).toEqual({ ok: true, dirs: ['~/dev'] });
  });

  it('keeps the created host through the renderer whole-state save (store:save + the quit flush)', async () => {
    const record = registry.createHost(draft());
    registry.setEnrollmentStatus(record.id, 'enrolled');

    // The renderer's persist, byte-for-byte: the whole state with ITS host
    // list — the boot snapshot, which never saw this host. Both writer
    // branches: the debounced `store:save` and the `beforeunload`
    // `store:save-sync`.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1_000); // clear the throttle window the beforeEach sync save opened
      store.saveState({ ...store.loadState(), hosts: [] });
      vi.advanceTimersByTime(1_000);
    } finally {
      vi.useRealTimers();
    }
    expect(diskHostIds()).toEqual([record.id]);

    store.saveStateSync({ ...store.loadState(), hosts: [] });
    expect(diskHostIds()).toEqual([record.id]);

    // The cache is what `hosts:list`/`gateHost` read mid-session: the wipe had
    // to die there too, not only in the file.
    expect(registry.listHosts().map((h) => h.id)).toEqual([record.id]);

    // And it survives the restart with the browse lane intact (no `Unknown host`).
    store.invalidateStateCache();
    expect(registry.listHosts().map((h) => h.id)).toEqual([record.id]);
    expect(await remoteFs.listRemoteDirs(record.id, '~')).toEqual({ ok: true, dirs: ['~/dev'] });
  });

  it('lets a renderer payload drop a host main itself deleted', () => {
    const doomed = registry.createHost(draft('nyx'));

    registry.deleteHost(doomed.id);
    store.saveStateSync({ ...store.loadState(), hosts: [] });

    // `hosts:delete` is main-side, so main's cache is empty here: an empty
    // payload list is the truth, and the deleted record must not come back.
    expect(diskHostIds()).toEqual([]);
    store.invalidateStateCache();
    expect(registry.getHost(doomed.id)).toBeNull();
  });
});
