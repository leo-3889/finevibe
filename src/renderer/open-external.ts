/**
 * Open a URL in the user's default browser — the single choke point for every
 * renderer `app:openExternal` call.
 *
 * The `app:openExternal` invoke rejects when nothing answers the OS: a
 * headless session or a Linux box with no default browser (the common
 * xdg-open-missing case), or an app tearing down mid-click. Every renderer
 * call site used to fire the promise bare, leaking an unhandled rejection per
 * click. This helper owns the catch: failures are console-only, matching
 * every other silent-open path in the renderer, and it never rejects, so
 * callers fire it off with a bare `void`. The boolean return lets callers that
 * care branch on success.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await window.finevibe.app.openExternal(url);
    return true;
  } catch (err: unknown) {
    console.warn(`[open-external] could not open ${url}`, err);
    return false;
  }
}
