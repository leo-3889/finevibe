import crypto from 'node:crypto';
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
    // The app document gets the early-crash inline script + the serving CSP
    // header. New nonce per response, so the document is never cache-reused
    // with a stale nonce.
    if (type?.startsWith('text/html')) {
      const { html, csp } = injectEarlyCrashCapture(
        fs.readFileSync(target, 'utf8'),
        CSP_TEMPLATE,
        newCrashNonce(),
      );
      return new Response(html, { status: 200, headers: { 'content-type': type, 'content-security-policy': csp } });
    }
    return new Response(file.body, {
      status: 200,
      headers: type ? { 'content-type': type } : {},
    });
  });
}

// ---------------------------------------------------------------------------
// Early crash capture (architecture audit row 16)
//
// The bundle installs its crash wiring at module top level, so a crash during
// module (import) evaluation happens before any listener exists and lands
// nowhere. `script-src 'self'` forbids the inline pre-load handler that would
// cover it — so the scheme handler injects one at serve time, authorised by a
// per-response nonce plus the script's SHA-256 hash. The served document ends
// up under TWO policies: the <meta> CSP from the (nonce-free at rest) file and
// a response-header CSP, both carrying this load's nonce and the script hash.
// Chromium enforces all policies independently, so the meta must allow the
// inline script too: it gains the SAME 'sha256-…' (a hash source is only
// honored by a policy that also carries a nonce, which the serve-time
// replacement supplies). A tampered inline script fails both checks at once.

// Placeholder tokens, spelled with a concat so the replace sites in this file
// contain no literal token (a literal would replace itself). index.html is
// nonce-free at rest: it carries these tokens, the handler swaps in a fresh
// nonce per response.
const NONCE_TOKEN = '__FV' + '_CRASH_NONCE__';
const HASH_TOKEN = '__FV' + '_CRASH_HASH__';
const SCRIPT_TOKEN = '__FV' + '_CRASH_SCRIPT__';

// The inline pre-load handler. One line, no `"` and no `</script` sequence, so
// it is safe as classic-script element content inside a nonce'd tag (the only
// thing HTML ends a script element at is `</script`), and the unit test can
// hash the shipped bytes. Records into window.__fvEarlyCrash (cap 5);
// src/renderer/early-crash.ts + index.ts drain it into the normal
// console.error → finevibe.log + debug-ring path once the bundle is alive.
export const EARLY_CRASH_SCRIPT_SRC =
  "window.__fvEarlyCrash=window.__fvEarlyCrash||[];"
  + "window.addEventListener('error',function(e){if(window.__fvEarlyCrash.length<5){window.__fvEarlyCrash.push('error: '+(e.message||'uncaught error (no detail)')+' @ '+(e.filename||'')+':'+(e.lineno||0)+':'+(e.colno||0));}},true);"
  + "window.addEventListener('unhandledrejection',function(e){if(window.__fvEarlyCrash.length<5){var r=e&&e.reason;window.__fvEarlyCrash.push('rejection: '+String((r&&r.stack)||r||'unknown'));}},true);";

const EARLY_CRASH_HASH = `sha256-${crypto.createHash('sha256').update(EARLY_CRASH_SCRIPT_SRC, 'utf8').digest('base64')}`;

// Mirrors the <meta> CSP in src/renderer/index.html (the unit test asserts the
// directive skeletons stay equal) with the two tokens at script-src.
export const CSP_TEMPLATE =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-__FV" + "_CRASH_NONCE__' '__FV" + "_CRASH_HASH__'; font-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src *;";

/** 122-bit base64url token; the alphabet contains no CSP delimiter characters. */
export function newCrashNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Serve-time transform of the app document: substitute this load's nonce and
 * the inline script's hash into the HTML template and the CSP. Pure (unit
 * tested); throws rather than serve a template whose placeholders are not all
 * accounted for — an un-substituted token would disable the capture silently.
 */
export function injectEarlyCrashCapture(
  htmlTemplate: string,
  cspTemplate: string,
  nonce: string,
): { html: string; csp: string } {
  for (const template of [htmlTemplate, cspTemplate]) {
    if (!template.includes(NONCE_TOKEN)) throw new Error('index.html/CSP template is missing the crash-nonce token');
  }
  if (!htmlTemplate.includes(SCRIPT_TOKEN)) throw new Error('index.html is missing the crash-script anchor');
  const html = htmlTemplate
    .split(NONCE_TOKEN)
    .join(nonce)
    .split(HASH_TOKEN)
    .join(EARLY_CRASH_HASH)
    .split(SCRIPT_TOKEN)
    .join(`\n  <script nonce="${nonce}">${EARLY_CRASH_SCRIPT_SRC}</script>`);
  const csp = cspTemplate.split(NONCE_TOKEN).join(nonce).split(HASH_TOKEN).join(EARLY_CRASH_HASH);
  if (html.includes(NONCE_TOKEN) || html.includes(HASH_TOKEN) || csp.includes(NONCE_TOKEN) || csp.includes(HASH_TOKEN)) {
    throw new Error('crash-capture placeholder left un-substituted in served document');
  }
  return { html, csp };
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
