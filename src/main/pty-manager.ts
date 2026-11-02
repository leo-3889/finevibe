import * as pty from 'node-pty';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderId } from '../shared/types';
import { LOCAL_HOST_ID } from '../shared/types';
import { parseEnvVars, partitionUserEnv, providerOwnedEnvReason } from '../shared/env-vars';
import { findConflictingEnvKeys, findConflictingLaunchFlags, tokenizeArgs } from '../shared/launch-args';
import { isRegistryHostTarget } from '../shared/ssh-host';
import { SPAWN_REJECTED_EXIT_REASON } from '../shared/constants';
import { getProvider } from './providers/registry';
import { getHost } from './hosts/host-registry';
import { hostTrustSshArgs } from './hosts/host-trust';
import { remoteLaunchSessionDir } from './launch-session-dir';
import { registerSession, registerRemoteStatus, unregisterSession } from './hook-status';
import { guardedProfileInstall } from './settings-guard';
import { getKeychainIsolationStatusAsync } from './claude-keychain';
import { isLinux, isMac, isWin, pathSep, utf8LocaleEnv } from './platform';
import { canonicalPath } from './fs-utils';
import { nvmDefaultNodeBinDir } from './providers/nvm';

const execFileP = promisify(execFile);

interface PtyInstance {
  process: pty.IPty;
  sessionId: string;
}

const ptys = new Map<string, PtyInstance>();

// Row 121 discriminating trace (archive: todos/archives/ROW-121-resize-
// forensics-2026-11-05.md): FINEVIBE_RESIZE_TRACE=1 logs spawn geometry,
// every resizePty (incl. the dropped leg), and the renderer's fits/data with
// write-queue depth. Read at module load — set in the environment, not at
// runtime. No behavior change when off.
const RESIZE_TRACE = process.env.FINEVIBE_RESIZE_TRACE === '1';
// Replacement suppresses only the old process's exit. A session-id marker can
// be consumed by a fast-exiting replacement before the old kill completes.
const replacedPtys = new WeakSet<pty.IPty>();

// Session ids whose killPty arrived while spawnPty was still awaiting (e.g.
// Copilot hook install) — the window before the PTY lands in `ptys`. Without
// this the kill is a no-op and the CLI then spawns orphaned: a live process
// with no renderer session and no exit path. spawnPty consumes the marker
// right after `ptys.set` and tears the new PTY down itself; every spawnPty
// path that returns without spawning clears it, so a stale flag can never
// kill a later re-spawn of the same id.
const pendingKills = new Set<string>();

// Session ids with a spawnPty in flight: registered at the entry of
// spawnPty and dropped when that call completes (resolve, early return or
// throw — the finally in spawnPty owns the delete). killPty records a
// pendingKill ONLY for ids in this set: a kill addressed to an id nothing
// is spawning (a session whose PTY already crashed, e.g.) is stale, and
// remembering it would tear down a future PTY resumed under the same id.
const spawningInFlight = new Set<string>();

/**
 * Get the full PATH by sourcing the user's login shell.
 * When Electron is launched from macOS Finder/Dock, process.env.PATH
 * is minimal (/usr/bin:/bin:/usr/sbin:/sbin) and misses nvm, homebrew, etc.
 * On Windows, packaged Electron apps inherit PATH from explorer.exe which
 * may be stale — we read the registry for the current PATH.
 * We resolve this once by running a login shell / reading the registry.
 */
let cachedFullPath: string | null = null;

const PATH_MARKER_BEGIN = '__VY_PATH_BEGIN__';
const PATH_MARKER_END = '__VY_PATH_END__';

/**
 * Default POSIX shell when $SHELL is unset. `/bin/zsh` is the macOS default
 * login shell; stock Linux distros (Ubuntu) ship no zsh, so the same default
 * ENOENTs the login-shell PATH probe and the shell tab there. `/bin/sh` is
 * the always-present fallback and a valid `-ilc` probe target.
 */
function defaultPosixShell(): string {
  return process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/sh');
}

/**
 * Shell for the interactive terminal tab. The default POSIX fallback is
 * `/bin/sh` (see defaultPosixShell) — a valid `-ilc` probe target, but a
 * poor interactive shell (no readline history, sparse completion); when
 * $SHELL is unset prefer `/bin/bash` on Linux if it is installed.
 */
function interactiveShell(): string {
  const fallback = defaultPosixShell();
  if (isWin || isMac || process.env.SHELL) return fallback;
  return fs.existsSync('/bin/bash') ? '/bin/bash' : fallback;
}

/**
 * Registry PATH read (audit row 73). `reg query` writes its stdout in the
 * console OEM code page (cp866 / cp932 / cp936 on Cyrillic / CJK installs)
 * while Node decoded it as UTF-8, so every non-ASCII PATH entry arrived
 * mangled and a provider installed under such a directory looked uninstalled.
 * PowerShell owns the decode instead: `[Console]::OutputEncoding` is set to
 * UTF-8 before the values are read and `ConvertTo-Json` emits both hives as
 * one JSON array (Windows PowerShell 5.1 additionally escapes non-ASCII to
 * \uXXXX, so the payload is usually pure ASCII and code-page independent).
 * Both hives come from a single spawn — a missing value comes back as null
 * and contributes nothing, which is what the old per-hive `reg query`
 * non-zero exit meant. Get-ItemProperty resolves REG_EXPAND_SZ through the
 * registry API (expanded values), so the %VAR% pass in parseRegistryPath is
 * only the fallback for names .NET could not expand.
 */
const REG_PATH_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "$s=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name Path -ErrorAction SilentlyContinue).Path",
  "$u=(Get-ItemProperty 'HKCU:\\Environment' -Name Path -ErrorAction SilentlyContinue).Path",
  'ConvertTo-Json -Compress -InputObject @($s,$u)',
].join('; ');

// PowerShell start-up (CLR + type loader) costs far more than reg.exe, so the
// old 3 s reg budget would kill it on a cold machine. Same ceiling as the
// POSIX login-shell probe below.
const REG_PATH_TIMEOUT_MS = 8000;

const REG_PATH_ARGV = ['-NoProfile', '-NonInteractive', '-Command', REG_PATH_SCRIPT];
// execSync runs through cmd.exe, so the same call needs the quoted form. The
// script carries no `"`, `%` or redirection character, so one pair of quotes
// is enough for cmd.
const REG_PATH_COMMAND = `powershell.exe -NoProfile -NonInteractive -Command "${REG_PATH_SCRIPT}"`;

/** [system, user] PATH values from the JSON payload, %VAR% expanded. */
function parseRegistryPath(payload: string): string[] {
  let decoded: unknown;
  try {
    // Redirected PowerShell output can carry a UTF-8 BOM.
    decoded = JSON.parse(payload.replace(/^\uFEFF/, '').trim());
  } catch (err) {
    console.debug('Could not parse the registry PATH payload:', err);
    return [];
  }
  return (Array.isArray(decoded) ? decoded : [decoded])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(expandRegistryVars);
}

/**
 * Row 73 follow-up: the pre-wave `reg query` read, restored as the catch
 * fallback. PowerShell fails OPEN on ConstrainedLanguage / WDAC boxes: the
 * language mode refuses the property read, `ConvertTo-Json` emits `[null,null]`
 * (or the whole command errors), and the registry contributes ZERO PATH — a
 * provider installed under a registry-only directory reads as uninstalled.
 * reg.exe is not subject to the language mode, so it still answers there.
 *
 * Decode is exactly what it was pre-wave (`utf-8` over the console's OEM code
 * page): ASCII paths — the overwhelming majority, and everything the fail-open
 * bug could hide on those locked-down boxes — survive intact; a non-ASCII
 * directory can still arrive mangled, which is the row-73 trade this fallback
 * re-accepts rather than losing the entry entirely.
 *
 * One call per hive per twin, `reg query` exiting non-zero for a missing value
 * (that hive contributes nothing — the pre-wave meaning of the catch).
 */
const REG_SYSTEM_HIVE = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const REG_USER_HIVE = 'HKCU\\Environment';

/** %VAR% names the registry left raw (Get-ItemProperty expands most of them). */
function expandRegistryVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_m: string, varName: string) => process.env[varName] || `%${varName}%`);
}

/** The PATH value out of one `reg query HK…\Path` answer. */
function parseRegQueryValue(output: string): string {
  const match = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
  return match ? expandRegistryVars(match[1].trim()) : '';
}

/** Both hives over reg.exe, joined — see the note above for when this runs. */
function registryPathViaRegQuery(): string {
  const values: string[] = [];
  for (const hive of [REG_SYSTEM_HIVE, REG_USER_HIVE]) {
    try {
      const value = parseRegQueryValue(execSync(`reg query "${hive}" /v Path`, {
        // Same per-spawn ceiling as the PowerShell read (row 73 raised it for
        // a cold machine; reg.exe answers far under it).
        encoding: 'utf-8', timeout: REG_PATH_TIMEOUT_MS, windowsHide: true,
      }));
      if (value) values.push(value);
    } catch (err) {
      console.debug(`Could not read PATH from ${hive}:`, err);
    }
  }
  return values.join(pathSep);
}

export function getRegistryPath(): string {
  if (!isWin) return '';
  let values: string[] = [];
  try {
    values = parseRegistryPath(execSync(REG_PATH_COMMAND, {
      encoding: 'utf-8', timeout: REG_PATH_TIMEOUT_MS, windowsHide: true,
    }));
  } catch (err) {
    // No PowerShell at all (blocked by AppLocker): the reg query fallback below
    // is the one left standing.
    console.debug('Could not read PATH from the registry:', err);
  }
  // Empty payload is the same failure with a different face — constrained
  // language mode STARTS PowerShell and lets it print nothing useful.
  if (values.length > 0) return values.join(pathSep);
  return registryPathViaRegQuery();
}

/** Reset cached PATH (used after install-then-retry flows and in tests). */
export function resetPathCache(): void {
  cachedFullPath = null;
}

export function getFullPath(): string {
  if (cachedFullPath) return cachedFullPath;

  const currentPath = process.env.PATH || '';

  if (isWin) {
    const home = os.homedir();
    const extraDirs = [
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, '.local', 'bin'),
    ];

    // Read the up-to-date PATH from the Windows registry
    const registryPath = getRegistryPath();

    const pathSet = new Set([
      ...currentPath.split(pathSep),
      ...registryPath.split(pathSep),
    ]);
    for (const dir of extraDirs) {
      pathSet.add(dir);
    }
    cachedFullPath = Array.from(pathSet).join(pathSep);
    return cachedFullPath;
  }

  const shell = defaultPosixShell();

  // -i is required: nvm exports PATH from ~/.zshrc, only sourced for interactive shells.
  try {
    const shellPath = execSync(
      `${shell} -ilc 'echo "${PATH_MARKER_BEGIN}${'${PATH}'}${PATH_MARKER_END}"'`,
      {
        encoding: 'utf-8',
        timeout: 8000,
        env: { ...process.env, HOME: os.homedir() },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const match = shellPath.match(
      new RegExp(`${PATH_MARKER_BEGIN}([\\s\\S]*?)${PATH_MARKER_END}`),
    );
    if (match && match[1]) {
      cachedFullPath = match[1].trim();
      return cachedFullPath;
    }
  } catch (err) { console.warn('Failed to resolve PATH from login shell:', err); }

  const home = os.homedir();
  const extraDirs = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/usr/local/sbin',
    '/opt/homebrew/sbin',
  ];
  const nvmBin = nvmDefaultNodeBinDir();
  if (nvmBin) extraDirs.push(nvmBin);

  const pathSet = new Set(currentPath.split(pathSep));
  for (const dir of extraDirs) {
    pathSet.add(dir);
  }
  cachedFullPath = Array.from(pathSet).join(pathSep);
  return cachedFullPath;
}
/**
 * S2-02: async twin of getFullPath. The sync one blocks the main thread
 * for the login-shell spawn (POSIX: `execSync($SHELL -ilc …)`, 0.2-1.5 s
 * typical on nvm/p10k setups) or the PowerShell registry read (Windows)
 * — the PA-01 boot probe fan-out calls it on every launch
 * (the disk-cache freshness gate needs the PATH snapshot), so the whole
 * boot chain paid that spawn synchronously after createWindow. Same cache,
 * same composition, same fallback; concurrent callers share one promise.
 */
let pendingFullPath: Promise<string> | null = null;

export function getFullPathAsync(): Promise<string> {
  if (cachedFullPath) return Promise.resolve(cachedFullPath);
  if (pendingFullPath) return pendingFullPath;
  pendingFullPath = (async (): Promise<string> => {
    const currentPath = process.env.PATH || '';
    const home = os.homedir();
    if (isWin) {
      let registryValues: string[] = [];
      try {
        const { stdout } = await execFileP('powershell.exe', REG_PATH_ARGV, {
          encoding: 'utf-8', timeout: REG_PATH_TIMEOUT_MS, windowsHide: true,
        });
        registryValues = parseRegistryPath(stdout);
      } catch {
        // PowerShell missing/refused: the reg query fallback below is the one
        // left standing (mirrors getRegistryPath, including the empty-payload
        // case constrained-language mode produces).
      }
      if (registryValues.length === 0) {
        registryValues = (await Promise.all([REG_SYSTEM_HIVE, REG_USER_HIVE].map(async (hive) => {
          try {
            const { stdout } = await execFileP('reg', ['query', hive, '/v', 'Path'], {
              encoding: 'utf-8', timeout: REG_PATH_TIMEOUT_MS, windowsHide: true,
            });
            return parseRegQueryValue(stdout);
          } catch {
            return '';
          }
        }))).filter(Boolean);
      }
      const pathSet = new Set([
        ...currentPath.split(pathSep),
        ...registryValues.flatMap((value) => value.split(pathSep)),
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, '.local', 'bin'),
      ]);
      cachedFullPath = Array.from(pathSet).join(pathSep);
      return cachedFullPath;
    }
    const shell = defaultPosixShell();
    try {
      // ponytail (review 8dddea9a ℹ️6): the sync twin silences stderr via
      // stdio:'ignore'; execFile's async API ALWAYS pipes stdout+stderr into
      // maxBuffer (1 MB each) and its typing refuses a stdio option — the
      // parity is inexpressible short of spawn+manual pipes. Ceiling: a login
      // shell writing >1 MB on the probe's stderr rejects → fallback PATH
      // (nvm bins lost for that spawn). Upgrade path: raw spawn if a real
      // profile ever trips it.
      const { stdout } = await execFileP(
        shell,
        ['-ilc', `echo "${PATH_MARKER_BEGIN}${'${PATH}'}${PATH_MARKER_END}"`],
        {
          encoding: 'utf-8',
          timeout: 8000,
          env: { ...process.env, HOME: os.homedir() },
        },
      );
      const match = stdout.match(new RegExp(`${PATH_MARKER_BEGIN}([\\s\\S]*?)${PATH_MARKER_END}`));
      if (match && match[1]) {
        cachedFullPath = match[1].trim();
        return cachedFullPath;
      }
    } catch (err) { console.warn('Failed to resolve PATH from login shell:', err); }
    const extraDirs = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      '/usr/local/sbin',
      '/opt/homebrew/sbin',
    ];
    const nvmBin = nvmDefaultNodeBinDir();
    if (nvmBin) extraDirs.push(nvmBin);
    const pathSet = new Set(currentPath.split(pathSep));
    for (const dir of extraDirs) pathSet.add(dir);
    cachedFullPath = Array.from(pathSet).join(pathSep);
    return cachedFullPath;
  })().finally(() => { pendingFullPath = null; });
  return pendingFullPath;
}


/**
 * Fill in a UTF-8 locale when the environment names no charset, so spawned CLIs
 * and shells don't land in the C locale. A Finder/Dock-launched macOS app
 * inherits no LANG, which mangles multi-byte output and drops macOS text APIs
 * back to the legacy system encoding (#157, #160).
 *
 * Bare `C`/`POSIX` does not count as a deliberate choice — it is the very locale
 * that produces the mojibake, and a .desktop entry or systemd unit exporting
 * `LANG=C` would otherwise pin it. Resolution follows POSIX precedence, so an
 * `LC_ALL=C` really does mean the session is in the C locale.
 */
export function withUtf8Locale<T extends Record<string, string | undefined>>(env: T): T {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (isWin || (locale && !/^(C|POSIX)$/i.test(locale))) return env;
  return { ...env, ...utf8LocaleEnv };
}

/**
 * Make an argument safe to place on a cmd.exe command line.
 *
 * node-pty (`windowsPtyAgent.argsToCommandLine`) quotes an argument only when it
 * contains a space or a tab. A whitespace-free token carrying `&`, `|`, `<`, `>`
 * or `^` is therefore emitted raw and cmd.exe interprets it — `foo&calc.exe`
 * runs calc.exe. Wrapping the whole argument in double quotes makes cmd treat it
 * as literal text, and node-pty leaves an already-quoted argument untouched.
 *
 * A double quote, by contrast, CANNOT be conveyed through cmd.exe at all: cmd
 * toggles its quoted state on every `"` and honours no escape for it. `\` is not
 * an escape character to cmd, so `\"` does not yield a literal quote — it CLOSES
 * the quoted region and leaves everything after it live. Verified against a real
 * cmd.exe: the raw form `x"y&echo pwned>mk` is inert because the stray quote
 * opens a quoted region over the payload, while the `\"`-escaped form executes
 * it. Escaping is therefore worse than doing nothing.
 *
 * So an argument containing `"` is rejected rather than mangled. The rejection
 * is a `LaunchSpecError` (audit R114): the pane contract is the actionable
 * message plus the spawn-rejected exit, so it must survive as this class all
 * the way to `spawnPty`'s spec-rejection branch — a plain Error reaches the
 * catch-all there and the user loses the per-provider hint below. Silently
 * producing an injectable command line is not an option either.
 *
 * Residual, accepted: `%VAR%` still expands inside double quotes. That leaks an
 * environment value into the argument; it is not code execution, so a percent
 * sign stays legal rather than rejecting legitimate arguments that contain one.
 */
const CMDEXE_METACHARS = /[&|<>^]/;

function quoteArgForCmdExe(arg: string): string {
  if (arg.includes('"')) {
    const shown = arg.length > 80 ? `${arg.slice(0, 77)}...` : arg;
    throw new LaunchSpecError(
      'Cannot pass an argument containing a double quote through cmd.exe: cmd ' +
        'has no escape for a literal quote, so it cannot be quoted safely. ' +
        'A provider whose binary is a native .exe (no cmd.exe wrapper) accepts ' +
        'the same argument; so does a Pi-compatible provider (Pi/Pi-Bolt/OMP), ' +
        'which loads a prompt file instead of prompt text. ' +
        `Offending argument: ${JSON.stringify(shown)}`
    );
  }
  return CMDEXE_METACHARS.test(arg) ? `"${arg}"` : arg;
}

/** The launch target parsed out of an npm-style .cmd/.bat shim. */
interface ShimTarget {
  executable: string;
  /** Shim-side argv that precedes the caller's args (the node script path). */
  prefixArgs: string[];
}

/**
 * Recover the real launch target from an npm-style .cmd/.bat shim so the
 * spawn can skip cmd.exe entirely.
 *
 * cmd.exe cannot transport a multi-line argument: it ends its command at the
 * first newline (the prompt is truncated to line 1), strips wrapper quotes
 * and word-splits, and runs leftover fragments as commands. That breaks every
 * multi-line startup prompt — Ask AI embeds the selected code in fences, so
 * npm-shimmed CLIs (codex.cmd, pi-bolt.cmd, …) received only the first line.
 * The target is a native exe (node.exe / tool.exe), so spawning it directly
 * carries argv intact: CreateProcess + CommandLineToArgvW preserve newlines
 * and escaped quotes inside a quoted token.
 *
 * Parsing is deliberately narrow — only the npm cmd-shim template
 * `"%_prog%" "%dp0%\…\cli.js" %*` and the hand-written `"target.exe" %*`
 * form, expanding only `%dp0%`/`%~dp0%` (shim dir) and `%_prog%` (node.exe
 * beside the shim, else bare `node`, mirroring the shim's IF EXIST). Any
 * unreadable shim, unknown variable, non-exe target, missing script, or
 * unexpected token count returns null and the caller falls back to the
 * cmd.exe wrapper (the previous behavior).
 *
 * `body` is the shim file's contents; the sync loader reads it, the spawn lane
 * hands in a pre-read body (see {@link resolveCmdShimTargetAsync}).
 */
function parseCmdShim(shimPath: string, body: string): ShimTarget | null {
  // Shims are tiny one-liners; anything larger is not a shim (or is binary).
  if (body.length > 64 * 1024) return null;
  const launchLine = body.split(/\r?\n/).filter((l) => l.includes('%*')).pop();
  if (!launchLine) return null;
  const quoted = [...launchLine.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (quoted.length === 0 || quoted.length > 2) return null;
  // All quoted tokens must sit on the launch, before the %* passthrough.
  if (launchLine.lastIndexOf('"') > launchLine.lastIndexOf('%*')) return null;

  const shimDir = path.dirname(shimPath);
  const expand = (token: string): string | null => {
    if (/%_prog%/i.test(token)) {
      if (token.toLowerCase() !== '%_prog%') return null; // %_prog% with a suffix — don't guess
      const local = path.join(shimDir, 'node.exe');
      return fs.existsSync(local) ? local : 'node';
    }
    const t = path.normalize(token.replace(/%~?dp0%?/gi, shimDir + path.sep));
    if (/%[^%]*%/.test(t)) return null; // unknown cmd variable — don't guess
    return t;
  };

  const executable = expand(quoted[0]);
  if (!executable) return null;
  const ext = path.extname(executable).toLowerCase();
  if (ext !== '' && ext !== '.exe') return null;
  let resolved = executable;
  if (/[\\/]/.test(resolved)) {
    if (!fs.existsSync(resolved)) return null;
  } else {
    // Bare name: cmd resolved it against the shim dir first — honour that.
    const beside = path.join(shimDir, executable);
    if (fs.existsSync(beside)) resolved = beside;
  }
  const prefixArgs: string[] = [];
  if (quoted.length === 2) {
    const script = expand(quoted[1]);
    if (!script || !/\.(?:js|mjs|cjs)$/i.test(script)) return null;
    if (!fs.existsSync(script)) return null;
    prefixArgs.push(script);
  }
  return { executable, prefixArgs };
}

/** Sync shim loader: read + parse (the non-spawn callers). */
function resolveCmdShimTarget(shimPath: string): ShimTarget | null {
  let body: string;
  try {
    body = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  return parseCmdShim(shimPath, body);
}

/**
 * Row 17: spawn-lane shim read — the file body comes off `fs.promises`, so the
 * per-spawn shim read leaves the main thread.
 *
 * ponytail: the three `fs.existsSync` checks inside {@link parseCmdShim} stay
 * sync (node.exe beside the shim, the target, the script): three stats on a
 * Windows spawn, sub-ms, and the parser is shared with the sync callers
 * (`resolveWindowsShell`, the shim-parity tests). Ceiling: if a shim ever lives
 * on a slow mount, thread a stat-injecting loader through the parser and give
 * the async lane `fs.promises.stat`.
 */
async function resolveCmdShimTargetAsync(shimPath: string): Promise<ShimTarget | null> {
  let body: string;
  try {
    body = await fs.promises.readFile(shimPath, 'utf8');
  } catch {
    return null;
  }
  return parseCmdShim(shimPath, body);
}

/** The npm-style shim file a launch target resolves to, '' when it is not one. */
function shimPathFor(shell: string): string {
  const ext = path.extname(shell).toLowerCase();
  // .cmd/.bat shims carry their real target; an extensionless npm launcher
  // resolves via PATHEXT to the <name>.cmd beside it — parse the same file.
  if (ext === '.cmd' || ext === '.bat') return shell;
  return ext === '' ? `${shell}.cmd` : '';
}

/**
 * The non-shim answer of {@link resolveWindowsShell}: .ps1 needs PowerShell,
 * everything else (unparseable shims, bare names, extensionless paths) is
 * wrapped with cmd.exe so CreateProcess doesn't choke on non-PE binaries.
 * Every token must be quoted for cmd.exe — see quoteArgForCmdExe.
 */
function wrapForShell(shell: string, args: string[]): { shell: string; args: string[] } {
  if (path.extname(shell).toLowerCase() === '.ps1') {
    return {
      shell: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shell, ...args],
    };
  }
  return {
    shell: 'cmd.exe',
    args: ['/c', quoteArgForCmdExe(shell), ...args.map(quoteArgForCmdExe)],
  };
}

/**
 * Row 17: the spawn-lane twin of {@link resolveWindowsShell} — identical
 * branch order and identical output, with the shim body read off
 * `fs.promises.readFile` so the Windows spawn path runs no sync file read.
 * A `quoteArgForCmdExe` rejection surfaces as a rejection of this promise,
 * which `spawnPty` catches in the same branch that caught the sync throw.
 */
export async function resolveWindowsShellAsync(
  shell: string,
  args: string[]
): Promise<{ shell: string; args: string[] }> {
  if (!isWin) return { shell, args };
  // .exe files can be spawned directly by CreateProcess
  if (path.extname(shell).toLowerCase() === '.exe') return { shell, args };
  const shimPath = shimPathFor(shell);
  const target = shimPath ? await resolveCmdShimTargetAsync(shimPath) : null;
  if (target) return { shell: target.executable, args: [...target.prefixArgs, ...args] };
  return wrapForShell(shell, args);
}

/**
 * On Windows, .cmd/.bat and .ps1 files cannot be spawned directly by node-pty
 * (CreateProcess returns error 193). Prefer spawning the shim's real target
 * directly (see resolveCmdShimTarget); fall back to cmd.exe or powershell.exe.
 */
export function resolveWindowsShell(
  shell: string,
  args: string[]
): { shell: string; args: string[] } {
  if (!isWin) return { shell, args };
  // .exe files can be spawned directly by CreateProcess
  if (path.extname(shell).toLowerCase() === '.exe') return { shell, args };
  const shimPath = shimPathFor(shell);
  const target = shimPath ? resolveCmdShimTarget(shimPath) : null;
  if (target) return { shell: target.executable, args: [...target.prefixArgs, ...args] };
  return wrapForShell(shell, args);
}

/**
 * The effective session storage mode for a launch. T2 always resolves
 * 'default' (the profile's own sessions tree); 'custom-dir' and
 * 'nonpersistent' are rejected pre-spawn until per-launch storage is
 * tracked end-to-end.
 */
type SessionStorageMode = 'default' | 'custom-dir' | 'nonpersistent';

/**
 * One effective launch: the executable, argv, environment,
 * provider/profile identity and storage mode a session is spawned with.
 * Resolved once in spawnPty before any side effect; the child environment
 * and every lifecycle reader must agree on this single spec.
 */
interface LaunchSpec {
  executable: string;
  argv: string[];
  env: Record<string, string>;
  providerId: ProviderId;
  /** Pinned profile config dir; undefined = the provider's default agent dir. */
  configDir: string | undefined;
  /** Effective session storage mode for this launch. */
  storageMode: SessionStorageMode;
}

/** Thrown when a launch request uses options FineVibe cannot track. */
export class LaunchSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchSpecError';
  }
}

/** POSIX single-quote quoting for one token of the remote command string. */
function posixQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The provider binary for a launch, keyed per host (per-host providers plan
 * §2). `hostId` absent/'local' → the existing local resolution (PATH/nvm
 * probes + BinaryCache). A registry host resolves from the enrollment-time
 * prereq probe — `HostRecord.prerequisites[providerId].path`, an absolute
 * path ON THE HOST; local `resolveBinary` never runs for a remote session.
 * Throws (LaunchSpecError → spawn-rejected pane message) when the host lacks
 * the tool.
 */
export function resolveProviderBinary(providerId: ProviderId, hostId?: string): string {
  if (hostId === undefined || hostId === LOCAL_HOST_ID) return getProvider(providerId).resolveBinaryPath();
  const record = getHost(hostId);
  if (!record) {
    throw new LaunchSpecError(`Unknown host ${JSON.stringify(hostId)} — enroll it in Settings → Hosts first.`);
  }
  const prereq = record.prerequisites?.[providerId];
  if (!prereq?.ok || !prereq.path) {
    throw new LaunchSpecError(
      `Host ${JSON.stringify(record.name)} has no ${providerId} binary (prereq probe: ${prereq ? 'missing' : 'never probed'}) — re-probe its tools in Settings → Hosts.`,
    );
  }
  return prereq.path;
}

/**
 * Row 17: the spawn-lane twin of {@link resolveProviderBinary} — same rule, no
 * synchronous probe. `spawnPty` awaits this and hands the answer to
 * `resolveLaunchSpec` as `binaryPath`; the local branch runs
 * `provider.resolveBinaryPathAsync` (async `which`/`npm prefix`, same cache),
 * falling back to the sync resolver for providers that do not implement it
 * (tests, future registrations). A registry host answers from the in-memory
 * enrollment record, so the sync function's `LaunchSpecError` applies verbatim.
 */
export async function resolveProviderBinaryAsync(providerId: ProviderId, hostId?: string): Promise<string> {
  // A registry host resolves from the in-memory enrollment record — no local
  // probe runs, so the sync rule (and its LaunchSpecError) applies verbatim.
  if (hostId !== undefined && hostId !== LOCAL_HOST_ID) return resolveProviderBinary(providerId, hostId);
  const provider = getProvider(providerId);
  return provider.resolveBinaryPathAsync ? provider.resolveBinaryPathAsync() : provider.resolveBinaryPath();
}

/**
 * The provider launch command as one string for the remote login shell:
 * the prereq's recorded path — an ABSOLUTE path on the host, from
 * `HostRecord.prerequisites` (probed there; never a local path, never
 * reduced to a basename; row 113) — plus every argument, each POSIX-quoted.
 * A provider with no ok prereq is refused upstream (`resolveProviderBinary`).
 * The Windows `.CMD`/`.EXE` stem rule belongs to the LOCAL lane
 * (`resolveWindowsShell`), not this one.
 */
function remoteCommand(bin: string, argv: string[], homeTokens: Set<string>): string {
  // `homeTokens` (the home-relative session dir, and on a resume the
  // transcript re-anchored under it) are emitted "…"-quoted so the remote
  // login shell expands their leading `~` — single quotes (posixQuote) would
  // hand the CLI a literal `~` directory. Each token is the sanitized
  // remoteLaunchSessionDir spelling ([A-Za-z0-9_./-] after `~/`) plus a
  // sanitized transcript basename, so double quoting carries no expansion
  // risk.
  return [bin, ...argv]
    .map((t) => (homeTokens.has(t) ? `"${t.replace(/^~/, '$HOME')}"` : posixQuote(t)))
    .join(' ');
}

/** Providers that steer their transcripts into a per-launch `--session-dir`. */
function usesSessionDirArgv(providerId: ProviderId): providerId is 'pi' | 'pi-bolt' | 'omp' {
  return providerId === 'pi' || providerId === 'pi-bolt' || providerId === 'omp';
}

/**
 * Resume flags whose value the Pi-compatible CLIs accept as a transcript path
 * OR an id looked up in `--session-dir` (`pi --session <path|id>`,
 * `omp --resume <path|id>`).
 */
const REMOTE_RESUME_FLAGS = ['--session', '--resume'];

/**
 * Swap a locally-derived `--session-dir` value for the host-side spelling,
 * and re-anchor a path-shaped resume token under it (audit row 97).
 *
 * The provider resolves its resume target to the CONTROLLER's transcript file
 * (pi/omp `resumeTarget`); on the host that path does not exist, and both
 * CLIs read a missing `--session|--resume <path>` as "start this file" — a
 * blank transcript under the pinned id, silently. The transcript itself IS on
 * the host, under the same basename in the host session dir (the mirror
 * resolves it there), so a basename swap is enough. A bare id needs nothing:
 * the CLIs look it up in `--session-dir`, which this function already swapped.
 */
function remoteSessionDirArgv(argv: string[], hostDir: string): string[] {
  const out = [...argv];
  let changed = false;
  const i = out.indexOf('--session-dir');
  if (i >= 0 && i + 1 < argv.length) {
    out[i + 1] = hostDir;
    changed = true;
  }
  for (const flag of REMOTE_RESUME_FLAGS) {
    const j = out.indexOf(flag);
    if (j < 0 || j + 1 >= argv.length) continue;
    const value = out[j + 1];
    // Split on BOTH separators: the controller path is Windows-style on the
    // primary deployment (Windows controller → Linux host), where
    // path.basename on a POSIX build would return the whole string.
    const base = value.split(/[/\\]/).pop() ?? '';
    // `base !== value` is the path-shape test: a bare id has no separator.
    // ponytail: a basename outside [A-Za-z0-9._-] keeps the old (broken) local
    // spelling rather than escaping — our own transcript names
    // (`<stamp>_<cliSessionId>.jsonl`) never hit that branch, and the ceiling
    // is one blank resume, not an injectable command line.
    if (base && base !== value && /^[A-Za-z0-9._-]+$/.test(base)) {
      out[j + 1] = `${hostDir}/${base}`;
      changed = true;
    }
  }
  return changed ? out : argv;
}

/**
 * Env assignments the remote command must carry. ssh runs the remote command
 * under a fresh login shell — the local child env (pty.spawn's `env`)
 * applies to the ssh client only, so a profile's config-dir pointer (Pi/OMP
 * `PI_CODING_AGENT_DIR`, Claude `CLAUDE_CONFIG_DIR`) must ride inside the
 * command string. Full env forwarding is a SendEnv/AcceptEnv contract
 * (sshd-side allowlist) — out of T1 scope.
 * // ponytail: config-dir vars only; forward the rest when a concrete
 * consumer needs it (then move to ssh SendEnv, not string-prefixing).
 */
const REMOTE_ENV_KEYS = ['PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_IDE_SESSION_ID', 'FINEVIBE_SESSION_ID'];
/**
 * Session-id env values become FILE PATHS on the host (the merged hooks
 * write `$HOME/.finevibe/run/$<ID>.status` — the id lands in a `mv` target),
 * and the id is renderer-supplied. The poll side gates the same id with
 * UI_SESSION_ID_RE (hook-status.ts); this is the spawn-side gate (audit T2
 * #3): a hostile id is DROPPED — the session launches, hooks just no longer
 * resolve a sidecar path (the host hook's `echo > "$.../<empty>.status"`
 * targets the fixed dir; no attacker-controlled path component).
 */
const SESSION_ID_ENV_KEYS = new Set(['CLAUDE_IDE_SESSION_ID', 'FINEVIBE_SESSION_ID']);
const SESSION_ID_VALUE_RE = /^[A-Za-z0-9_-]{1,128}$/;
function remoteEnvPrefix(env: Record<string, string>): string {
  return REMOTE_ENV_KEYS.filter(
    (k) => env[k] !== undefined && (!SESSION_ID_ENV_KEYS.has(k) || SESSION_ID_VALUE_RE.test(env[k])),
  )
    .map((k) => `${k}=${posixQuote(env[k])}`)
    .join(' ');
}

/**
 * Resolve the single effective launch spec for a session: executable,
 * argv, environment, provider/profile identity and storage mode.
 *
 * Profile isolation: the providers' buildEnv strips inherited native
 * profile/storage selectors, and partitionUserEnv drops user env that
 * would undo the pinned profile. Unsupported options (storage overrides,
 * profile/session-identity flags in the extra args) are rejected here —
 * before any side effect — with an actionable message.
 */
export function resolveLaunchSpec(params: {
  sessionId: string;
  cliSessionId: string | null;
  isResume: boolean;
  extraArgs: string;
  providerId: ProviderId;
  initialPrompt?: string;
  systemPrompt?: string;
  envVars: string;
  configDir?: string;
  /**
   * Registry host id (per-host providers plan §2). Absent/'local' → local
   * binary resolution; a remote id resolves the binary from the host's
   * prereq probe and ssh-wraps the launch through the registry record
   * (user@host, port). The legacy free-text `sshHost` wire was retired
   * 2026-10-28 (parent §11) — the registry is the only remote spelling.
   */
  hostId?: string;
  /**
   * Row 17: the caller's PRE-RESOLVED login-shell PATH — `spawnPty` awaits
   * `getFullPathAsync()` and passes it in, so the spawn lane runs no
   * synchronous login-shell/registry probe. Absent → the providers probe
   * synchronously, the correct answer for the sync callers (lead-review, tests).
   */
  pathEnv?: string;
  /**
   * Row 17: the caller's PRE-RESOLVED provider binary — `spawnPty` awaits
   * `resolveProviderBinaryAsync()` (the cold path spawns `which`/`npm prefix`).
   * Absent → resolved here, the correct answer for the sync callers.
   */
  binaryPath?: string;
}): LaunchSpec {
  const {
    sessionId, cliSessionId, isResume, extraArgs, providerId, initialPrompt,
    systemPrompt, envVars, configDir, hostId, pathEnv, binaryPath,
  } = params;
  const isRemoteHost = hostId !== undefined && hostId !== LOCAL_HOST_ID;
  const provider = getProvider(providerId);
  const issues: string[] = [];

  const userEnv = parseEnvVars(envVars);
  for (const key of findConflictingEnvKeys(userEnv, isWin)) {
    issues.push(
      `Environment variable ${key} is not supported: FineVibe tracks sessions in the profile's default storage, ` +
        'and a custom session dir would hide them from history, search and resume. Remove it from the session environment and start again.',
    );
  }

  const env = provider.buildEnv(sessionId, withUtf8Locale({ ...process.env }) as Record<string, string>, { configDir, pathEnv });
  // User-provided env vars are merged last so they can override provider-set
  // vars like PATH ("user vars win") — EXCEPT the vars a provider owns for
  // profile isolation, which would silently repoint the session at another
  // login's config tree. Those are dropped and reported rather than applied.
  const { allowed: userAllowed, dropped } = partitionUserEnv(userEnv, isWin);
  if (dropped.length > 0) {
    console.warn(
      `Ignoring provider-owned env var(s) for session ${sessionId}: ` +
        dropped.map((key) => `${key} (${providerOwnedEnvReason(key)})`).join(', ') +
        ' — the pinned profile owns these; remove them from the session environment.',
    );
  }
  Object.assign(env, userAllowed);

  // Conflict detection runs on the user's extra args only — never on the
  // flags FineVibe itself adds (e.g. its own --session/--resume).
  for (const conflict of findConflictingLaunchFlags(tokenizeArgs(extraArgs))) {
    issues.push(`${conflict.raw}: ${conflict.reason}`);
  }

  if (issues.length > 0) {
    throw new LaunchSpecError(
      `Unsupported launch options for this session:\n${
        issues.map((issue) => `  - ${issue}`).join('\n')
      }\nRemove the options above and start the session again.`,
    );
  }

  const base: LaunchSpec = {
    executable: binaryPath ?? resolveProviderBinary(providerId, hostId),
    // `remote` reaches the providers that can hand a quote-bearing prompt to
    // the CLI as a FILE (see systemPromptArg): on an SSH host a local path is
    // unreadable, so the value must stay a literal argument there.
    argv: provider.buildArgs({
      sessionId,
      cliSessionId,
      isResume,
      extraArgs,
      initialPrompt,
      systemPrompt,
      remote: isRemoteHost,
    }),
    env,
    providerId,
    configDir,
    storageMode: 'default',
  };
  if (isRemoteHost) {
    // Registry-host launch (per-host providers plan §2): the binary is the
    // host's prereq path (base.executable — an absolute path on the host,
    // used verbatim, never a local basename), and the wrap targets the
    // record's user@host:port. The record fields are registry-validated.
    const record = getHost(hostId!)!;
    // Registry-validated target: isRegistryHostTarget matches the record's
    // own gate, incl. the bracketed IPv6 spelling the registry stores on
    // purpose (audit T1 #2).
    if (!isRegistryHostTarget(record.user, record.host)) {
      throw new LaunchSpecError(`Host ${JSON.stringify(record.name)} has an invalid user/host — re-save it in Settings → Hosts.`);
    }
    const prefix = remoteEnvPrefix(base.env);
    // Host-side session dir (audit T2 #5): the same derivation the transcript
    // mirror uses, swapped into the provider argv, plus a cheap mkdir guard
    // (the CLI's local flow pre-creates the dir; the host's must exist too).
    let argv = base.argv;
    let mkdir = '';
    let homeTokens = new Set<string>();
    if (usesSessionDirArgv(providerId)) {
      const hostDir = remoteLaunchSessionDir(providerId, sessionId);
      argv = remoteSessionDirArgv(base.argv, hostDir);
      if (argv !== base.argv) {
        // Every host-derived token (the dir, and a resume path re-anchored
        // under it) carries the leading `~` that the login shell must expand.
        homeTokens = new Set(argv.filter((t) => t === hostDir || t.startsWith(`${hostDir}/`)));
        mkdir = `mkdir -p "${hostDir.replace(/^~/, '$HOME')}" && `;
      }
    }
    const cmd = `${mkdir}${prefix ? `${prefix} ` : ''}${remoteCommand(base.executable, argv, homeTokens)}`;
    // Row 35: the app's ssh reads FineVibe's own per-host trust store (seeded at
    // enrollment from the approved pin's key) instead of the user's known_hosts.
    // No seeded file → no options → the user's store, as before.
    return {
      ...base,
      executable: 'ssh',
      argv: ['-tt', ...hostTrustSshArgs(record), '-p', String(record.port), '--', `${record.user}@${record.host}`, cmd],
    };
  }
  return base;
}

export async function spawnPty(
  sessionId: string,
  cwd: string,
  cliSessionId: string | null,
  isResume: boolean,
  extraArgs: string,
  providerId: ProviderId,
  initialPrompt: string | undefined,
  systemPrompt: string | undefined,
  envVars: string,
  onData: (data: string) => void,
  // `spawnRejectedReason` is set only by the pre-spawn rejections below: no PTY
  // ever existed for this session, so the exit is not a process exit. Real PTY
  // exits leave it undefined.
  onExit: (exitCode: number, signal?: number, pid?: number, spawnRejectedReason?: string) => void,
  configDir?: string,
  hostId?: string
): Promise<void> {
  // Register the in-flight spawn BEFORE any side effect: the window
  // between this request and the PTY landing in `ptys` is exactly where a
  // killPty must leave a pendingKill (see spawningInFlight). The finally
  // covers every exit — resolve, early return and throw — so an id can
  // never stay marked in flight after its spawn is gone.
  spawningInFlight.add(sessionId);
  try {
    // Resolve the single effective launch spec (executable, argv, env,
    // profile identity, storage mode) before ANY side effect — no session
    // registration, hook install, PTY kill or spawn. Unsupported
    // profile/storage/session options fail here with an actionable message
    // instead of desyncing the child from the transcript readers.
    // The rejection goes through onData + onExit (not a throw) because the
    // renderer fires pty.create without awaiting; the exit callback tears
    // down the watcher/sync state registered for this session. The sentinel
    // reason says "no PTY ever existed", so the renderer keeps the pane open
    // with this message readable instead of archiving a crash for a session
    // that never spawned.
    let spec: LaunchSpec;
    let spawnCommand: { shell: string; args: string[] };
    try {
      // Row 17: the two spawn-lane probes run BEFORE the spec is composed, off
      // the main thread. The PATH probe is `execSync($SHELL -ilc …)` (0.2-1.5 s
      // on nvm/p10k boxes) or the Windows registry read; the binary probe
      // spawns `which` (3 s cap) and, on Windows, `npm prefix -g` (5 s cap) on
      // every provider's FIRST launch of an app run (the boot fan-out warms the
      // availability cache, not the per-provider binary memo). Both shared
      // their cache with the sync lane, so this changes the thread, not the
      // answer; concurrent launches share the in-flight PATH promise.
      const [pathEnv, binaryPath] = await Promise.all([
        getFullPathAsync(),
        resolveProviderBinaryAsync(providerId, hostId),
      ]);
      spec = resolveLaunchSpec({ sessionId, cliSessionId, isResume, extraArgs, providerId, initialPrompt, systemPrompt, envVars, configDir, hostId, pathEnv, binaryPath });
      // Audit R114: the Windows shell wrap is part of the SPEC, not part of the
      // spawn. quoteArgForCmdExe rejects an argument carrying a literal `"` (cmd
      // has no escape for one) and throws a LaunchSpecError; resolving it HERE
      // puts that rejection in the branch below — the pane message plus the
      // spawn-rejected exit — before this session is registered or any hook is
      // installed. Resolved after those side effects it escaped as a rejection
      // of a channel the renderer never awaits: a blank pane, and the only
      // readable reason was the generic `Failed to prepare the launch: Error: …`
      // (the per-provider hint about a native-.exe binary or a Pi-compatible
      // prompt file was lost).
      spawnCommand = await resolveWindowsShellAsync(spec.executable, spec.argv);
    } catch (err) {
      // Nothing will spawn for this session; drop any kill that arrived for
      // it so a later re-spawn of the same id is not killed by a stale flag.
      pendingKills.delete(sessionId);
      const message = err instanceof LaunchSpecError ? err.message : `Failed to prepare the launch: ${err}`;
      onData(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      onExit(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
      return;
    }

    // Remote-host sessions poll their status sidecar on the host over the
    // sftp seam (per-host providers plan §3); local ones keep the STATUS_DIR
    // watcher. registerSession is implied by registerRemoteStatus.
    if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
      registerRemoteStatus(sessionId, hostId);
    } else {
      registerSession(sessionId);
    }

    const provider = getProvider(providerId);

    // Copilot CLI loads hooks from <cwd>/.github/hooks/*.json, so we must
    // install the hook file before spawning the binary. Other providers use
    // global config and are already handled at app boot.
    if (providerId === 'copilot') {
      try {
        await provider.installHooks(null, cwd);
      } catch (err) {
        console.warn('Failed to install Copilot hooks for project:', cwd, err);
      }
    }

    // Profile support: a Claude session bound to a profile uses an isolated
    // config dir, so FineVibe's hooks + statusLine (boot-installed into ~/.claude)
    // must also be installed there or cost/activity tracking silently breaks.
    // The install goes through settings-guard's consent gate (P1-14): hooks
    // are additive and always installed, the statusLine is installed only for
    // a fresh/owned dir or under a Replace consent for the exact foreign
    // command — a prior Keep is honored and a first-run foreign statusLine is
    // never silently overwritten. Spawn is a hot path, so the consent dialog
    // never fires here: the per-session banner is the profile's consent
    // surface (Fix Settings repairs this dir, P2-127; dismissal records a Keep).
    // Idempotent, mirroring the per-spawn Copilot install above.
    // Guardrail: on macOS, older Claude Code builds reuse a single keychain entry
    // ("Claude Code-credentials") for every config dir, so logging into one
    // profile silently overwrites every other profile's token — the accounts
    // bleed into each other (anthropics/claude-code#20553). Don't spawn a profile
    // session when isolation is known-broken; surface why in the pane and exit
    // rather than running under a config dir whose login isn't actually separate.
    // ('unknown' — a newer build we can't yet confirm — is allowed, never
    // falsely blocked.) The reason is written via onData (not thrown) because the
    // renderer fires pty.create without awaiting, so a throw would be a swallowed
    // rejection leaving a blank pane — and a plain exit code would read as a
    // crash, so the reason goes out as the spawn-rejected sentinel and the
    // renderer leaves the pane up.
    if (providerId === 'claude' && configDir && (await getKeychainIsolationStatusAsync()).status === 'unsupported') {
      pendingKills.delete(sessionId);
      onData(
        '\r\n\x1b[31mClaude profile login isolation is unavailable on this version of Claude Code:\r\n' +
          'all profiles would share one macOS keychain login, mixing the accounts.\r\n' +
          'Update Claude Code, then start the profile session again.\x1b[0m\r\n',
      );
      onExit(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
      return;
    }

    if (providerId === 'claude' && configDir) {
      try {
        guardedProfileInstall(configDir);
      } catch (err) {
        console.warn('Failed to install hooks into profile config dir:', configDir, err);
      }
    }

    // Replace guard LAST before the spawn (review 8dddea9a 🟡3): every await
    // on this lane (PATH probe, binary probe, keychain, hooks) sits BEFORE
    // this block, so no window remains between check-then-act and ptys.set.
    if (ptys.has(sessionId)) {
      replacedPtys.add(ptys.get(sessionId)!.process);
      killPty(sessionId);
    }
    const { shell, args: spawnArgs } = spawnCommand;
    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, spawnArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: spec.env,
      });
    } catch (err) {
      // No PTY was registered: a kill that arrived during the awaits above
      // has nothing to address and must not leak to a later re-spawn.
      pendingKills.delete(sessionId);
      throw err;
    }

    ptyProcess.onData(onData);
    ptyProcess.onExit(({ exitCode, signal }) => {
      if (replacedPtys.delete(ptyProcess)) return;
      // Only remove from map if this PTY is still the active one for this session
      const current = ptys.get(sessionId);
      if (current?.process === ptyProcess) {
        ptys.delete(sessionId);
      }
      onExit(exitCode, signal, ptyProcess.pid);
    });

    ptys.set(sessionId, { process: ptyProcess, sessionId });
    // Row 121 trace: the spawn geometry the CLI paints its opening frames
    // into; compare against the pane's first accepted fit (renderer leg).
    if (RESIZE_TRACE) {
      console.log(`[fv-resize] ${JSON.stringify({ ev: 'spawn', sid: sessionId, cols: 120, rows: 30, registered: true, t: Date.now() })}`);
    }

    // A killPty that arrived during the awaits above addressed this spawn —
    // honour it now instead of leaving an orphaned CLI with no renderer
    // session. No replacedPtys suppression: the renderer has already dropped
    // the session, so the normal onExit teardown is the right cleanup path
    // (a pty:exit for an unknown session is a no-op in the renderer).
    if (pendingKills.delete(sessionId)) {
      killPty(sessionId);
    }
  } finally {
    spawningInFlight.delete(sessionId);
  }
}

// node-pty on Windows throws synchronously from write/resize/kill when the
// underlying child process has already exited (see microsoft/node-pty#887).
// A single dead PTY must not be allowed to crash the main Electron process
// — it would take down every other active session with it. Guard each
// operation, log a warning, and drop the dead handle only when the error
// indicates the PTY is actually dead.

/**
 * True when a node-pty exception means the underlying process has already
 * exited (as opposed to a transient or unknown failure). node-pty emits
 * messages like "Cannot write to a pty that has already exited" / "Cannot
 * resize a pty that has already exited" / "Cannot kill a pty that has
 * already exited" — we only prune the map in that case, so a transient
 * error does not silently leave the session unresponsive.
 */
function isPtyExitedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exited/i.test(msg);
}

/**
 * Escape sessionId for inclusion in a log message. sessionId arrives from
 * the renderer over IPC, so it is semi-trusted — JSON.stringify neutralises
 * newlines, ANSI escape sequences, and any other control characters that
 * could confuse log output.
 */
function formatSessionIdForLog(sessionId: string): string {
  return JSON.stringify(sessionId);
}

export function writePty(sessionId: string, data: string): void {
  const instance = ptys.get(sessionId);
  if (!instance) return;
  try {
    instance.process.write(data);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[pty-manager] writePty(${formatSessionIdForLog(sessionId)}) failed: ${message}`);
    if (isPtyExitedError(err)) {
      ptys.delete(sessionId);
    }
  }
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  // Row 121 trace (env-gated, no behavior change): `registered:false` is the
  // dropped-resize leg — the renderer fits a pane whose PTY main never
  // answered. See todos/archives/ROW-121-resize-forensics-2026-11-05.md.
  if (RESIZE_TRACE) {
    console.log(`[fv-resize] ${JSON.stringify({ ev: 'resizePty', sid: sessionId, cols, rows, registered: ptys.has(sessionId), t: Date.now() })}`);
  }
  const instance = ptys.get(sessionId);
  if (!instance) return;
  try {
    instance.process.resize(cols, rows);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[pty-manager] resizePty(${formatSessionIdForLog(sessionId)}) failed: ${message}`);
    if (isPtyExitedError(err)) {
      ptys.delete(sessionId);
    }
  }
}

export function killPty(sessionId: string): boolean {
  const instance = ptys.get(sessionId);
  if (!instance) {
    // Only a spawn that is genuinely in flight can claim a pending kill.
    // For any other unknown id — a session whose PTY already crashed, e.g.
    // — the kill is stale: the PTY it addressed is gone, and remembering
    // the flag would tear down the next PTY resumed under the same id.
    if (!spawningInFlight.has(sessionId)) return false;
    // spawnPty may still be awaiting before the PTY lands in `ptys`;
    // remember the kill so the pending spawn tears itself down on set.
    pendingKills.add(sessionId);
    // A killed session that is never (re)spawned leaves its flag behind; a
    // restart reuses the same id and would be killed by a stale entry. Bound
    // the set by insertion order so the oldest unclaimed kills expire.
    if (pendingKills.size > 100) pendingKills.delete(pendingKills.values().next().value as string);
    return false;
  }
  let killed = false;
  try {
    instance.process.kill();
    killed = true;
  } catch (err) {
    console.warn(`[pty-manager] killPty(${formatSessionIdForLog(sessionId)}) failed: ${(err as Error).message}`);
  } finally {
    // kill is an intentional teardown — always drop the handle, even on throw.
    ptys.delete(sessionId);
  }
  return killed;
}

export async function spawnShellPty(
  sessionId: string,
  cwd: string,
  onData: (data: string) => void,
  onExit: (exitCode: number, signal?: number) => void,
  /** Set = open the shell on a remote host via `ssh -tt -p <port> -- <host>`
   * (multi-host Phase 1, council R-2): the local cwd is irrelevant (the
   * remote cwd is `remote.defaultFolder`, falling back to the remote home).
   * `hostId` is the registry id behind `host` — it selects the per-host trust
   * store (audit row 35); without it the lane uses the user's known_hosts. */
  remote?: { hostId?: string; host: string; port: number; defaultFolder?: string },
): Promise<void> {
  // Row 17 review (8dddea9a findings 1-2): the PATH await below reopened the
  // kill/replace window this function used to close atomically. Register in
  // flight so a tab-close during the probe leaves a pendingKill (killPty
  // consults spawningInFlight), and re-run the replace guard after the await
  // — two invokes (Retry overlay during a slow probe) must not both pass it.
  spawningInFlight.add(sessionId);
  try {
  if (ptys.has(sessionId)) {
    replacedPtys.add(ptys.get(sessionId)!.process);
    killPty(sessionId);
  }

  // Register before spawn side effects so the SSH sidecar (`.ssh`) the
  // output scanner writes below routes through handleFileChange's
  // known-session gate; a shell session's whole existence is its PTY, so
  // the registry entry lives and dies with the process.
  registerSession(sessionId);

  const shell = isWin
    ? (process.env.COMSPEC || 'cmd.exe')
    : interactiveShell();
  const shellEnv = withUtf8Locale({ ...process.env, PATH: await getFullPathAsync() });
  if (ptys.has(sessionId)) {
    replacedPtys.add(ptys.get(sessionId)!.process);
    killPty(sessionId);
  }
  if (pendingKills.delete(sessionId)) {
    // Closed during the probe: the in-flight marker above caught the kill.
    unregisterSession(sessionId);
    spawningInFlight.delete(sessionId);
    return;
  }
  // Remote branch: the PTY runs system ssh; the remote login shell answers
  // there. `--` stops ssh from parsing the host token as an option (the
  // registry grammar already gates it), matching the resolveLaunchSpec wrap.
  const useRemote = remote !== undefined;
  const executable = useRemote ? 'ssh' : shell;
  // Row 35: same trust store as the launch lane. The record is the enrolled one
  // the caller (hosts:openShell) just gate-checked; an unknown id seeds nothing.
  const remoteRecord = useRemote && remote.hostId ? getHost(remote.hostId) : undefined;
  const trustArgs = remoteRecord ? hostTrustSshArgs(remoteRecord) : [];
  const argv = useRemote
    ? [
        '-tt',
        ...trustArgs,
        '-p',
        String(remote.port),
        '--',
        remote.host,
        ...(remote.defaultFolder ? [`cd ${posixQuote(remote.defaultFolder)} && exec $SHELL`] : []),
      ]
    : [];
  const ptyProcess = pty.spawn(executable, argv, {
    name: 'xterm-256color',
    cols: 120,
    rows: 15,
    cwd,
    env: shellEnv,
  });

  ptyProcess.onData(onData);
  ptyProcess.onExit(({ exitCode, signal }) => {
    if (replacedPtys.delete(ptyProcess)) return;
    // Only remove from map if this PTY is still the active one for this session
    const current = ptys.get(sessionId);
    if (current?.process === ptyProcess) {
      ptys.delete(sessionId);
    }
    unregisterSession(sessionId);
    onExit(exitCode, signal);
  });

  ptys.set(sessionId, { process: ptyProcess, sessionId });
  // A killPty that arrived while this spawn was in flight addressed it —
  // the entry exists now, so killPty reaches the process (mirrors spawnPty).
  if (pendingKills.delete(sessionId)) {
    killPty(sessionId);
  }
  } finally {
    spawningInFlight.delete(sessionId);
  }
}

export function killAllPtys(): void {
  for (const [id] of ptys) {
    killPty(id);
  }
}

/**
 * Get the current working directory of a PTY's deepest child process.
 * Uses pgrep/lsof on macOS, a `/proc/<pid>/cwd` readlink on Linux (stock
 * distros ship without lsof, making the lsof path inert there). Not
 * supported on Windows (returns null).
 */
export function getPtyCwd(sessionId: string): Promise<string | null> {
  const instance = ptys.get(sessionId);
  if (!instance) return Promise.resolve(null);

  const pid = instance.process.pid;

  if (isWin) {
    return getPtyCwdWindows(pid);
  }

  if (isLinux) {
    return new Promise((resolve) => {
      findDeepestChild(pid, (deepestPid) => {
        try {
          // C5G-10 parity with the macOS path: canonicalize the readlink
          // target so the renderer's worktree prefix-match sees
          // kernel-canonical paths.
          resolve(canonicalPath(fs.readlinkSync(`/proc/${deepestPid}/cwd`)));
        } catch (err) {
          console.debug(`[pty-manager] /proc cwd readlink failed for pid ${deepestPid}:`, err);
          resolve(null);
        }
      });
    });
  }

  return new Promise((resolve) => {
    // Find deepest child process recursively
    findDeepestChild(pid, (deepestPid) => {
      // Read cwd of the deepest process via lsof
      execFile(
        'lsof',
        ['-a', '-d', 'cwd', '-Fn', '-p', String(deepestPid)],
        { timeout: 3000 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          // Parse lsof output: lines starting with 'n' contain the path
          for (const line of stdout.split('\n')) {
            if (line.startsWith('n') && line.length > 1) {
              // C5G-10: lsof reports the kernel-canonical cwd (/private/tmp/…)
              // while git worktree paths arrive symlinked (/tmp/…); canonicalize
              // so the renderer's worktree prefix-match stops missing them.
              const raw = line.slice(1);
              resolve(isMac ? canonicalPath(raw) : raw);
              return;
            }
          }
          resolve(null);
        }
      );
    });
  });
}

function getPtyCwdWindows(_pid: number): Promise<string | null> {
  // Windows does not expose process cwd reliably via standard APIs.
  // This is a best-effort no-op — cwd tracking is not supported on Windows.
  // C5G-10: that makes the C2R-06 session→worktree auto-detection inert on
  // Windows (getPtyCwd returns null, so detectSessionWorktree bails and the
  // panel falls back to the active/manual worktree). Deliberately left a no-op
  // this window — no new Windows-only cwd mechanism is introduced here.
  return Promise.resolve(null);
}

function findDeepestChild(pid: number, callback: (deepestPid: number) => void): void {
  execFile(
    'pgrep',
    ['-P', String(pid)],
    { timeout: 3000 },
    (err, stdout) => {
      if (err || !stdout.trim()) {
        // No children — this is the deepest
        callback(pid);
        return;
      }
      const children = stdout.trim().split('\n').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
      if (children.length === 0) {
        callback(pid);
        return;
      }
      // Recurse into the last child (most recent)
      findDeepestChild(children[children.length - 1], callback);
    }
  );
}
