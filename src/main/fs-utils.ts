import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function expandUserPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * Resolve existing links, including a link in an existing parent directory.
 * Path *comparisons* must use this: the same directory can be spelled with a
 * different drive-letter case, separator style, `..` segment, junction or
 * link, and on Windows realpathSync also returns the real casing. Non-existent
 * paths fall back to their resolved form with canonicalized parents.
 *
 * P2-59: every gated `fs:`/`git:` IPC canonicalizes its target *and* its
 * allowed roots, synchronously, on the main process. Canonical forms are
 * cached: the parent walk of a non-existent target stops at the first
 * existing ancestor and the whole chain is ONE target-cache entry (LRU, short
 * TTL, so a path that a `create`/`write`/`stat` gate saw missing is re-solved
 * soon after it appears). Roots — project dirs, CLI config dirs — change only
 * with the store, so they go through {@link canonicalRoot} and live until
 * {@link invalidateCanonicalPathCache}. The cache changes throughput, not
 * policy: every returned value equals the pre-cache implementation's for the
 * same filesystem state.
 */
/** Target-LRU bound; gate traffic revisits a handful of roots repeatedly. */
export const TARGET_CANONICAL_CACHE_MAX = 256;
/** How long a target's canonical form may serve; roots are not TTL'd. */
export const TARGET_CANONICAL_TTL_MS = 5_000;

const rootCanonicalCache = new Map<string, string>();
const targetCanonicalCache = new Map<string, { value: string; expiresAt: number }>();

export function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const hit = targetCanonicalCache.get(resolved);
  if (hit !== undefined) {
    if (hit.expiresAt > Date.now()) {
      // Insertion order doubles as recency: re-inserting on a hit makes the
      // size cap evict the least recently used entry.
      targetCanonicalCache.delete(resolved);
      targetCanonicalCache.set(resolved, hit);
      return hit.value;
    }
    targetCanonicalCache.delete(resolved);
  }
  const value = canonicalChain(resolved);
  targetCanonicalCache.set(resolved, { value, expiresAt: Date.now() + TARGET_CANONICAL_TTL_MS });
  if (targetCanonicalCache.size > TARGET_CANONICAL_CACHE_MAX) {
    const oldest = targetCanonicalCache.keys().next().value;
    if (oldest !== undefined) targetCanonicalCache.delete(oldest);
  }
  return value;
}

/**
 * Canonicalize a gate ROOT (project dir, CLI config dir). Roots are re-read
 * from the store on every gate call, so caching the canonical form is what
 * keeps one slow root (OneDrive, dead mount, spun-down drive) off the hot
 * path after its first resolution. Entries live for the process and are
 * dropped by {@link invalidateCanonicalPathCache}.
 */
export function canonicalRoot(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  const hit = rootCanonicalCache.get(resolved);
  if (hit !== undefined) return hit;
  const value = canonicalChain(resolved);
  rootCanonicalCache.set(resolved, value);
  return value;
}

/** Drop every cached canonical form (project add/remove, configDir change). */
export function invalidateCanonicalPathCache(): void {
  rootCanonicalCache.clear();
  targetCanonicalCache.clear();
}

let lastRootsSignature: string | null = null;

/**
 * Store-persist hook (wired at `store:save`): the root cache is keyed on the
 * project set and the profile configDirs, so invalidate when a state write
 * changes exactly those. Every other state write (preferences, session
 * history) leaves the cache warm.
 */
export function invalidateCanonicalPathIfRootsChanged(state: {
  projects?: { path?: unknown }[];
  profiles?: { configDir?: unknown }[];
}): void {
  const signature = JSON.stringify([
    (state.projects ?? []).map(p => p.path),
    (state.profiles ?? []).map(p => p.configDir),
  ]);
  const changed = lastRootsSignature === null || signature !== lastRootsSignature;
  lastRootsSignature = signature;
  if (changed) invalidateCanonicalPathCache();
}

/**
 * realpath the deepest existing ancestor and re-append the missing tail. The
 * walk stops at the first existing ancestor, so a non-existent path costs one
 * bounded chain instead of a `realpathSync` recursion per level; an
 * unresolvable filesystem root falls back to the resolved form.
 */
function canonicalChain(resolved: string): string {
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return missing.length === 0 ? current : path.join(current, ...missing);
      }
      missing.unshift(path.basename(current));
      current = parent;
      continue;
    }
    return missing.length === 0 ? real : path.join(real, ...missing);
  }
}

export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function readDirSafe(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export const BINARY_SNIFF_BYTES = 8000;

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * macOS treats these directories as opaque *packages*: `shell.openPath` on one
 * hands it to its default handler — a `.app` starts running, an `.xcodeproj`
 * launches Xcode — instead of showing its contents. Callers that mean "show me
 * this folder" must reveal these in the parent rather than open them.
 */
const MAC_PACKAGE_EXTENSIONS = new Set([
  '.app', '.bundle', '.framework', '.plugin', '.playground', '.xcodeproj', '.xcworkspace',
]);

/** True when `dirPath` is a directory macOS would launch rather than browse. */
export function isMacPackagePath(dirPath: string): boolean {
  return MAC_PACKAGE_EXTENSIONS.has(path.extname(dirPath).toLowerCase());
}
