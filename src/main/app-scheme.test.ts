import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  APP_INDEX_URL,
  CSP_TEMPLATE,
  EARLY_CRASH_SCRIPT_SRC,
  injectEarlyCrashCapture,
  isAppDocumentUrl,
  newCrashNonce,
  resolveAppPath,
} from './app-scheme';

// app-scheme.ts serves the renderer bundle over the privileged app:// scheme
// (P3). The handler needs a live Electron protocol registry, so what is testable
// headlessly is the two pure decisions it is built from — which file a request
// maps to, and which URL counts as the app document — plus the wiring order in
// main.ts that Electron requires, and the serve-time early-crash injection
// (audit row 16): nonce/hash substitution into the real index.html and CSP.

const ROOT = path.resolve('dist', 'renderer');
const rel = (target: string | null): string | null =>
  target === null ? null : path.relative(ROOT, target).replace(/\\/g, '/');

describe('resolveAppPath', () => {
  it('maps the bare origin and "/" to the app document', () => {
    expect(rel(resolveAppPath('app://finevibe/', ROOT))).toBe('index.html');
    expect(rel(resolveAppPath('app://finevibe', ROOT))).toBe('index.html');
    expect(rel(resolveAppPath('app://finevibe/index.html', ROOT))).toBe('index.html');
  });

  it('serves bundle chunks, styles and assets by path', () => {
    expect(rel(resolveAppPath('app://finevibe/index.js', ROOT))).toBe('index.js');
    expect(rel(resolveAppPath('app://finevibe/chunk-7QF2PLPK.js', ROOT))).toBe('chunk-7QF2PLPK.js');
    expect(rel(resolveAppPath('app://finevibe/styles.css', ROOT))).toBe('styles.css');
    expect(rel(resolveAppPath('app://finevibe/vendor/gridstack.min.css', ROOT))).toBe('vendor/gridstack.min.css');
    expect(rel(resolveAppPath('app://finevibe/CHANGELOG.md', ROOT))).toBe('CHANGELOG.md');
  });

  it('percent-decodes the pathname before resolving', () => {
    expect(rel(resolveAppPath('app://finevibe/index%2Ejs', ROOT))).toBe('index.js');
  });

  it('refuses every escape from the served root', () => {
    for (const url of [
      'app://finevibe/../package.json',
      'app://finevibe/%2e%2e/package.json',
      'app://finevibe/../../package.json',
      'app://finevibe/styles/../../package.json',
      'app://finevibe/%2e%2e%2f%2e%2e%2fpackage.json',
      'app://finevibe/C:Windowspackage.json',
    ]) {
      const target = resolveAppPath(url, ROOT);
      if (target !== null) {
        expect(path.resolve(target).startsWith(ROOT + path.sep)).toBe(true);
      }
    }
  });

  it('refuses a malformed URL', () => {
    expect(resolveAppPath('not a url', ROOT)).toBeNull();
    expect(resolveAppPath('', ROOT)).toBeNull();
  });

  it('allows in-root traversal that lands inside the root', () => {
    expect(rel(resolveAppPath('app://finevibe/styles/../index.html', ROOT))).toBe('index.html');
  });
});

describe('isAppDocumentUrl', () => {
  it('accepts exactly the document main loads', () => {
    expect(isAppDocumentUrl(APP_INDEX_URL)).toBe(true);
  });

  it('rejects other hosts, other paths and other schemes', () => {
    expect(isAppDocumentUrl('app://finevibe/other.html')).toBe(false);
    expect(isAppDocumentUrl('app://evil/index.html')).toBe(false);
    expect(isAppDocumentUrl('file:///C:/app/index.html')).toBe(false);
    expect(isAppDocumentUrl('https://example.com/index.html')).toBe(false);
    expect(isAppDocumentUrl('app://finevibe')).toBe(false);
    expect(isAppDocumentUrl('nonsense')).toBe(false);
  });
});

describe('main.ts wiring (static invariants)', () => {
  const main = readFileSync(path.join('src', 'main', 'main.ts'), 'utf8');

  it('registers the privileged scheme at module scope, before app.whenReady', () => {
    const registerAt = main.indexOf('registerAppScheme();');
    const readyAt = main.indexOf('app.whenReady()');
    expect(registerAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    // Electron rejects registerSchemesAsPrivileged after `ready`, so the call
    // must sit at module scope, above the whenReady chain.
    expect(registerAt).toBeLessThan(readyAt);
    expect(main.slice(0, registerAt)).toMatch(/^import /m);
  });

  it('installs the handler inside whenReady, before the first window is created', () => {
    const installAt = main.indexOf('installAppScheme(path.dirname(RENDERER_INDEX_PATH))');
    const createAt = main.indexOf('createWindow();');
    expect(installAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(createAt);
  });

  it('loads the app over app:// and never over a file path', () => {
    expect(main).toContain('loadURL(APP_INDEX_URL)');
    expect(main).not.toMatch(/loadFile\(/);
  });
});

// The real shipped template, not a fixture: the placeholders, the CSP meta and
// the script anchor must stay exactly where app-scheme.ts substitutes them.
const HTML_TEMPLATE = readFileSync(path.join('src', 'renderer', 'index.html'), 'utf8');
const META_CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(HTML_TEMPLATE)![1];
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('early crash capture injection (audit row 16)', () => {
  it('the file at rest is nonce-free and carries exactly the three serve-time tokens', () => {
    // Nonce-free at rest: no 22-char base64url nonce value anywhere (the meta
    // carries the 17-char token, comments carry prose — neither matches).
    expect(HTML_TEMPLATE).not.toMatch(/nonce-[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/);
    expect(countOf(HTML_TEMPLATE, '__FV_CRASH_NONCE__')).toBe(1);
    expect(countOf(HTML_TEMPLATE, '__FV_CRASH_HASH__')).toBe(1);
    expect(countOf(HTML_TEMPLATE, '__FV_CRASH_SCRIPT__')).toBe(1);
  });

  it('injects one nonce into the meta CSP and the script tag, and the hash into the CSP', () => {
    const { html, csp } = injectEarlyCrashCapture(HTML_TEMPLATE, META_CSP, 'NONCE123');
    expect(countOf(html, 'NONCE123')).toBe(2);
    expect(html).toContain("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-NONCE123' 'sha256-");
    expect(csp).toContain("'nonce-NONCE123'");
    // Every token consumed: nothing is served with a literal placeholder
    // (the explanatory comment spells the family as `__FV_CRASH_*`, with a
    // glob, precisely so these assertions stay exact).
    for (const token of ['__FV_CRASH_NONCE__', '__FV_CRASH_HASH__', '__FV_CRASH_SCRIPT__']) {
      expect(html).not.toContain(token);
      expect(csp).not.toContain(token);
    }
    // The inline script lands before the module script that can crash on import.
    expect(html.indexOf('<script nonce="NONCE123">')).toBeLessThan(html.indexOf('<script type="module" src="index.js">'));
  });

  it('the CSP hash matches the injected inline script byte-for-byte', () => {
    const { html, csp } = injectEarlyCrashCapture(HTML_TEMPLATE, META_CSP, newCrashNonce());
    const inline = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(inline).toBe(EARLY_CRASH_SCRIPT_SRC);
    const hash = /'(sha256-[^']+)'/.exec(csp)![1];
    expect(hash).toBe(`sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}`);
    // The inline text cannot break out of its element: HTML ends a classic
    // inline script only at `</script`, and the nonce attribute is single-quoted.
    expect(inline).not.toMatch(/<\/script/i);
    expect(inline).not.toContain('"');
  });

  it('the response-header CSP template keeps the served meta CSP\u2019s directive skeleton', () => {
    const norm = (csp: string): string =>
      csp
        .replace(/'nonce-[^']+'|'sha256-[^']+'|'__FV_CRASH_HASH__'|'nonce-__FV_CRASH_NONCE__'/g, 'CRASH')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .join('; ');
    expect(norm(CSP_TEMPLATE)).toBe(norm(META_CSP));
  });

  it('a fresh nonce per load; alphabet carries no CSP delimiter', () => {
    const nonces = new Set([newCrashNonce(), newCrashNonce(), newCrashNonce()]);
    expect(nonces.size).toBe(3);
    for (const n of nonces) expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses to serve a template missing any token', () => {
    expect(() => injectEarlyCrashCapture('<html></html>', META_CSP, 'n')).toThrow(/crash-nonce token/);
    expect(() => injectEarlyCrashCapture(HTML_TEMPLATE, "default-src 'self'", 'n')).toThrow(/crash-nonce token/);
    expect(() =>
      injectEarlyCrashCapture(HTML_TEMPLATE.replace('__FV_CRASH_SCRIPT__', ''), META_CSP.replace('__FV_CRASH_HASH__', ''), 'n'),
    ).toThrow(/crash-script anchor/);
  });
});
