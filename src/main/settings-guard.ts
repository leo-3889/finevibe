import * as path from 'path';
import { homedir } from 'os';
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

/** Persist a consent decision for a config dir (global fields for the default dir). */
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
    const byDir = { ...state.preferences.statusLineConsentByDir };
    byDir[consentDirKey(configDir!)] = { consent, command };
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
  const choice = await new Promise<'replace' | 'keep'>((resolve) => {
    const onResponse = (_event: Electron.IpcMainEvent, c: string) => {
      win.removeListener('closed', onClose);
      resolve(c === 'replace' ? 'replace' : 'keep');
    };
    const onClose = () => {
      ipcMain.removeListener(channel, onResponse);
      resolve('keep');
    };
    ipcMain.once(channel, onResponse);
    win.once('closed', onClose);
    win.webContents.send('settings:showConflictDialog', { foreignCommand: foreignCmd });
  });

  state.preferences.statusLineConsent = choice === 'replace' ? 'granted' : 'declined';
  state.preferences.statusLineConsentCommand = currentForeign;
  saveState(state);

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
 */
export function guardedProfileInstall(configDir: string): void {
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
