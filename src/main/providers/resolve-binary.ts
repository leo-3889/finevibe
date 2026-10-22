import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getFullPath, getFullPathAsync } from '../pty-manager';
import { isWin, whichCmd } from '../platform';
import { fileExists } from '../fs-utils';
import { findBinaryInNvm } from './nvm';

const COMMON_BIN_DIRS = isWin
  ? [
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'claude'),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.bun', 'bin'),
      path.join(os.homedir(), 'scoop', 'shims'),
      path.join(os.homedir(), '.volta', 'bin'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'),
    ]
  : [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.bun', 'bin'),
      path.join(os.homedir(), '.npm-global', 'bin'),
    ];

// On Windows, CLI tools installed via npm are .cmd shims
const WIN_EXTENSIONS = ['.cmd', '.exe', '.ps1', ''];

function findBinaryInDir(dir: string, binaryName: string): string | null {
  if (isWin) {
    for (const ext of WIN_EXTENSIONS) {
      const candidate = path.join(dir, binaryName + ext);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }
  const candidate = path.join(dir, binaryName);
  return fileExists(candidate) ? candidate : null;
}

function whichBinary(binaryName: string, envPath: string): string | null {
  try {
    const resolved = execSync(`${whichCmd} "${binaryName}"`, {
      env: { ...process.env, PATH: envPath },
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    // 'where' on Windows may return multiple lines — take the first
    const firstLine = resolved.split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

// Cached result of `npm prefix -g` (Windows only, avoids repeated subprocess spawns)
let cachedNpmPrefix: string | null | undefined;

function getNpmGlobalPrefix(fullPath: string): string | null {
  if (!isWin) return null;
  if (cachedNpmPrefix !== undefined) return cachedNpmPrefix;
  try {
    cachedNpmPrefix = execSync('npm prefix -g', {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
      env: { ...process.env, PATH: fullPath },
    }).trim() || null;
  } catch {
    cachedNpmPrefix = null;
  }
  return cachedNpmPrefix;
}

function findViaNpmPrefix(binaryName: string, fullPath: string): string | null {
  const prefix = getNpmGlobalPrefix(fullPath);
  return prefix ? findBinaryInDir(prefix, binaryName) : null;
}

/** A provider's memoized binary path (audit P2-26). The entry is trusted
 *  only while `pathEnv` still equals the live PATH and `path` still exists
 *  on disk — an app-lifetime cache let a stale shim permanently shadow the
 *  binary the user's PATH points at. */
export interface BinaryCache {
  path: string | null;
  pathEnv?: string;
}

export function resolveBinary(binaryName: string, cache: BinaryCache): string {
  const fullPath = getFullPath();
  if (cache.path && cache.pathEnv === fullPath && fileExists(cache.path)) {
    return cache.path;
  }
  cache.path = resolveBinaryUncached(binaryName, fullPath);
  cache.pathEnv = fullPath;
  return cache.path;
}

function resolveBinaryUncached(binaryName: string, fullPath: string): string {
  // P2-26: the user's PATH wins. Searching the common dirs (and nvm) first
  // let a stale shim in scoop/volta/npm-global permanently shadow the
  // binary PATH was deliberately pointed at — PATH changes mid-session
  // (shell profile edits, portable toolchains) were never picked up.
  const resolved = whichBinary(binaryName, fullPath);
  if (resolved) return resolved;

  for (const dir of COMMON_BIN_DIRS) {
    const found = findBinaryInDir(dir, binaryName);
    if (found) return found;
  }

  const nvmFound = findBinaryInNvm(binaryName);
  if (nvmFound) return nvmFound;

  const npmFound = findViaNpmPrefix(binaryName, fullPath);
  if (npmFound) return npmFound;

  return binaryName;
}

// Availability probe cache (audit P3-5): the probe below walks every common
// bin dir, scans nvm, and spawns `which`/`npm prefix -g` — on every
// `provider.validatePrerequisites()` call (startup, readiness analysis, the
// provider IPC). Positive results are cached for the process, matching
// resolveBinary's resolved-path cache; negative results expire after
// NEGATIVE_PROBE_TTL_MS so a CLI installed after app start is picked up
// without a restart. invalidateBinaryCache() clears both on provider
// install/uninstall and settings changes (see registry.invalidateAvailabilityCache).
const NEGATIVE_PROBE_TTL_MS = 30_000;
const probeCache = new Map<string, { exists: boolean; checkedAt: number }>();

// PA-01: the probe chain's cost was per-PROCESS — the whole chain re-ran on
// every cold launch, in front of the first window (W2-06: 2.3 s).
// `validateBinaryExistsAsync` adds a JSON disk tier in userData (resolved
// path + availability + binary mtime) whose entries are trusted only while
// (a) the PATH at probe time still matches, (b) the recorded file still
// exists with the recorded mtime, and (c) for negatives, the entry is
// younger than NEGATIVE_PROBE_TTL_MS. Anything else re-probes exactly as
// before. Without a configured dir (unit tests, tooling) the disk tier is
// off and behavior is identical to the in-process-only cache.
const execFileAsync = promisify(execFile);

export function validateBinaryExists(binaryName: string): boolean {
  const hit = probeCache.get(binaryName);
  if (hit && (hit.exists || Date.now() - hit.checkedAt < NEGATIVE_PROBE_TTL_MS)) {
    return hit.exists;
  }
  const exists = probeBinaryExists(binaryName);
  probeCache.set(binaryName, { exists, checkedAt: Date.now() });
  return exists;
}

/** Drop cached availability for one binary (or all) so the next probe
 *  re-scans. Called by registry.invalidateAvailabilityCache(). */
export function invalidateBinaryCache(binaryName?: string): void {
  if (binaryName === undefined) probeCache.clear();
  else probeCache.delete(binaryName);
  // PA-01 disk tier: invalidate mutates ONLY an already-loaded map. During
  // boot, initProviders → invalidateAvailabilityCache lands here before any
  // probe has loaded the file; wiping the file there would defeat
  // persistence entirely. A resurrected positive entry is safe: the
  // freshness gate re-stats the recorded path, and an uninstalled/updated
  // binary fails the stat and re-probes.
  if (diskCache) {
    if (binaryName === undefined) diskCache.clear();
    else diskCache.delete(binaryName);
    scheduleDiskCacheWrite();
  }
}

function probeBinaryExists(binaryName: string): boolean {
  for (const dir of COMMON_BIN_DIRS) {
    if (findBinaryInDir(dir, binaryName)) return true;
  }

  if (findBinaryInNvm(binaryName)) return true;

  const fullPath = getFullPath();
  if (whichBinary(binaryName, fullPath)) return true;

  if (findViaNpmPrefix(binaryName, fullPath)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// PA-01 cross-launch disk cache + async probe
// ---------------------------------------------------------------------------

interface DiskProbeEntry {
  exists: boolean;
  /** Resolved binary path when `exists`; informational + the stat target
   *  for the mtime freshness gate. */
  path: string | null;
  mtimeMs: number | null;
  /** The PATH env at probe time — a PATH edit invalidates the entry. */
  pathEnv: string;
  checkedAt: number;
}

let probeCacheDir: string | null = null;
let diskCache: Map<string, DiskProbeEntry> | null = null;
let diskCacheLoading: Promise<Map<string, DiskProbeEntry>> | null = null;
let diskWriteQueued = false;

/** Point the disk tier at userData (called by main.ts at boot). `null`
 *  disables it and resets any loaded state — the unit-test/tooling
 *  default. */
export function configureProbeCacheDir(dir: string | null): void {
  probeCacheDir = dir;
  diskCache = null;
  diskCacheLoading = null;
}

function probeCacheFile(): string | null {
  return probeCacheDir ? path.join(probeCacheDir, 'binary-probe-cache.json') : null;
}

function loadDiskCache(): Promise<Map<string, DiskProbeEntry>> {
  if (diskCache) return Promise.resolve(diskCache);
  if (!diskCacheLoading) {
    diskCacheLoading = (async () => {
      const map = new Map<string, DiskProbeEntry>();
      const file = probeCacheFile();
      if (file) {
        try {
          const raw = JSON.parse(await fs.promises.readFile(file, 'utf-8')) as Record<string, Partial<DiskProbeEntry>>;
          for (const [name, e] of Object.entries(raw)) {
            if (e && typeof e.exists === 'boolean' && typeof e.pathEnv === 'string' && typeof e.checkedAt === 'number') {
              map.set(name, {
                exists: e.exists,
                path: typeof e.path === 'string' ? e.path : null,
                mtimeMs: typeof e.mtimeMs === 'number' ? e.mtimeMs : null,
                pathEnv: e.pathEnv,
                checkedAt: e.checkedAt,
              });
            }
          }
        } catch { /* missing/corrupt file = full miss */ }
      }
      diskCache = map;
      return map;
    })();
  }
  return diskCacheLoading;
}

function scheduleDiskCacheWrite(): void {
  const file = probeCacheFile();
  if (!file || !diskCache || diskWriteQueued) return;
  diskWriteQueued = true;
  // Coalesced full-map snapshot: the parallel boot probes all mutate the
  // same in-memory map, so a single trailing write can never drop an
  // entry. The cache is best-effort — a failed write is a cold probe
  // next launch, never an error.
  queueMicrotask(() => {
    diskWriteQueued = false;
    const snapshot = Object.fromEntries(diskCache ?? new Map());
    void fs.promises.writeFile(file, JSON.stringify(snapshot), 'utf-8').catch(() => {});
  });
}

/** Per-entry invalidation (PA-01): a disk entry is trusted only while its
 *  PATH matches, its binary keeps its mtime, and negative entries stay
 *  inside the negative TTL. */
async function diskEntryIsFresh(entry: DiskProbeEntry, fullPath: string): Promise<boolean> {
  if (entry.pathEnv !== fullPath) return false;
  if (!entry.exists) return Date.now() - entry.checkedAt < NEGATIVE_PROBE_TTL_MS;
  if (!entry.path) return false;
  try {
    const st = await fs.promises.stat(entry.path);
    return st.mtimeMs === entry.mtimeMs;
  } catch {
    return false; // binary removed/updated since the probe
  }
}

// `where`/`which` are .exe-level binaries — execFile is shell-free. The
// npm lookup needs `shell: true`: on Windows npm is a .cmd shim, which
// execFile refuses to spawn without a shell (nodejs/node#45236); the argv
// is fully static, so the shell introduces no injection surface.
async function whichBinaryAsync(binaryName: string, envPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(whichCmd, [binaryName], {
      env: { ...process.env, PATH: envPath },
      timeout: 3000,
      windowsHide: true,
    });
    const firstLine = String(stdout).trim().split(/\r?\n/)[0];
    return firstLine || null;
  } catch {
    return null;
  }
}

async function getNpmGlobalPrefixAsync(fullPath: string): Promise<string | null> {
  if (!isWin) return null;
  if (cachedNpmPrefix !== undefined) return cachedNpmPrefix;
  try {
    const { stdout } = await execFileAsync('npm', ['prefix', '-g'], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true,
      env: { ...process.env, PATH: fullPath },
      shell: true,
    });
    cachedNpmPrefix = String(stdout).trim() || null;
  } catch {
    cachedNpmPrefix = null;
  }
  return cachedNpmPrefix;
}

async function findBinaryInDirAsync(dir: string, binaryName: string): Promise<string | null> {
  const candidates = isWin ? WIN_EXTENSIONS.map((ext) => binaryName + ext) : [binaryName];
  for (const name of candidates) {
    const candidate = path.join(dir, name);
    try {
      const st = await fs.promises.stat(candidate);
      if (st.isFile()) return candidate;
    } catch { /* not here; next candidate */ }
  }
  return null;
}

/** The async twin of probeBinaryExists: same walk order, same answer, plus
 *  the resolved path for the disk entry. Spawn-bound stages run off the
 *  main thread; the nvm walk stays sync (pure fs stats, sub-ms). */
async function probeBinaryPathAsync(binaryName: string): Promise<string | null> {
  for (const dir of COMMON_BIN_DIRS) {
    const found = await findBinaryInDirAsync(dir, binaryName);
    if (found) return found;
  }

  const nvmFound = findBinaryInNvm(binaryName);
  if (nvmFound) return nvmFound;

  const fullPath = await getFullPathAsync();
  const resolved = await whichBinaryAsync(binaryName, fullPath);
  if (resolved) return resolved;

  const prefix = await getNpmGlobalPrefixAsync(fullPath);
  if (prefix) return findBinaryInDirAsync(prefix, binaryName);

  return null;
}

/**
 * PA-01: async availability probe for the boot fan-out — in-process cache
 * → disk cache (mtime-gated) → full probe, with the result persisted for
 * the next launch. Runs off the main thread, so main.ts can launch every
 * provider's probe with Promise.all after the window is up.
 */
export async function validateBinaryExistsAsync(binaryName: string): Promise<boolean> {
  const hit = probeCache.get(binaryName);
  if (hit && (hit.exists || Date.now() - hit.checkedAt < NEGATIVE_PROBE_TTL_MS)) {
    return hit.exists;
  }
  // S2-02: async PATH snapshot — the sync getFullPath here ran the
  // login-shell/registry spawn on every launch, synchronously, inside the
  // PA-01 boot fan-out (0.2-3 s main-thread block after createWindow).
  const fullPath = await getFullPathAsync();
  const disk = await loadDiskCache();
  const entry = disk.get(binaryName);
  if (entry && (await diskEntryIsFresh(entry, fullPath))) {
    probeCache.set(binaryName, { exists: entry.exists, checkedAt: Date.now() });
    return entry.exists;
  }
  const resolved = await probeBinaryPathAsync(binaryName);
  const exists = resolved !== null;
  probeCache.set(binaryName, { exists, checkedAt: Date.now() });
  let mtimeMs: number | null = null;
  if (resolved) {
    try {
      mtimeMs = (await fs.promises.stat(resolved)).mtimeMs;
    } catch { /* vanished between probe and stat; entry re-probes next launch */ }
  }
  disk.set(binaryName, { exists, path: resolved, mtimeMs, pathEnv: fullPath, checkedAt: Date.now() });
  scheduleDiskCacheWrite();
  return exists;
}
