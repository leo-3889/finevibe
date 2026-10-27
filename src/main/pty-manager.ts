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
import { remoteLaunchSessionDir } from './launch-session-dir';
import { registerSession, registerRemoteStatus, unregisterSession } from './hook-status';
import { guardedProfileInstall } from './settings-guard';
import { getKeychainIsolationStatus } from './claude-keychain';
import { isLinux, isMac, isWin, pathSep, utf8LocaleEnv } from './platform';
import { canonicalPath } from './fs-utils';
import { nvmDefaultNodeBinDir } from './providers/nvm';

const execFileP = promisify(execFile);

interface PtyInstance {
  process: pty.IPty;
  sessionId: string;
}

const ptys = new Map<string, PtyInstance>();
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
export function defaultPosixShell(): string {
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

export function getRegistryPath(): string {
  if (!isWin) return '';

  const parse = (output: string): string => {
    const match = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (!match) return '';
    let value = match[1].trim();
    value = value.replace(/%([^%]+)%/g, (_m, varName) => process.env[varName] || `%${varName}%`);
    return value;
  };

  let systemPath = '';
  try {
    systemPath = parse(execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ));
  } catch (err) {
    // `reg query` exits non-zero when the value is absent; that hive simply
    // contributes nothing to PATH.
    console.debug('Could not read system PATH from registry:', err);
  }

  let userPath = '';
  try {
    userPath = parse(execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    ));
  } catch (err) {
    // Same as above: a missing HKCU Environment\Path is normal, not an error.
    console.debug('Could not read user PATH from registry:', err);
  }

  return [systemPath, userPath].filter(Boolean).join(pathSep);
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
 * typical on nvm/p10k setups) or two registry `reg query` execSyncs
 * (Windows) — the PA-01 boot probe fan-out calls it on every launch
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
      const parse = (output: string): string => {
        const match = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
        if (!match) return '';
        const value = match[1].trim();
        return value.replace(/%([^%]+)%/g, (_m, varName) => process.env[varName] || `%${varName}%`);
      };
      const regQuery = async (hive: string): Promise<string> => {
        try {
          const { stdout } = await execFileP('reg', ['query', hive, '/v', 'Path'], {
            encoding: 'utf-8', timeout: 3000, windowsHide: true,
          });
          return parse(stdout);
        } catch {
          // `reg query` exits non-zero when the value is absent; the hive
          // contributes nothing to PATH (mirrors getRegistryPath).
          return '';
        }
      };
      const [systemPath, userPath] = await Promise.all([
        regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'),
        regQuery('HKCU\\Environment'),
      ]);
      const pathSet = new Set([
        ...currentPath.split(pathSep),
        ...systemPath.split(pathSep),
        ...userPath.split(pathSep),
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, '.local', 'bin'),
      ]);
      cachedFullPath = Array.from(pathSet).join(pathSep);
      return cachedFullPath;
    }
    const shell = defaultPosixShell();
    try {
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
 * So an argument containing `"` is rejected rather than mangled. The caller
 * surfaces this as a spawn failure, which is the correct outcome; silently
 * producing an injectable command line is not.
 *
 * Residual, accepted: `%VAR%` still expands inside double quotes. That leaks an
 * environment value into the argument; it is not code execution, so a percent
 * sign stays legal rather than rejecting legitimate arguments that contain one.
 */
const CMDEXE_METACHARS = /[&|<>^]/;

function quoteArgForCmdExe(arg: string): string {
  if (arg.includes('"')) {
    const shown = arg.length > 80 ? `${arg.slice(0, 77)}...` : arg;
    throw new Error(
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
 */
function resolveCmdShimTarget(shimPath: string): ShimTarget | null {
  let body: string;
  try {
    body = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
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
  const ext = path.extname(shell).toLowerCase();
  // .exe files can be spawned directly by CreateProcess
  if (ext === '.exe') return { shell, args };
  // .ps1 scripts need PowerShell
  if (ext === '.ps1') {
    return {
      shell: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shell, ...args],
    };
  }
  // .cmd/.bat shims carry their real target; an extensionless npm launcher
  // resolves via PATHEXT to the <name>.cmd beside it — parse the same file.
  const shimPath = ext === '.cmd' || ext === '.bat' ? shell : ext === '' ? `${shell}.cmd` : '';
  if (shimPath) {
    const target = resolveCmdShimTarget(shimPath);
    if (target) return { shell: target.executable, args: [...target.prefixArgs, ...args] };
  }
  // Everything else (unparseable shims, bare names, extensionless paths):
  // wrap with cmd.exe so CreateProcess doesn't choke on non-PE binaries.
  // Every token must be quoted for cmd.exe — see quoteArgForCmdExe.
  return {
    shell: 'cmd.exe',
    args: ['/c', quoteArgForCmdExe(shell), ...args.map(quoteArgForCmdExe)],
  };
}

/**
 * The effective session storage mode for a launch. T2 always resolves
 * 'default' (the profile's own sessions tree); 'custom-dir' and
 * 'nonpersistent' are rejected pre-spawn until per-launch storage is
 * tracked end-to-end.
 */
export type SessionStorageMode = 'default' | 'custom-dir' | 'nonpersistent';

/**
 * One effective launch: the executable, argv, environment,
 * provider/profile identity and storage mode a session is spawned with.
 * Resolved once in spawnPty before any side effect; the child environment
 * and every lifecycle reader must agree on this single spec.
 */
export interface LaunchSpec {
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
 * The provider launch command as one string for the remote login shell:
 * the binary's basename (Windows `.CMD`/`.EXE` shims carry the same stem as
 * the POSIX command) plus every argument, each POSIX-quoted. The local
 * absolute path does not exist on the remote — the remote login shell's PATH
 * resolves the remote's own install.
 */
function remoteCommand(bin: string, argv: string[], rawToken?: string): string {
  // `rawToken` (the home-relative session dir) is emitted "…"-quoted so the
  // remote login shell expands its leading `~` — single quotes (posixQuote)
  // would hand the CLI a literal `~` directory. The token is the sanitized
  // remoteLaunchSessionDir spelling ([A-Za-z0-9_./-] after `~/`), so double
  // quoting carries no expansion risk.
  return [bin, ...argv]
    .map((t) => (rawToken !== undefined && t === rawToken ? `"${t.replace(/^~/, '$HOME')}"` : posixQuote(t)))
    .join(' ');
}

/** Providers that steer their transcripts into a per-launch `--session-dir`. */
function usesSessionDirArgv(providerId: ProviderId): providerId is 'pi' | 'pi-bolt' | 'omp' {
  return providerId === 'pi' || providerId === 'pi-bolt' || providerId === 'omp';
}

/** Swap a locally-derived `--session-dir` value for the host-side spelling. */
function remoteSessionDirArgv(argv: string[], hostDir: string): string[] {
  const i = argv.indexOf('--session-dir');
  if (i < 0 || i + 1 >= argv.length) return argv; // provider didn't add it — nothing to swap
  const out = [...argv];
  out[i + 1] = hostDir;
  return out;
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
}): LaunchSpec {
  const { sessionId, cliSessionId, isResume, extraArgs, providerId, initialPrompt, systemPrompt, envVars, configDir, hostId } = params;
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

  const env = provider.buildEnv(sessionId, withUtf8Locale({ ...process.env }) as Record<string, string>, { configDir });
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
    executable: resolveProviderBinary(providerId, hostId),
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
    // own gate (incl. bracketed IPv6); parseSshHost's free-text grammar
    // would reject the bracketed spelling (audit T1 #2).
    if (!isRegistryHostTarget(record.user, record.host)) {
      throw new LaunchSpecError(`Host ${JSON.stringify(record.name)} has an invalid user/host — re-save it in Settings → Hosts.`);
    }
    const prefix = remoteEnvPrefix(base.env);
    // Host-side session dir (audit T2 #5): the same derivation the transcript
    // mirror uses, swapped into the provider argv, plus a cheap mkdir guard
    // (the CLI's local flow pre-creates the dir; the host's must exist too).
    let argv = base.argv;
    let mkdir = '';
    let rawToken: string | undefined;
    if (usesSessionDirArgv(providerId)) {
      const hostDir = remoteLaunchSessionDir(providerId, sessionId);
      argv = remoteSessionDirArgv(base.argv, hostDir);
      if (argv !== base.argv) {
        rawToken = hostDir;
        mkdir = `mkdir -p "${hostDir.replace(/^~/, '$HOME')}" && `;
      }
    }
    const cmd = `${mkdir}${prefix ? `${prefix} ` : ''}${remoteCommand(base.executable, argv, rawToken)}`;
    return { ...base, executable: 'ssh', argv: ['-tt', '-p', String(record.port), '--', `${record.user}@${record.host}`, cmd] };
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
    try {
      spec = resolveLaunchSpec({ sessionId, cliSessionId, isResume, extraArgs, providerId, initialPrompt, systemPrompt, envVars, configDir, hostId });
    } catch (err) {
      // Nothing will spawn for this session; drop any kill that arrived for
      // it so a later re-spawn of the same id is not killed by a stale flag.
      pendingKills.delete(sessionId);
      const message = err instanceof LaunchSpecError ? err.message : `Failed to prepare the launch: ${err}`;
      onData(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
      onExit(1, undefined, undefined, SPAWN_REJECTED_EXIT_REASON);
      return;
    }

    if (ptys.has(sessionId)) {
      replacedPtys.add(ptys.get(sessionId)!.process);
      killPty(sessionId);
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
    if (providerId === 'claude' && configDir && getKeychainIsolationStatus().status === 'unsupported') {
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

    const { shell, args: spawnArgs } = resolveWindowsShell(spec.executable, spec.argv);

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

export function spawnShellPty(
  sessionId: string,
  cwd: string,
  onData: (data: string) => void,
  onExit: (exitCode: number, signal?: number) => void,
  /** Set = open the shell on a remote host via `ssh -tt -p <port> -- <host>`
   * (multi-host Phase 1, council R-2): the local cwd is irrelevant (the
   * remote cwd is `remote.defaultFolder`, falling back to the remote home). */
  remote?: { host: string; port: number; defaultFolder?: string },
): void {
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
  const shellEnv = withUtf8Locale({ ...process.env, PATH: getFullPath() });
  // Remote branch: the PTY runs system ssh; the remote login shell answers
  // there. `--` stops ssh from parsing the host token as an option (the
  // registry grammar already gates it), matching the resolveLaunchSpec wrap.
  const useRemote = remote !== undefined;
  const executable = useRemote ? 'ssh' : shell;
  const argv = useRemote
    ? [
        '-tt',
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
