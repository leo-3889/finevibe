import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { isWin } from './platform';

const SCRIPT_DIR = path.join('/home/test', '.finevibe', 'run');
const STATUSLINE_SCRIPT = path.join(SCRIPT_DIR, isWin ? 'statusline.cmd' : 'statusline.sh');

vi.mock('os', () => ({
  tmpdir: () => '/tmp',
  homedir: () => '/home/test',
}));

vi.mock('electron', () => ({
  BrowserWindow: {},
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  rmSync: vi.fn(),
  watch: vi.fn(),
  // consentDirKey canonicalizes through fs-utils' canonicalPath, whose
  // realpath chain runs against this mock. Identity by default (a real
  // realpath never returns undefined — canonicalChain's fallback needs a
  // throw, and the identity keeps every existing key in resolve form);
  // cases override for symlinks.
  realpathSync: vi.fn((p: fs.PathLike) => String(p)),
}));

// guardedInstall exercises the full consent flow: stub the installers, the
// persisted state and the Claude settings reader (the reader returns a
// foreign statusLine, forcing the consent path); settings-guard's own logic
// stays real. vi.hoisted so the lazy factories can close over these.
const { FOREIGN_STATUSLINE, installHooksOnly, installStatusLine: mockInstallStatusLine, supportedHookEvents } = vi.hoisted(() => ({
  FOREIGN_STATUSLINE: '/usr/bin/foreign-statusline.sh',
  installHooksOnly: vi.fn(),
  installStatusLine: vi.fn(),
  // P1-13: validateSettings' expected set comes from here, so the
  // version-unknown case is programmed by returning the empty set (the probe's
  // "undetectable" signal) — a fixed arrow function could not express it.
  supportedHookEvents: vi.fn(() =>
    new Set([
      'SessionStart', 'UserPromptSubmit', 'PostToolUse',
      'PostToolUseFailure', 'Stop', 'StopFailure', 'PermissionRequest',
    ]),
  ),
}));

vi.mock('./claude-cli', () => ({
  HOOK_MARKER: '# finevibe-hook',
  installHooksOnly,
  installStatusLine: mockInstallStatusLine,
  getSupportedHookEvents: supportedHookEvents,
}));

vi.mock('./store', () => ({
  loadState: vi.fn(() => ({ preferences: {} })),
  saveState: vi.fn(),
}));

// The real fs-utils stays live (consentDirKey uses canonicalPath, which
// resolves through the mocked fs above); only the settings reader is stubbed.
vi.mock('./fs-utils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as typeof fsUtilsModule),
    readJsonSafe: vi.fn(() => ({ statusLine: { command: FOREIGN_STATUSLINE } })),
  };
});

import { EventEmitter } from 'node:events';
import {
  isFineVibeStatusLine, shouldWarnStatusLine, guardedInstall,
  guardedProfileInstall, reinstallSettings, consentDirKey, resetProfileInstallMemo,
  recordDirConsent, validateSettings, FOLDS_CASE_BY_DIR_MAX,
} from './settings-guard';
import { readJsonSafe } from './fs-utils';
import type * as fsUtilsModule from './fs-utils';
import * as fs from 'fs';
import { installStatusLine } from './claude-cli';
import { saveState, loadState } from './store';

describe('isFineVibeStatusLine', () => {
  it('returns true for current statusline path', () => {
    expect(isFineVibeStatusLine({ command: STATUSLINE_SCRIPT })).toBe(true);
  });

  it('returns true for legacy tmp-dir statusline path (unix)', () => {
    expect(isFineVibeStatusLine({
      command: '/var/folders/_k/hyr0867141z9_6ghbmwh65g80000gn/T/finevibe/statusline.sh',
    })).toBe(true);
  });

  it('returns true for legacy /tmp/finevibe path', () => {
    expect(isFineVibeStatusLine({ command: '/tmp/finevibe/statusline.sh' })).toBe(true);
  });

  it('returns true for legacy windows tmp-dir statusline path', () => {
    expect(isFineVibeStatusLine({
      command: 'C:\\Users\\test\\AppData\\Local\\Temp\\finevibe\\statusline.cmd',
    })).toBe(true);
  });

  // The contract between the two sides: installStatusLine shells the script
  // path ("..." for cmd.exe, shQuote '...' on POSIX) and validateSettings must
  // read that exact form back as FineVibe's own. A raw-string compare graded
  // every healthy install as `foreign` — the checklist showed "Overwritten by
  // another tool", the consent gate prompted about FineVibe's own command, and
  // Fix rewrote the same value forever.
  it('returns true for the shell-quoted forms installStatusLine writes', () => {
    expect(isFineVibeStatusLine({ command: `"${STATUSLINE_SCRIPT}"` })).toBe(true);
    expect(isFineVibeStatusLine({ command: `'${STATUSLINE_SCRIPT}'` })).toBe(true);
  });

  it('returns true for a POSIX-quoted path containing a single quote', () => {
    // shQuote("/home/test/.finevibe/run/o'brien.sh")-style escaping: ' \'' .
    const quoted = `'${STATUSLINE_SCRIPT.replace(/'/g, `'\\''`)}'`;
    expect(isFineVibeStatusLine({ command: quoted })).toBe(true);
  });

  it('returns true for a spelling variant of the script path', () => {
    const variant = path.resolve(SCRIPT_DIR, '.', '..', 'run', isWin ? 'statusline.cmd' : 'statusline.sh');
    const slashed = variant.split(path.sep).join('/');
    expect(isFineVibeStatusLine({ command: `"${slashed}"` })).toBe(true);
  });

  it('returns false for a quoted foreign command', () => {
    expect(isFineVibeStatusLine({ command: '"/usr/local/bin/ccline.sh"' })).toBe(false);
    expect(isFineVibeStatusLine({ command: `'/home/test/.finevibe/run/other.sh'` })).toBe(false);
  });

  it('returns false for foreign statusline', () => {
    expect(isFineVibeStatusLine({ command: '/usr/local/bin/some-other-tool.sh' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isFineVibeStatusLine(null)).toBe(false);
    expect(isFineVibeStatusLine(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isFineVibeStatusLine('string')).toBe(false);
  });

  it('returns false for object without command', () => {
    expect(isFineVibeStatusLine({ url: 'http://example.com' })).toBe(false);
  });
});

describe('shouldWarnStatusLine', () => {
  const FOREIGN = '/usr/local/bin/other-tool.sh';
  const DIFFERENT_FOREIGN = '/opt/another/tool.sh';

  it('never warns when statusLine is FineVibe', () => {
    expect(shouldWarnStatusLine('finevibe', null, null, null)).toBe(false);
    expect(shouldWarnStatusLine('finevibe', 'granted', FOREIGN, null)).toBe(false);
    expect(shouldWarnStatusLine('finevibe', 'declined', FOREIGN, null)).toBe(false);
  });

  it('suppresses warning when user declined the same foreign command', () => {
    expect(shouldWarnStatusLine('foreign', 'declined', FOREIGN, FOREIGN)).toBe(false);
  });

  it('warns when foreign command differs from previously declined one', () => {
    expect(shouldWarnStatusLine('foreign', 'declined', FOREIGN, DIFFERENT_FOREIGN)).toBe(true);
  });

  it('warns when user declined but consent command is unknown (legacy)', () => {
    expect(shouldWarnStatusLine('foreign', 'declined', null, FOREIGN)).toBe(true);
    expect(shouldWarnStatusLine('foreign', 'declined', undefined, FOREIGN)).toBe(true);
  });

  it('still warns about missing statusLine even if user declined', () => {
    expect(shouldWarnStatusLine('missing', 'declined', FOREIGN, null)).toBe(true);
  });

  it('warns when user has not yet decided', () => {
    expect(shouldWarnStatusLine('foreign', null, null, FOREIGN)).toBe(true);
    expect(shouldWarnStatusLine('foreign', undefined, null, FOREIGN)).toBe(true);
    expect(shouldWarnStatusLine('missing', null, null, null)).toBe(true);
  });

  it('warns when user granted but another tool overwrote it', () => {
    expect(shouldWarnStatusLine('foreign', 'granted', null, FOREIGN)).toBe(true);
  });
});
// P2-32: the renderer-readiness gate in guardedInstall must settle when the
// window dies. The consent dialog below pairs its IPC listener with a
// 'closed' listener; the gate needs the same counterpart so a quit-while-
// loading is an explicit dismissal — declined, no install — never a hang
// and never an approval.
describe('guardedInstall window lifecycle', () => {
  function loadingWin() {
    const win: any = new EventEmitter();
    const webContents: any = new EventEmitter();
    webContents.isLoading = () => true;
    webContents.send = vi.fn();
    win.webContents = webContents;
    return win;
  }

  async function settleInTime(promise: Promise<void>): Promise<string> {
    return Promise.race([
      promise.then(() => 'settled'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 250)),
    ]);
  }

  it('settles, declines and detaches listeners when the window closes mid-load', async () => {
    const win = loadingWin();
    const done = guardedInstall(win);
    win.emit('closed');
    // Real emitter close event; before the counterpart existed this stayed
    // pending forever.
    expect(await settleInTime(done)).toBe('settled');
    // A dismissal is not consent: no install, no dialog, no recorded decision.
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  it('settles when the webContents is destroyed mid-load', async () => {
    const win = loadingWin();
    const done = guardedInstall(win);
    win.webContents.emit('destroyed');
    expect(await settleInTime(done)).toBe('settled');
    expect(installStatusLine).not.toHaveBeenCalled();
  });

  it('S1-04: closing the window mid-dialog is a dismissal — no install and NO recorded decision', async () => {
    const win = loadingWin();
    win.webContents.isLoading = () => false;
    const done = guardedInstall(win);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'settings:showConflictDialog',
      { foreignCommand: FOREIGN_STATUSLINE },
    );
    win.emit('closed');
    await done;
    // The old code resolved 'keep' on close and persisted declined +
    // the foreign command, silently retiring both prompt surfaces for a
    // decision the user never made. A dismissal records nothing, so the
    // next launch re-prompts.
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });
});

// P1-14: the per-spawn profile install must go through the same consent gate
// as the default dir. Spawn is a hot path — no dialog — so a first-run
// foreign statusLine is left alone: the per-session banner is the profile's
// consent surface (its Fix Settings CTA repairs that dir, P2-127; its
// dismissal records a Keep), and a prior Keep must suppress the install.
describe('guardedProfileInstall (P1-14)', () => {
  const PROFILE_DIR = path.join('/home/test', '.claude-profiles', 'work');
  const KEY = consentDirKey(PROFILE_DIR);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readJsonSafe).mockReturnValue({ statusLine: { command: FOREIGN_STATUSLINE } });
    vi.mocked(loadState).mockReturnValue({ preferences: {} } as never);
    // PA-26: the per-spawn memo is module state; each case must start cold.
    resetProfileInstallMemo();
  });

  it('honors a prior Keep for this dir: hooks install, statusLine untouched, no new record', () => {
    vi.mocked(loadState).mockReturnValue({
      preferences: { statusLineConsentByDir: { [KEY]: { consent: 'declined', command: FOREIGN_STATUSLINE } } },
    } as never);
    guardedProfileInstall(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledWith(PROFILE_DIR);
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('leaves a first-run foreign statusLine alone: no silent overwrite, no recorded decision', () => {
    guardedProfileInstall(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledWith(PROFILE_DIR);
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('installs into a fresh profile dir (no settings.json — nothing foreign to overwrite)', () => {
    vi.mocked(readJsonSafe).mockReturnValue(null);
    guardedProfileInstall(PROFILE_DIR);
    expect(installStatusLine).toHaveBeenCalledWith(PROFILE_DIR);
  });

  it('installs when Replace consent covers this exact foreign command', () => {
    vi.mocked(loadState).mockReturnValue({
      preferences: { statusLineConsentByDir: { [KEY]: { consent: 'granted', command: FOREIGN_STATUSLINE } } },
    } as never);
    guardedProfileInstall(PROFILE_DIR);
    expect(installStatusLine).toHaveBeenCalledWith(PROFILE_DIR);
  });

  it('a Replace recorded for the default dir does not license overwriting a profile dir', () => {
    vi.mocked(loadState).mockReturnValue({
      preferences: { statusLineConsent: 'granted', statusLineConsentCommand: FOREIGN_STATUSLINE },
    } as never);
    guardedProfileInstall(PROFILE_DIR);
    expect(installStatusLine).not.toHaveBeenCalled();
  });

  it('freezes a command-less declined record onto the current foreign command', () => {
    vi.mocked(loadState).mockReturnValue({
      preferences: { statusLineConsentByDir: { [KEY]: { consent: 'declined', command: null } } },
    } as never);
    guardedProfileInstall(PROFILE_DIR);
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: { statusLineConsentByDir: { [KEY]: { consent: 'declined', command: FOREIGN_STATUSLINE } } },
      }),
    );
  });

  it('PA-26: a second spawn on an unchanged settings.json is a memo hit; an mtime change re-validates', () => {
    const stat = vi.mocked(fs.statSync);
    stat.mockReturnValue({ mtimeMs: 111 } as fs.Stats);
    guardedProfileInstall(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledTimes(1);

    // Same mtime = nothing touched settings.json: the full validate +
    // install (the per-spawn cost PA-26 removes) must not run again.
    guardedProfileInstall(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledTimes(1);

    // settings.json rewritten (user/CLI edit, "Fix Settings") → re-validate.
    stat.mockReturnValue({ mtimeMs: 222 } as fs.Stats);
    guardedProfileInstall(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledTimes(2);
  });
});

// P2-127: the banner is computed from the profiled session's config dir, so
// "Fix Settings" must repair THAT dir — the profiled CLI never reads
// ~/.claude. With no dir, the repair is byte-identical to the old behavior.
describe('reinstallSettings(configDir) (P2-127)', () => {
  const PROFILE_DIR = path.join('/home/test', '.claude-profiles', 'work');
  const KEY = consentDirKey(PROFILE_DIR);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadState).mockReturnValue({ preferences: {} } as never);
  });

  it('repairs the profile dir the banner was computed from, not ~/.claude', () => {
    reinstallSettings(PROFILE_DIR);
    expect(installHooksOnly).toHaveBeenCalledWith(PROFILE_DIR);
    expect(installStatusLine).toHaveBeenCalledWith(PROFILE_DIR);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: { statusLineConsentByDir: { [KEY]: { consent: 'granted', command: null } } },
      }),
    );
  });

  it('keeps the default-dir repair byte-identical: global consent record, no by-dir entry', () => {
    reinstallSettings();
    expect(installHooksOnly).toHaveBeenCalledWith(undefined);
    expect(installStatusLine).toHaveBeenCalledWith(undefined);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: { statusLineConsent: 'granted', statusLineConsentCommand: null },
      }),
    );
  });
});

// C3M-05: the by-dir consent map grew unbounded and kept records for
// deleted profile dirs forever — recordDirConsent is its only write site,
// so pruning + FIFO cap live there.
describe('recordDirConsent map hygiene (C3M-05)', () => {
  const PROFILE_DIR = path.join('/home/test', '.claude-profiles', 'work');
  const KEY = consentDirKey(PROFILE_DIR);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadState).mockReturnValue({ preferences: {} } as never);
  });

  function savedByDir(): Record<string, unknown> {
    const state = vi.mocked(saveState).mock.calls[0][0] as {
      preferences: { statusLineConsentByDir: Record<string, unknown> };
    };
    return state.preferences.statusLineConsentByDir;
  }

  it('drops records whose config dir no longer exists', () => {
    vi.mocked(loadState).mockReturnValue({
      preferences: { statusLineConsentByDir: { '/gone/profile': { consent: 'declined', command: null } } },
    } as never);
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p) !== '/gone/profile');

    recordDirConsent(PROFILE_DIR, 'granted', null);

    expect(savedByDir()).toEqual({ [KEY]: { consent: 'granted', command: null } });
  });

  it('caps the map at 200 records, dropping the oldest entries first', () => {
    const byDir: Record<string, { consent: 'declined'; command: null }> = {};
    for (let i = 0; i < 250; i++) byDir[`/dir/${i}`] = { consent: 'declined', command: null };
    vi.mocked(loadState).mockReturnValue({ preferences: { statusLineConsentByDir: byDir } } as never);
    vi.mocked(fs.existsSync).mockReturnValue(true);

    recordDirConsent(PROFILE_DIR, 'granted', 'cmd');

    const keys = Object.keys(savedByDir());
    expect(keys).toHaveLength(200);
    // Insertion order is FIFO: the 51 oldest records are gone, the fresh
    // key lands at the tail.
    expect(keys).not.toContain('/dir/0');
    expect(keys).not.toContain('/dir/50');
    expect(keys).toContain('/dir/51');
    expect(keys).toContain(KEY);
  });
});

// consentDirKey canonicalization: a symlinked spelling of an already-
// answered dir used to earn its own consent record (repeat prompts),
// because path.resolve leaves links, junctions, 8.3 names and case
// spellings intact. canonicalPath + a folds-case probe collapse them.
describe('consentDirKey canonicalization', () => {
  const REAL_DIR = path.join('/home/test', '.claude-profiles', 'work');
  const LINK_DIR = path.join('/home/test', 'link-to-work');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
  });

  it.skipIf(process.platform === 'win32')(
    'maps a symlinked spelling of a dir onto the same consent key',
    () => {
      vi.mocked(fs.realpathSync).mockImplementation((p) =>
        String(p) === LINK_DIR ? REAL_DIR : String(p),
      );
      expect(consentDirKey(LINK_DIR)).toBe(consentDirKey(REAL_DIR));
    },
  );

  it('collapses case spellings on a case-folding filesystem', () => {
    // The folds-case probe writes a probe file and checks the flipped
    // spelling: with the mocked fs both exist, so the key case-folds —
    // one record for 'MixedCase-Dir' and 'mixedcase-dir'.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(consentDirKey(path.join('/home/test', 'MixedCase-Dir')))
      .toBe(consentDirKey(path.join('/home/test', 'mixedcase-dir')));
  });

  it.skipIf(process.platform !== 'win32')(
    'keeps Windows keys resolve-form lowercase (stored-key identity)',
    () => {
      // Existing on-disk consent records were keyed by
      // resolve().toLowerCase(); for plain (non-linked) dirs the new
      // canonical form must produce the same key, or every user would be
      // re-prompted.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(consentDirKey('C:\\Users\\Alex\\.claude')).toBe('c:/users/alex/.claude');
    },
  );
});

// P1-13: when `claude --version` fails (a 3 s timeout during a heavy launch,
// an unrecognized build) the supported-event set collapses to empty. Pre-fix
// the guard compared `found === expectedHookEvents.length` — `0 === 0` — and
// reported `hooks: 'complete'` for a settings.json whose FineVibe hooks the
// same empty set had just stripped: no banner, no "Fix Settings", zero status
// events for every Claude session. It now fails closed to 'missing', the one
// state every consumer already keys the repair off (`hooks !== 'complete'` in
// settings-guard-ui.ts, setup-checks.ts and the per-spawn warning in
// ipc-handlers.ts).
describe('validateSettings with an undetectable CLI version (P1-13)', () => {
  const ALL_EVENTS = [
    'SessionStart', 'UserPromptSubmit', 'PostToolUse',
    'PostToolUseFailure', 'Stop', 'StopFailure', 'PermissionRequest',
  ];

  function settingsWithHooks(events: string[]): Record<string, unknown> {
    return {
      statusLine: { type: 'command', command: STATUSLINE_SCRIPT },
      hooks: Object.fromEntries(events.map(e => [e, [{
        matcher: '',
        hooks: [{ type: 'command', command: `echo ${e}:working # finevibe-hook` }],
      }]])),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readJsonSafe).mockReturnValue(settingsWithHooks(ALL_EVENTS));
  });

  afterEach(() => {
    // The hoisted default (full support) must survive the empty-set case.
    supportedHookEvents.mockImplementation(() => new Set(ALL_EVENTS));
  });

  it('reports the hooks missing — never complete — when the probe failed', () => {
    supportedHookEvents.mockReturnValue(new Set<string>());

    const result = validateSettings();

    // Fail-before: a settings.json holding every FineVibe hook graded
    // 'complete' here, so the banner never rendered.
    expect(result.hooks).toBe('missing');
    // Every candidate event is listed as unverified, so the preferences
    // checklist still names what could not be confirmed.
    expect(result.hookDetails).toEqual(Object.fromEntries(ALL_EVENTS.map(e => [e, false])));
    // Only the hook set is undecidable; the statusLine is plain file state.
    expect(result.statusLine).toBe('finevibe');
  });

  it('still reports complete for a full install once the version is known', () => {
    const result = validateSettings();
    expect(result.hooks).toBe('complete');
    expect(Object.values(result.hookDetails).every(Boolean)).toBe(true);
  });

  it('reports partial when a known version has only some events installed', () => {
    vi.mocked(readJsonSafe).mockReturnValue(settingsWithHooks(['Stop']));

    const result = validateSettings();

    expect(result.hooks).toBe('partial');
    expect(result.hookDetails.Stop).toBe(true);
    expect(result.hookDetails.SessionStart).toBe(false);
  });
});

// B1: the probe memo is module state with no bound — a long-lived session
// touching many config dirs wrote a probe result per dir forever. The fill
// below saturates the memo past the cap, so every dir an EARLIER suite
// probed is evicted too: the probe counts below depend on this test's dirs
// only, whatever ran before it.
describe('foldsCase memo cap (B1)', () => {
  it('caps the probe memo at 200 dirs, oldest dir evicted first', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const dirs = Array.from({ length: FOLDS_CASE_BY_DIR_MAX + 10 }, (_, i) =>
      path.join('/home/test', `probe-cap-${i}`));
    for (const d of dirs) consentDirKey(d);
    // One probe per fresh dir: 210 writes, cap 200 → the 10 oldest evicted.
    expect(vi.mocked(fs.writeFileSync).mock.calls.length)
      .toBeGreaterThanOrEqual(FOLDS_CASE_BY_DIR_MAX + 10);
    vi.mocked(fs.writeFileSync).mockClear();

    consentDirKey(dirs[0]!); // evicted by the overflow: the dir is re-probed
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(1);

    consentDirKey(dirs[dirs.length - 1]!); // recent: memo hit, zero probes
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBe(1);
  });
});
