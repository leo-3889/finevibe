/**
 * Centralized platform detection for the renderer process.
 *
 * Import `isMac`/`isWin`/`isLinux` from here instead of inlining
 * `navigator.platform` checks. Mirrors `src/main/platform.ts` for
 * the main process.
 */

const platform = typeof navigator !== 'undefined' && navigator.platform
  ? navigator.platform.toUpperCase()
  : '';

const userAgent = typeof navigator !== 'undefined' && navigator.userAgent
  ? navigator.userAgent
  : '';

export const isMac = platform.indexOf('MAC') >= 0;
export const isWin = platform.indexOf('WIN') >= 0;
// Audit row 104: this used to be `!isMac && !isWin`, which made every unknown
// platform Linux while main (`process.platform === 'linux'`) says no — a
// FreeBSD-style build then promised the Linux keyring instructions and X11
// PRIMARY middle-click that main never writes. Chromium's Linux UA carries
// `(X11; Linux <arch>)`; FreeBSD's carries `(X11; FreeBSD ...)`, so the
// `Linux` token is what mirrors main and defaults unknown platforms to false.
export const isLinux = /\(X11; Linux/i.test(userAgent);
