import * as path from 'path';
import { homedir } from 'os';
import * as fs from 'fs';
import { ipcMain, BrowserWindow } from 'electron';
import { getStatusLineScriptPath } from './hook-status';
import { HOOK_MARKER, installHooksOnly, installStatusLine, getSupportedHookEvents } from './claude-cli';
import { readJsonSafe } from './fs-utils';
import { loadState, saveState } from './store';
import { isWin } from './platform';
import type { Preferences, SettingsValidationResult } from '../shared/types';

const LEGACY_STATUSLINE_RE = /[/\\]finevibe[/\\]statusline\.(sh|cmd)$/;

const CANDIDATE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PostToolUse',
  'PostToolUseFailure', 'Stop', 'StopFailure', 'PermissionRequest',
];

/**
 * Hook events the guard expects to find installed, filtered by which events
 * the currently-installed Claude CLI version actually supports. Events that
 * the CLI does not support are dropped so the guard does not flag them as
 * "missing" and trigger a reinstall loop.
 */
function getExpectedHookEvents(): string[] {
  const supported = getSupportedHookEvents();
  return CANDIDATE_HOOK_EVENTS.filter(e => supported.has(e));
}

function readClaudeSettings(configDir: string = path.join(homedir(), '.claude')): Record<string, unknown> {
  // pi-lens-ignore: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readJsonSafe(path.join(configDir, 'settings.json')) ?? {};
}

export function isFineVibeStatusLine(statusLine: unknown): boolean {
  if (!statusLine || typeof statusLine !== 'object') return false;
  const sl = statusLine as Record<string, unknown>;
  if (sl.command === getStatusLineScriptPath()) return true;
  // Recognize legacy FineVibe statusline paths (e.g. /tmp/finevibe/statusline.sh)
  // so upgrades silently replace them without showing a conflict dialog.
  if (typeof sl.command === 'string') {
    return LEGACY_STATUSLINE_RE.test(sl.command);
  }
  return false;
}

export function validateSettings(configDir?: string): SettingsValidationResult {
  const settings = readClaudeSettings(configDir);
  const expectedHookEvents = getExpectedHookEvents();

  let statusLine: SettingsValidationResult['statusLine'] = 'missing';
  let foreignStatusLineCommand: string | undefined;
  if (settings.statusLine) {
    if (isFineVibeStatusLine(settings.statusLine)) {
      statusLine = 'finevibe';
    } else {
      statusLine = 'foreign';
      const sl = settings.statusLine as Record<string, unknown>;
      foreignStatusLineCommand = String(sl.command ?? sl.url ?? JSON.stringify(settings.statusLine));
    }
  }

  let hooks: SettingsValidationResult['hooks'] = 'missing';
  const hookDetails: Record<string, boolean> = Object.fromEntries(expectedHookEvents.map(e => [e, false]));
  const existingHooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (existingHooks) {
    let found = 0;
    for (const event of expectedHookEvents) {
      const matchers = existingHooks[event];
      const installed = matchers?.some(m => m.hooks?.some(h => h.command?.includes(HOOK_MARKER))) ?? false;
      hookDetails[event] = installed;
      if (installed) found++;
    }
    if (found === expectedHookEvents.length) {
      hooks = 'complete';
    } else if (found > 0) {
      hooks = 'partial';
    }
  }

  return { statusLine, hooks, foreignStatusLineCommand, hookDetails };
}

/**
 * Whether the per-session warning banner should flag the statusLine state.
 *
 * Consent is bound to the specific foreign command the user was asked about.
 * A different foreign command is a new conflict and still warrants a warning,
 * even if the user previously declined a different one.
 */
export function shouldWarnStatusLine(
  statusLine: SettingsValidationResult['statusLine'],
  consent: 'granted' | 'declined' | null | undefined,
  consentCommand: string | null | undefined,
  currentForeignCommand: string | null | undefined,
): boolean {
  if (statusLine === 'finevibe') return false;
  if (
    statusLine === 'foreign' &&
    consent === 'declined' &&
    !!consentCommand &&
    !!currentForeignCommand &&
    consentCommand === currentForeignCommand
  ) {
    return false;
  }
  return true;
}

/** Default Claude config dir — the dir app boot and guardedInstall() own. */
function defaultClaudeDir(): string {
  return path.join(homedir(), '.claude');
}

/**
 * Normalized consent key for a config dir: resolved, separator-normalized
 * and case-folded where the filesystem is case-insensitive, so one dir
 * always maps to one record no matter how the caller spelled it.
 */
export function consentDirKey(configDir: string): string {
  // pi-lens-ignore: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolved = path.resolve(configDir).split(path.sep).join('/');
  return isWin ? resolved.toLowerCase() : resolved;
}

function isDefaultClaudeDir(configDir?: string): boolean {
  return !configDir || consentDirKey(configDir) === consentDirKey(defaultClaudeDir());
}

/**
 * The statusLine consent record that governs a config dir (P1-14). The
 * default dir keeps the original global fields; every profile dir has its
 * own record, so a Keep/Replace decided for one dir never governs another.
 */
export function getDirConsent(
  prefs: Preferences,
  configDir?: string,
): { consent: 'granted' | 'declined' | null | undefined; command: string | null | undefined } {
  if (isDefaultClaudeDir(configDir)) {
    return { consent: prefs.statusLineConsent, command: prefs.statusLineConsentCommand };
  }
  const record = prefs.statusLineConsentByDir?.[consentDirKey(configDir!)];
  return { consent: record?.consent, command: record?.command };
}

/** C3M-05: cap on per-dir consent records (mirrors the C2R-17 cap idiom). */
const MAX_CONSENT_DIR_RECORDS = 200;
/**
 * Persist a consent decision for a config dir (global fields for the default
 * dir). The per-dir map is pruned of records whose dir no longer exists —
 * a deleted profile's record can never be read again — and capped FIFO at
 * MAX_CONSENT_DIR_RECORDS, oldest first (C3M-05).
 */
export function recordDirConsent(
  configDir: string | undefined,
  consent: 'granted' | 'declined',
  command: string | null,
): void {
  const state = loadState();
  if (isDefaultClaudeDir(configDir)) {
    state.preferences.statusLineConsent = consent;
    state.preferences.statusLineConsentCommand = command;
  } else {
    const key = consentDirKey(configDir!);
    const byDir: NonNullable<Preferences['statusLineConsentByDir']> = {};
    for (const [dir, record] of Object.entries(state.preferences.statusLineConsentByDir ?? {})) {
      // recordDirConsent is the map's only write site, so this is where
      // pruning lives; the key being written survives unconditionally.
      if (dir !== key && fs.existsSync(dir)) byDir[dir] = record;
    }
    byDir[key] = { consent, command };
    while (Object.keys(byDir).length > MAX_CONSENT_DIR_RECORDS) {
      const oldest = Object.keys(byDir)[0]!;
      delete byDir[oldest];
    }
    state.preferences.statusLineConsentByDir = byDir;
  }
  saveState(state);
}

/**
 * Guarded hook/statusLine installation. Shows a dialog if a foreign statusLine
 * is detected and the user hasn't previously granted/declined consent for
 * that specific foreign command.
 */
export async function guardedInstall(win: BrowserWindow | null): Promise<void> {
  const validation = validateSettings();

  // Always install hooks (additive, non-destructive)
  installHooksOnly();

  if (validation.statusLine === 'finevibe' || validation.statusLine === 'missing') {
    installStatusLine();
    return;
  }

  // Foreign statusLine detected — check stored consent
  const state = loadState();
  const consent = state.preferences.statusLineConsent;
  const consentCommand = state.preferences.statusLineConsentCommand;
  const currentForeign = validation.foreignStatusLineCommand ?? '';

  // Legacy 'declined' without recorded command: assume the current foreign
  // is what the user originally chose to keep, and freeze it. Future edits
  // to a different command will re-prompt.
  if (consent === 'declined' && !consentCommand) {
    state.preferences.statusLineConsentCommand = currentForeign;
    saveState(state);
    return;
  }

  // Consent applies only to the specific foreign command it was given for.
  // A different (or unknown) foreign command is a new conflict — re-prompt.
  if (consent === 'granted' && consentCommand && consentCommand === currentForeign) {
    installStatusLine();
    return;
  }
  if (consent === 'declined' && consentCommand === currentForeign) {
    return;
  }

  // No prior decision for this foreign command — ask the user via in-app modal
  if (!win) return;

  // Wait for renderer to be ready before sending IPC. The consent dialog
  // below pairs its IPC listener with a 'closed' listener; this gate needs
  // the same counterpart (P2-32): without it, quitting while the window is
  // still loading leaves the promise pending forever, guardedInstall never
  // reaches installStatusLine(), and the did-finish-load listener stays
  // attached. A window that dies mid-load is an explicit dismissal, not
  // consent — return without recording a decision, so no install happens
  // and the next launch re-prompts.
  if (win.webContents.isLoading()) {
    const settled = await new Promise<'ready' | 'dismissed'>((resolve) => {
      const onReady = () => {
        win.removeListener('closed', onDismissed);
        win.webContents.removeListener('destroyed', onDismissed);
        resolve('ready');
      };
      const onDismissed = () => {
        win.webContents.removeListener('did-finish-load', onReady);
        win.removeListener('closed', onDismissed);
        win.webContents.removeListener('destroyed', onDismissed);
        resolve('dismissed');
      };
      win.webContents.once('did-finish-load', onReady);
      win.once('closed', onDismissed);
      win.webContents.once('destroyed', onDismissed);
    });
    if (settled === 'dismissed') return;
  }

  const foreignCmd = validation.foreignStatusLineCommand ?? '(unknown)';
  const channel = 'settings:conflictDialogResponse';
  // S1-04: a window closed mid-dialog is an explicit dismissal, NOT a
  // Keep. Resolving 'keep' here recorded `declined` + the foreign command
  // on quit, which shouldWarnStatusLine then honors forever — the user lost
  // both prompt surfaces for a decision they never made (directly
  // contradicting the loading gate's rule above). Dismissal records
  // nothing; the next launch re-prompts.
  const choice = await new Promise<'replace' | 'keep' | 'dismissed'>((resolve) => {
    const onResponse = (_event: Electron.IpcMainEvent, c: string) => {
      win.removeListener('closed', onClose);
      resolve(c === 'replace' ? 'replace' : 'keep');
    };
    const onClose = () => {
      ipcMain.removeListener(channel, onResponse);
      resolve('dismissed');
    };
    ipcMain.once(channel, onResponse);
    win.once('closed', onClose);
    win.webContents.send('settings:showConflictDialog', { foreignCommand: foreignCmd });
  });
  if (choice === 'dismissed') return;

  // S1-02: `state` is the PRE-modal snapshot (line 181) — the modal can
  // sit open for minutes while the renderer persists sessions/board moves.
  // Saving the snapshot rolled all of that back. Consent keys only, on a
  // fresh load (recordDirConsent's shape; the store graft keeps them
  // immune to the renderer's next whole-state persist).
  const fresh = loadState();
  fresh.preferences.statusLineConsent = choice === 'replace' ? 'granted' : 'declined';
  fresh.preferences.statusLineConsentCommand = currentForeign;
  saveState(fresh);

  if (choice === 'replace') {
    installStatusLine();
  }
}

/**
 * Consent-gated hook/statusLine install for a PROFILE config dir, run at
 * every profiled spawn (P1-14). Spawn is a hot path, so unlike
 * guardedInstall() this NEVER shows the conflict modal: the per-session
 * warning banner is the single consent surface for profile dirs —
 * - "Fix Settings" is the explicit Replace: reinstallSettings() repairs
 *   exactly this dir (P2-127) and records a granted per-dir record;
 * - the banner's dismissal is the Keep: settings:declineStatusLine records
 *   a declined per-dir record.
 * This function's half of the contract:
 * - hooks are additive: always installed (mirrors guardedInstall);
 * - a fresh/owned dir gets the statusLine installed (legacy paths upgraded);
 * - a prior Replace covering THIS foreign command installs;
 * - a prior Keep skips the install (a command-less declined record freezes
 *   onto the current foreign command, mirroring the default-dir flow);
 * - a first-run foreign statusLine gets NO install and NO recorded
 *   decision: no silent overwrite, and the banner keeps asking.
 *
 * PA-26 memo: the full validate (settings.json read + hook scan) + install
 * used to run on EVERY profile-bound spawn. The on-disk outcome is stable
 * until settings.json changes, so a successful pass is memoized per
 * normalized dir, keyed on the POST-install settings.json mtime (null =
 * the file did not exist): a rewritten settings.json re-validates. Consent
 * changes are safe under the memo — the only consent='granted' writer for a
 * profile dir is reinstallSettings(), which rewrites settings.json (mtime
 * bump → memo miss), and declined/undecided dirs install nothing, so a
 * memo hit replays exactly the no-op the consent state prescribes.
 */
const profileInstallMemo = new Map<string, number | null>();

/** @internal Test-only: drop the per-spawn install memo. */
export function resetProfileInstallMemo(): void {
  profileInstallMemo.clear();
}

// pi-lens-ignore: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
export function guardedProfileInstall(configDir: string): void {
  const settingsFile = path.join(configDir, 'settings.json');
  const key = consentDirKey(configDir);
  let mtimeMs: number | null;
  try {
    mtimeMs = fs.statSync(settingsFile).mtimeMs;
  } catch {
    mtimeMs = null; // no settings.json yet
  }
  if (profileInstallMemo.has(key) && profileInstallMemo.get(key) === mtimeMs) return;
  guardedProfileInstallUncached(configDir);
  // Record the POST-install mtime: the install itself (re)writes
  // settings.json, so caching the pre-run value would invalidate the memo
  // on the very next spawn and PA-26 would memo nothing.
  try {
    mtimeMs = fs.statSync(settingsFile).mtimeMs;
  } catch { /* file removed mid-install; next spawn re-validates */ }
  profileInstallMemo.set(key, mtimeMs);
}

function guardedProfileInstallUncached(configDir: string): void {
  const validation = validateSettings(configDir);

  // Always install hooks (additive, non-destructive)
  installHooksOnly(configDir);

  if (validation.statusLine === 'finevibe' || validation.statusLine === 'missing') {
    installStatusLine(configDir);
    return;
  }

  const { consent, command } = getDirConsent(loadState().preferences, configDir);
  const currentForeign = validation.foreignStatusLineCommand ?? '';
  if (consent === 'declined') {
    if (!command) recordDirConsent(configDir, 'declined', currentForeign);
    return;
  }
  if (consent === 'granted' && command && command === currentForeign) {
    installStatusLine(configDir);
  }
  // Undecided, a new foreign command, or a record that belongs to the
  // default dir: the foreign statusLine stays untouched — the banner carries it.
}

/**
 * Force reinstall both hooks and statusLine (for "Fix Settings" CTA).
 * Resets consent to granted since this is an explicit user action.
 * `configDir` is the dir the warning banner was computed from (P2-127): a
 * profiled session reads its pinned profile dir, never ~/.claude, so
 * repairing the default dir for a profile banner repairs nothing. No dir =
 * the default dir, byte-identical to the pre-P2-127 behavior.
 */
export function reinstallSettings(configDir?: string): void {
  installHooksOnly(configDir);
  installStatusLine(configDir);

  if (isDefaultClaudeDir(configDir)) {
    const state = loadState();
    state.preferences.statusLineConsent = 'granted';
    // No specific foreign command anymore — FineVibe now owns the statusLine.
    state.preferences.statusLineConsentCommand = null;
    saveState(state);
    return;
  }
  recordDirConsent(configDir, 'granted', null);
}
