import * as path from 'path';
import { homedir } from 'os';
import * as fs from 'fs';
import { ipcMain, BrowserWindow } from 'electron';
import { getStatusLineScriptPath } from './hook-status';
import { HOOK_MARKER, installHooksOnly, installStatusLine, getSupportedHookEvents } from './claude-cli';
import { readJsonSafe, canonicalPath } from './fs-utils';
import { loadState, saveState } from './store';
import { isWin } from './platform';
import type { Preferences, SettingsValidationResult } from '../shared/types';
import { boundedSet } from './bounded-map';

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
 *
 * Returns null when the expected set is UNKNOWN. An empty supported set is
 * the version probe's "undetectable" signal (P2-53), not a CLI that supports
 * no hook events; a caller that read it as "expect nothing" graded a
 * settings.json whose FineVibe hooks had just been stripped as `complete`
 * (P1-13).
 */
function getExpectedHookEvents(): string[] | null {
  const supported = getSupportedHookEvents();
  if (supported.size === 0) return null;
  return CANDIDATE_HOOK_EVENTS.filter(e => supported.has(e));
}

function readClaudeSettings(configDir: string = path.join(homedir(), '.claude')): Record<string, unknown> {
  // pi-lens-ignore: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readJsonSafe(path.join(configDir, 'settings.json')) ?? {};
}

/**
 * Remove the single layer of shell quoting `installStatusLine` writes around
 * the script path: `"C:\Users\...\statusline.cmd"` for cmd.exe, `'/path'`
 * via shQuote on POSIX (where an embedded `'` is escaped as `'\''`).
 *
 * The reader must undo what the writer did. The writer quotes because Claude
 * Code runs the statusLine command through a shell and a raw path breaks on
 * the first space (spaced home dirs, every `C:\Users\...` install); the
 * reader once compared the raw `getStatusLineScriptPath()` string, so every
 * healthy FineVibe install graded as `foreign` — the setup checklist showed
 * "Overwritten by another tool", the consent gate prompted about FineVibe's
 * own command, and `Fix` rewrote the same quoted command forever.
 */
function unquoteStatusLineCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last || (first !== '"' && first !== "'")) return trimmed;
  const inner = trimmed.slice(1, -1);
  // POSIX shQuote closes the quote, emits an escaped literal quote, and
  // reopens: `it` -> `'it'\''s'`. cmd.exe doubles an embedded `"`.
  return (first === "'" ? inner.replace(/'\\''/g, "'") : inner.replace(/""/g, '"')).trim();
}

/**
 * Lexical key for a statusline script path: shell-quoted forms, `..`/`.`
 * segments, trailing separators, `\` vs `/` spellings, and (on the
 * case-folding Windows volumes this runs on) letter case all collapse to one
 * key. Lexical on purpose: `canonicalPath`/realpath hits the filesystem, and
 * validation runs before the script has necessarily been installed.
 */
function statusLinePathKey(command: string): string {
  const resolved = path.resolve(unquoteStatusLineCommand(command));
  const slashed = resolved.split(path.sep).join('/');
  return isWin ? slashed.toLowerCase() : slashed;
}

export function isFineVibeStatusLine(statusLine: unknown): boolean {
  if (!statusLine || typeof statusLine !== 'object') return false;
  const sl = statusLine as Record<string, unknown>;
  if (typeof sl.command !== 'string') return false;
  if (statusLinePathKey(sl.command) === statusLinePathKey(getStatusLineScriptPath())) return true;
  // Recognize legacy FineVibe statusline paths (e.g. /tmp/finevibe/statusline.sh)
  // so upgrades silently replace them without showing a conflict dialog.
  return LEGACY_STATUSLINE_RE.test(unquoteStatusLineCommand(sl.command));
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

  // P1-13 fail-closed: with the version undetected there is no expected set
  // to prove 'complete' against (the old `found === expected.length` compare
  // was `0 === 0`), so the state reports 'missing' with every candidate event
  // unverified. Consumers key the repair off `hooks !== 'complete'` — the
  // per-session banner's "Fix Settings" CTA (settings-guard-ui), the
  // preferences setup checklist — so the user gets the fix, which re-probes.
  const detailEvents = expectedHookEvents ?? CANDIDATE_HOOK_EVENTS;
  let hooks: SettingsValidationResult['hooks'] = 'missing';
  const hookDetails: Record<string, boolean> = Object.fromEntries(detailEvents.map(e => [e, false]));
  const existingHooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (expectedHookEvents && existingHooks) {
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
 * Cached {@link probeFoldsCase} result, keyed by the canonical
 * (separator-normalized) dir. Case folding is a volume property; probing
 * once per dir keeps the write side of the probe off the consent lookup
 * (a hot path: every banner check, every install).
 */
const foldsCaseByDir = new Map<string, boolean>();
/** B1: FIFO bound mirroring MAX_CONSENT_DIR_RECORDS (C3M-05) below — a
 * long-lived session probing many dirs must not grow the memo unbounded.
 * Oldest dir evicted first; the eviction cost is one re-probe (a write +
 * exists + unlink in a `finally`), never a policy change. */
export const FOLDS_CASE_BY_DIR_MAX = 200;

/**
 * Whether the filesystem holding `dir` (or its nearest existing ancestor)
 * folds letter case in lookups.
 *
 * Probed rather than derived from `process.platform`: APFS can be created
 * either way on macOS, so the platform alone does not answer it. If the
 * anchor cannot be written the probe is impossible, so we fall back to the
 * platform default — Windows folds (mirrors profiles.ts' canonicalDir
 * probe).
 */
function probeFoldsCase(dir: string): boolean {
  let anchor = path.resolve(dir);
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) return true;
    anchor = parent;
  }
  const probe = path.join(anchor, `FineVibeCaseProbe-${process.pid}`);
  const flipped = path.join(anchor, `finevibeCASEprobe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    return fs.existsSync(flipped);
  } catch {
    return isWin;
  } finally {
    try { fs.unlinkSync(probe); } catch { /* already gone */ }
  }
}

function foldsCase(dir: string): boolean {
  const cached = foldsCaseByDir.get(dir);
  if (cached !== undefined) return cached;
  const folds = probeFoldsCase(dir);
  boundedSet(foldsCaseByDir, dir, folds, FOLDS_CASE_BY_DIR_MAX);
  return folds;
}

/**
 * Normalized consent key for a config dir: canonical (realpath chain —
 * symlinks, junctions, Windows 8.3 short names and case-insensitive-volume
 * spellings of one dir all collapse), separator-normalized, and case-folded
 * when the filesystem folds case, so one dir always maps to one record no
 * matter how the caller spelled it. The old `path.resolve` form left a
 * symlinked spelling of an already-answered dir with its own record — the
 * duplicate-prompt bug.
 *
 * Migration: stored keys keep their identity for plain dirs — realpath
 * returns the same path in real casing (lowercase-folded on Windows as
 * before), and on case-sensitive POSIX volumes the resolve form is
 * untouched. A dir reached through a symlink (or on a case-insensitive
 * APFS volume) resolves to a new key, so its old record is simply not
 * found and the dir is asked about once more: consent re-prompt is the
 * safe direction for a record that licenses overwriting a foreign
 * statusLine.
 */
export function consentDirKey(configDir: string): string {
  const canonical = canonicalPath(configDir).split(path.sep).join('/');
  return foldsCase(canonical) ? canonical.toLowerCase() : canonical;
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
