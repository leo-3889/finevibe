import { readFileSync } from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { APP_INDEX_URL, isAppDocumentUrl, resolveAppPath } from './app-scheme';

// app-scheme.ts serves the renderer bundle over the privileged app:// scheme
// (P3). The handler needs a live Electron protocol registry, so what is testable
// headlessly is the two pure decisions it is built from — which file a request
// maps to, and which URL counts as the app document — plus the wiring order in
// main.ts that Electron requires.

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
