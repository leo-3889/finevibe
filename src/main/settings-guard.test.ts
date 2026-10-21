import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { isWin } from './platform';

const SCRIPT_DIR = path.join('/home/test', '.vibeyard', 'run');
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
}));

// guardedInstall exercises the full consent flow: stub the installers, the
// persisted state and the Claude settings reader (the reader returns a
// foreign statusLine, forcing the consent path); settings-guard's own logic
// stays real. vi.hoisted so the lazy factories can close over these.
const { FOREIGN_STATUSLINE, installHooksOnly, installStatusLine: mockInstallStatusLine } = vi.hoisted(() => ({
  FOREIGN_STATUSLINE: '/usr/bin/foreign-statusline.sh',
  installHooksOnly: vi.fn(),
  installStatusLine: vi.fn(),
}));

vi.mock('./claude-cli', () => ({
  HOOK_MARKER: '# vibeyard-hook',
  installHooksOnly,
  installStatusLine: mockInstallStatusLine,
  getSupportedHookEvents: () =>
    new Set([
      'SessionStart', 'UserPromptSubmit', 'PostToolUse',
      'PostToolUseFailure', 'Stop', 'StopFailure', 'PermissionRequest',
    ]),
}));

vi.mock('./store', () => ({
  loadState: vi.fn(() => ({ preferences: {} })),
  saveState: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  readJsonSafe: vi.fn(() => ({ statusLine: { command: FOREIGN_STATUSLINE } })),
}));

import { EventEmitter } from 'node:events';
import {
  isVibeyardStatusLine, shouldWarnStatusLine, guardedInstall,
  guardedProfileInstall, reinstallSettings, consentDirKey,
} from './settings-guard';
import { installStatusLine } from './claude-cli';
import { saveState, loadState } from './store';
import { readJsonSafe } from './fs-utils';

describe('isVibeyardStatusLine', () => {
  it('returns true for current statusline path', () => {
    expect(isVibeyardStatusLine({ command: STATUSLINE_SCRIPT })).toBe(true);
  });

  it('returns true for legacy tmp-dir statusline path (unix)', () => {
    expect(isVibeyardStatusLine({
      command: '/var/folders/_k/hyr0867141z9_6ghbmwh65g80000gn/T/vibeyard/statusline.sh',
    })).toBe(true);
  });

  it('returns true for legacy /tmp/vibeyard path', () => {
    expect(isVibeyardStatusLine({ command: '/tmp/vibeyard/statusline.sh' })).toBe(true);
  });

  it('returns true for legacy windows tmp-dir statusline path', () => {
    expect(isVibeyardStatusLine({
      command: 'C:\\Users\\test\\AppData\\Local\\Temp\\vibeyard\\statusline.cmd',
    })).toBe(true);
  });

  it('returns false for foreign statusline', () => {
    expect(isVibeyardStatusLine({ command: '/usr/local/bin/some-other-tool.sh' })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isVibeyardStatusLine(null)).toBe(false);
    expect(isVibeyardStatusLine(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isVibeyardStatusLine('string')).toBe(false);
  });

  it('returns false for object without command', () => {
    expect(isVibeyardStatusLine({ url: 'http://example.com' })).toBe(false);
  });
});

describe('shouldWarnStatusLine', () => {
  const FOREIGN = '/usr/local/bin/other-tool.sh';
  const DIFFERENT_FOREIGN = '/opt/another/tool.sh';

  it('never warns when statusLine is Vibeyard', () => {
    expect(shouldWarnStatusLine('vibeyard', null, null, null)).toBe(false);
    expect(shouldWarnStatusLine('vibeyard', 'granted', FOREIGN, null)).toBe(false);
    expect(shouldWarnStatusLine('vibeyard', 'declined', FOREIGN, null)).toBe(false);
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

  it('treats closing the consent dialog as declined: no install, declined saved', async () => {
    const win = loadingWin();
    win.webContents.isLoading = () => false;
    const done = guardedInstall(win);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'settings:showConflictDialog',
      { foreignCommand: FOREIGN_STATUSLINE },
    );
    win.emit('closed');
    await done;
    // 'keep' on close maps to declined and skips installStatusLine.
    expect(installStatusLine).not.toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: { statusLineConsent: 'declined', statusLineConsentCommand: FOREIGN_STATUSLINE },
      }),
    );
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
