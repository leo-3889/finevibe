import { afterEach, describe, expect, it, vi } from 'vitest';

// Audit row 104: the renderer used to derive isLinux as `!isMac && !isWin`, so
// any platform Chromium does not label MAC/WINDOWS (FreeBSD builds report
// `navigator.platform === ''`) read as Linux while main's
// `process.platform === 'linux'` said no. The derivation now reads the UA's
// `(X11; Linux ...)` token, so unknown platforms default false — like main.
// `navigator` is stubbed rather than switching to jsdom: both flags are read
// once at module load, so each case is a stub + fresh import.
async function loadPlatform(navigatorStub: { platform: string; userAgent: string }) {
  vi.resetModules();
  vi.stubGlobal('navigator', navigatorStub);
  return import('./platform');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// The UA shapes Electron/Chromium actually sends on each platform.
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) FineVibe/1.0.0 Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) FineVibe/1.0.0 Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FineVibe/1.0.0 Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36';
// Electron's FreeBSD port keeps the X11 product token but names the OS, so a
// "looks like Linux" UA must still read false.
const FREEBSD_UA = 'Mozilla/5.0 (X11; FreeBSD amd64) AppleWebKit/537.36 (KHTML, like Gecko) FineVibe/1.0.0 Chrome/130.0.6723.118 Electron/33.2.0 Safari/537.36';

describe('renderer platform detection (audit row 104)', () => {
  it('reports Linux from the Chromium Linux UA', async () => {
    const { isLinux, isMac, isWin } = await loadPlatform({ platform: 'Linux x86_64', userAgent: LINUX_UA });
    expect(isLinux).toBe(true);
    expect(isMac).toBe(false);
    expect(isWin).toBe(false);
  });

  it('does not report Linux on macOS', async () => {
    const { isLinux, isMac, isWin } = await loadPlatform({ platform: 'MacIntel', userAgent: MAC_UA });
    expect(isLinux).toBe(false);
    expect(isMac).toBe(true);
    expect(isWin).toBe(false);
  });

  it('does not report Linux on Windows', async () => {
    const { isLinux, isMac, isWin } = await loadPlatform({ platform: 'Win32', userAgent: WIN_UA });
    expect(isLinux).toBe(false);
    expect(isMac).toBe(false);
    expect(isWin).toBe(true);
  });

  it('defaults an unknown platform to false, matching main (FreeBSD UA)', async () => {
    const { isLinux, isMac, isWin } = await loadPlatform({ platform: '', userAgent: FREEBSD_UA });
    expect(isLinux).toBe(false);
    expect(isMac).toBe(false);
    expect(isWin).toBe(false);
  });

  it('defaults to false when navigator is missing entirely', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', undefined);
    const { isLinux, isMac, isWin } = await import('./platform');
    expect(isLinux).toBe(false);
    expect(isMac).toBe(false);
    expect(isWin).toBe(false);
  });
});
