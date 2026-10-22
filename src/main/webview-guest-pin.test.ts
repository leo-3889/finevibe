import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { isWin } from './platform';
import { pinWebviewGuest, pinGuestPermissions, isBrowserGuestPreload } from './webview-guest-pin';
// The pinning resolves the guest session through `session.fromPartition`, so
// the electron module is mocked: the shipped stub has no session factory and
// the real one needs the binary. The recorder lives inside `vi.hoisted`
// because `vi.mock` factories are hoisted above module-scope `const`
// declarations, and a factory that closes over a plain `const` sees it
// uninitialized.
const { handlers, fromPartition } = vi.hoisted(() => {
  const handlers: Array<{
    partition: string;
    request?: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void;
    check?: (webContents: unknown, permission: string) => boolean;
  }> = [];
  const fromPartition = vi.fn((partition: string) => {
    const entry = { partition } as (typeof handlers)[number];
    handlers.push(entry);
    return {
      setPermissionRequestHandler: (h: (wc: unknown, p: string, cb: (g: boolean) => void) => void) => {
        entry.request = (_wc: unknown, p: string, cb: (g: boolean) => void) => h(_wc, p, cb);
      },
      setPermissionCheckHandler: (h: (wc: unknown, p: string) => boolean) => {
        entry.check = (_wc: unknown, p: string) => h(_wc, p);
      },
    };
  });
  return { handlers, fromPartition };
});

vi.mock('electron', () => ({ session: { fromPartition } }));


const SHIPPED = path.join('C:', 'app', 'preload', 'preload', 'browser-tab-preload.js');

function attach(webPreferences: Record<string, unknown>): void {
  pinWebviewGuest(webPreferences, SHIPPED);
}

function granted(partition: string, permission: string): boolean | undefined {
  const entry = handlers.find(h => h.partition === partition);
  if (!entry?.request) return undefined;
  let result: boolean | undefined;
  entry.request({}, permission, grantedValue => { result = grantedValue; });
  return result;
}

beforeEach(() => {
  handlers.length = 0;
  fromPartition.mockClear();
});

describe('pinWebviewGuest', () => {
  it('installs the guest allowlist on the partition the guest will use', () => {
    // The regression this pins: the handler used to read
    // `webPreferences.session`, a main-process Session object that never
    // crosses the renderer -> main boundary for a webview guest. The
    // allowlist silently never installed and Electron auto-approved every
    // permission in the partition holding imported Chrome cookies.
    attach({ partition: 'persist:finevibe-browser' });
    expect(fromPartition).toHaveBeenCalledWith('persist:finevibe-browser');
    expect(granted('persist:finevibe-browser', 'media')).toBe(false);
    expect(granted('persist:finevibe-browser', 'geolocation')).toBe(false);
    expect(granted('persist:finevibe-browser', 'notifications')).toBe(false);
    // The app's host allowlist must not leak into the guest: the guest page
    // has no business reading the clipboard.
    expect(granted('persist:finevibe-browser', 'clipboard-read')).toBe(false);
    expect(granted('persist:finevibe-browser', 'fullscreen')).toBe(true);
    expect(granted('persist:finevibe-browser', 'clipboard-sanitized-write')).toBe(true);
  });

  it('applies the same allowlist to the synchronous check handler', () => {
    attach({ partition: 'persist:finevibe-browser-iso-7' });
    const entry = handlers.find(h => h.partition === 'persist:finevibe-browser-iso-7');
    expect(entry?.check).toBeDefined();
    expect(entry?.check?.({}, 'media')).toBe(false);
    expect(entry?.check?.({}, 'fullscreen')).toBe(true);
  });

  it('covers the per-session isolated partitions, each resolved by its own name', () => {
    attach({ partition: 'persist:finevibe-browser-iso-1' });
    attach({ partition: 'persist:finevibe-browser-iso-2' });
    expect(fromPartition).toHaveBeenCalledTimes(2);
    expect(handlers.map(h => h.partition)).toEqual([
      'persist:finevibe-browser-iso-1',
      'persist:finevibe-browser-iso-2',
    ]);
  });

  it('leaves the app session alone when the guest has no partition', () => {
    // An empty partition puts the guest in the app session, which already
    // carries the host allowlist. Overwriting it with the narrower guest set
    // would break the app UI's own clipboard reads.
    expect(pinGuestPermissions(undefined)).toBe(false);
    expect(pinGuestPermissions('')).toBe(false);
    expect(fromPartition).not.toHaveBeenCalled();
    attach({});
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it('forces the privilege shape regardless of what the renderer asked for', () => {
    const webPreferences = {
      partition: 'persist:finevibe-browser',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      // P2-115: `webpreferences` is renderer-authored (browser-tab pane), so
      // a compromised renderer can ask for a nested <webview> the guest page
      // then attaches into the SAME partition — with no pinning applied.
      webviewTag: true,
    };
    attach(webPreferences);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.webviewTag).toBe(false);
  });

  it('keeps only the shipped browser-tab preload', () => {
    const withShipped: Record<string, unknown> = { preload: SHIPPED, partition: 'p' };
    attach(withShipped);
    expect(withShipped.preload).toBe(SHIPPED);

    for (const foreign of [
      path.join('C:', 'app', 'preload', 'preload', 'evil-preload.js'),
      path.join('C:', 'app', 'preload', 'preload', '..', '..', 'main', 'main.js'),
      'https://example.invalid/preload.js',
      '',
    ]) {
      const prefs: Record<string, unknown> = { preload: foreign, partition: 'p' };
      attach(prefs);
      expect(prefs.preload, foreign).toBeUndefined();
    }

    const noPreload: Record<string, unknown> = { partition: 'p' };
    attach(noPreload);
    expect(noPreload.preload).toBeUndefined();
  });

  // Verbatim-keep of a matching `file://` spelling is the Windows renderer
  // contract (see isBrowserGuestPreload below).
  it.runIf(process.platform === 'win32')('keeps a file://-spelled shipped preload verbatim', () => {
    // A matching attribute is kept VERBATIM: the pin strips only preloads it
    // cannot vouch for, it never rewrites one it accepts.
    const withFileUrl: Record<string, unknown> = { preload: `file://${SHIPPED}`, partition: 'p' };
    attach(withFileUrl);
    expect(withFileUrl.preload).toBe(`file://${SHIPPED}`);
  });
});

describe('isBrowserGuestPreload', () => {
  it('normalizes the shipped path across encodings', () => {
    expect(isBrowserGuestPreload(SHIPPED, SHIPPED)).toBe(true);
    expect(isBrowserGuestPreload(`  ${SHIPPED}  `, SHIPPED)).toBe(true);
    expect(isBrowserGuestPreload(encodeURI(SHIPPED), SHIPPED)).toBe(true);
  });

  // The renderer writes `file://${nativePath}`; on Windows that is not a
  // valid file URL, so the pin strips the scheme and compares the remainder
  // as a plain path. On POSIX the same spelling parses as a real file URL
  // and resolves to a POSIX path — the Windows spelling is the contract.
  it.runIf(process.platform === 'win32')('accepts the file:// spellings a Windows renderer writes', () => {
    expect(isBrowserGuestPreload(`file://${SHIPPED}`, SHIPPED)).toBe(true);
    // A non-ASCII path percent-encoded by the renderer still matches.
    expect(isBrowserGuestPreload(`file://${encodeURI(path.join('C:', 'café', 'browser-tab-preload.js'))}`, path.join('C:', 'café', 'browser-tab-preload.js'))).toBe(true);
  });

  it('matches case-insensitively only on Windows', () => {
    const upper = SHIPPED.toUpperCase();
    expect(isBrowserGuestPreload(upper, SHIPPED)).toBe(isWin);
  });

  it('rejects a path that only shares a prefix with the shipped preload', () => {
    expect(isBrowserGuestPreload(`${SHIPPED}.bak`, SHIPPED)).toBe(false);
    expect(isBrowserGuestPreload(`${SHIPPED}x`, SHIPPED)).toBe(false);
  });
});
