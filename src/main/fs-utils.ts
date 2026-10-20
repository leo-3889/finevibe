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
 */
export function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalPath(parent), path.basename(resolved));
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
