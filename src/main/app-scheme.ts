import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { net, protocol } from 'electron';

// The renderer is served over a privileged `app://` scheme (architecture audit
// P3 / queue row 13). Why the scheme exists: ES-module chunk splitting is the
// only lever left on the renderer bundle, and Chromium refuses `type="module"`
// scripts on `file://` in Electron. `app://` is registered standard+secure, so
// relative URLs, same-origin `fetch`, and secure-context APIs (crypto.randomUUID,
// used by board/grid/terminal ids) keep working exactly as they did on `file://`
// (Chromium treats `file://` as potentially trustworthy, and a secure custom
// scheme is at least as trustworthy), with `webSecurity` left ON.
const APP_SCHEME = 'app';
const APP_HOST = 'finevibe';
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// Explicit MIME: Chromium enforces strict MIME checking for module scripts, so
// a chunk served as application/octet-stream would be refused. Everything the
// renderer loads is listed here.
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Must run BEFORE the app `ready` event (Electron requirement for privileged
 * scheme registration). Called at `main.ts` module scope, never in a test.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true, // host/path semantics, relative URL resolution
        secure: true, // secure context (crypto.subtle / randomUUID)
        supportFetchAPI: true, // renderer fetch('./CHANGELOG.md')
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Resolve an `app://` request to a file inside the built renderer directory.
 * Pure (no Electron) so the traversal rule is unit-testable. Returns null for a
 * malformed URL, an escaping path, or anything outside `rendererRoot`.
 */
export function resolveAppPath(url: string, rendererRoot: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const rel = pathname === '' || pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(rendererRoot);
  const target = path.resolve(root, rel);
  // Case-insensitive: Windows paths are case-insensitive, and a `..` resolved
  // past the root is the exact attack this guard exists to stop.
  const r = root.toLowerCase();
  const t = target.toLowerCase();
  return t === r || t.startsWith(r + path.sep.toLowerCase()) ? target : null;
}

/** Serve the built renderer directory. Call after `ready`, before any load. */
export function installAppScheme(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const target = resolveAppPath(request.url, rendererRoot);
    // ponytail: two stats per request (existsSync + isFile). At boot that is a
    // dozen requests for the app's own files; the ceiling is the asset count.
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const file = await net.fetch(pathToFileURL(target).toString());
    const type = MIME[path.extname(target).toLowerCase()];
    return new Response(file.body, {
      status: 200,
      headers: type ? { 'content-type': type } : {},
    });
  });
}

/** The app document is the only navigation target main ever allows. */
export function isAppDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === `${APP_SCHEME}:` &&
      parsed.host === APP_HOST &&
      decodeURIComponent(parsed.pathname) === '/index.html'
    );
  } catch {
    return false;
  }
}
