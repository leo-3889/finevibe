import * as path from 'path';
import * as os from 'os';
import { fileExists, readDirSafe, readFileSafe, dirExists } from '../fs-utils';
import { isWin } from '../platform';

function nvmDir(): string {
  return process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
}

function nvmVersionsDir(): string {
  return path.join(nvmDir(), 'versions', 'node');
}

/** Parse `v22.14.0` (leading `v` optional) into a comparable numeric tuple. */
function parseVersion(raw: string): [number, number, number] | null {
  const m = raw.trim().replace(/^v/, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Newest-first comparator; non-version entries sort last. */
function compareVersionDesc(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
}

/** Newest installed version by numeric precedence (P2-27: never raw
 *  readdir order, which surfaces the oldest install on most filesystems). */
function highestInstalledVersion(): string | null {
  const entries = readDirSafe(nvmVersionsDir()).filter((e) => parseVersion(e));
  entries.sort(compareVersionDesc);
  return entries[0] ?? null;
}

// P2-27: `alias/default` frequently stores an ALIAS, not a version —
// 'lts/*' or 'lts/iron'. Read raw, it yields versions/node/lts/*, a path
// that can never exist, and selection silently falls to readdir order
// (oldest installed). Follow nvm's own chain: alias/<name> files under
// $NVM_DIR/alias; 'lts/*' resolves to the newest version referenced by any
// alias/lts/* codename file.
function resolveVersionAlias(name: string, seen: Set<string>): string | null {
  const key = name.trim();
  if (!key || seen.has(key)) return null;
  seen.add(key);
  if (key === 'node' || key === 'stable' || key === 'unstable') {
    return highestInstalledVersion();
  }
  if (!key.startsWith('lts/')) return key;
  if (key === 'lts/*') {
    let best: string | null = null;
    for (const codename of readDirSafe(path.join(nvmDir(), 'alias', 'lts'))) {
      const target = resolveVersionAlias(`lts/${codename}`, seen);
      if (target && (!best || compareVersionDesc(target, best) < 0)) best = target;
    }
    return best;
  }
  const contents = readFileSafe(path.join(nvmDir(), 'alias', key));
  const target = contents?.trim();
  return target ? resolveVersionAlias(target, seen) : null;
}

function nvmDefaultVersion(): string | null {
  const raw = readFileSafe(path.join(nvmDir(), 'alias', 'default'));
  const alias = raw?.trim();
  if (!alias) return null;
  const resolved = resolveVersionAlias(alias, new Set());
  // Chain broken (missing alias file, cycle, empty lts/*): the newest
  // installed version, not the raw readdir order (P2-27).
  return resolved ?? highestInstalledVersion();
}

function* iterateNvmVersionBins(): Generator<string> {
  if (isWin) return;
  const versionsDir = nvmVersionsDir();
  if (!dirExists(versionsDir)) return;

  const seen = new Set<string>();
  const yieldBin = function* (version: string): Generator<string> {
    if (seen.has(version)) return;
    seen.add(version);
    yield path.join(versionsDir, version, 'bin');
  };

  const defaultVersion = nvmDefaultVersion();
  if (defaultVersion) yield* yieldBin(defaultVersion);
  // P2-27: newest-first, so an unpinned scan prefers the newest install.
  const entries = readDirSafe(versionsDir).slice().sort(compareVersionDesc);
  for (const entry of entries) yield* yieldBin(entry);
}

export function findBinaryInNvm(binaryName: string): string | null {
  for (const binDir of iterateNvmVersionBins()) {
    const candidate = path.join(binDir, binaryName);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function nvmDefaultNodeBinDir(): string | null {
  for (const binDir of iterateNvmVersionBins()) {
    if (dirExists(binDir)) return binDir;
  }
  return null;
}
