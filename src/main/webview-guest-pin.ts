import { session } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isWin } from './platform';

/**
 * The pinning applied to every `<webview>` guest before it attaches
 * (`will-attach-webview` on the host webContents).
 *
 * A guest's `webpreferences` and `preload` are renderer-controlled (browser
 * tabs), and a guest loads arbitrary remote pages by design, so this is the
 * boundary where the renderer can influence a privileged process: pin the
 * privileges, never the destinations.
 *
 * It lives in its own module because `main.ts` runs the app lifecycle at
 * import time (single-instance lock, `app.whenReady`) and is excluded from
 * coverage: keeping the logic here is what makes it unit-testable.
 */

/** Web permission allowlists. Without handlers Electron auto-approves every
 * permission request, so arbitrary browser-tab pages could silently take
 * camera/mic/geolocation in the partition holding imported Chrome cookies.
 * The app UI only ever touches the clipboard (copy path, paste into the
 * terminal); guests keep page clipboard writes and fullscreen. */
const GUEST_PERMISSIONS: Record<string, true> = {
  'clipboard-sanitized-write': true,
  fullscreen: true,
};

/** Allowlist membership, own-keys only (a permission name is not attacker
 * controlled, but the lookup must not answer `true` for `constructor`). */
function isGuestPermission(permission: string): boolean {
  return Object.hasOwn(GUEST_PERMISSIONS, permission);
}

/** The subset of `Electron.WebPreferences` the pinning reads and writes. The
 * attributes arrive from the renderer as serializable data, so only strings
 * and booleans are ever present - never a `Session` object. */
interface GuestWebPreferences {
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webviewTag?: boolean;
  preload?: string;
  partition?: string;
}

/**
 * True when `preload` names the shipped browser-tab preload. The renderer
 * writes the attribute as `file://${nativePath}`, which on Windows is not a
 * valid file URL (`file://C:\...`), so the scheme is stripped and the
 * remainder compared as a plain path. Anything that does not normalize to the
 * shipped file - a renderer-chosen path, an encoded variant, a traversal -
 * falls off the exact-path compare.
 */
export function isBrowserGuestPreload(preload: string, expected: string): boolean {
  let candidate = preload.trim();
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      candidate = candidate.slice('file://'.length);
    }
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Not valid percent-encoding; compare the raw string (will not match).
  }
  candidate = path.normalize(candidate);
  return isWin
    ? candidate.toLowerCase() === expected.toLowerCase()
    : candidate === expected;
}

/**
 * Install the guest permission allowlist on the session the guest will
 * actually use.
 *
 * A `<webview>` guest's session is selected by its `partition` STRING, so the
 * handlers must be resolved from that string via `session.fromPartition`.
 * Reading `webPreferences.session` instead - the obvious-looking field - is
 * inert: that property holds a main-process `Session` object, and the
 * webPreferences crossing the renderer -> main boundary are serialized
 * attribute data, so it is never populated for a webview guest. The allowlist
 * then never installs and Electron's default auto-approves every permission
 * request in the guest partition.
 *
 * An empty/absent partition puts the guest in the app session, which already
 * carries the host allowlist (`HOST_PERMISSIONS`, installed in main.ts) - the
 * narrower guest set must not overwrite it there, because the app UI needs
 * `clipboard-read`.
 */
export function pinGuestPermissions(partition: string | undefined): boolean {
  if (typeof partition !== 'string' || partition === '') return false;
  const guestSession = session.fromPartition(partition);
  guestSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(isGuestPermission(permission)));
  guestSession.setPermissionCheckHandler((_wc, permission) => isGuestPermission(permission));
  return true;
}

/**
 * `will-attach-webview` handler body: Node integration off, context isolation
 * and sandbox forced on, `webviewTag` forced OFF so a remote page cannot nest
 * a `<webview>` into the guest's own partition (the imported Chrome cookie
 * jar) with an un-pinned webpreferences, a preload kept ONLY when it is the
 * shipped browser-tab preload, and the guest partition's permission allowlist
 * pinned.
 */
export function pinWebviewGuest(
  webPreferences: GuestWebPreferences,
  browserGuestPreload: string,
): void {
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  if (!webPreferences.preload || !isBrowserGuestPreload(webPreferences.preload, browserGuestPreload)) {
    // pi-lens-ignore: ts-delete-property
    delete webPreferences.preload;
  }
  pinGuestPermissions(webPreferences.partition);
}
