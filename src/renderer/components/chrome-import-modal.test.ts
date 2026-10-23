// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('./custom-select.js', () => ({
  createCustomSelect: vi.fn((id: string, options: { value: string; label: string }[], value: string) => ({
    element: document.createElement('div'),
    getValue: () => value,
    setValue: () => {},
    destroy: vi.fn(),
  })),
}));

const OVERLAY_ID = 'chrome-import-overlay';

let listProfiles: Mock;
let run: Mock;
let unsub: Mock;
let progressCbs: ((p: unknown) => void)[];

/** Flush the pending microtask chain; the modal's async handlers make no real timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

async function openModal(): Promise<HTMLElement> {
  // Dynamic import is deliberate: the modal keeps module-scope state
  // (cleanupFn, importInFlight) that vi.resetModules() clears per test —
  // a static import cannot observe the reset module graph.
  const { showChromeImportModal } = await import('./chrome-import-modal.js');
  await showChromeImportModal();
  return document.getElementById(OVERLAY_ID)!;
}

function importButton(overlay: HTMLElement): HTMLButtonElement {
  return overlay.querySelector('.modal-actions .btn-primary') as HTMLButtonElement;
}

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = '';
  listProfiles = vi.fn(async () => [{ id: 'Default', displayName: 'Default' }]);
  run = vi.fn();
  unsub = vi.fn();
  progressCbs = [];
  (window as unknown as { finevibe: unknown }).finevibe = {
    chromeImport: {
      listProfiles,
      run,
      onProgress: (cb: (p: unknown) => void) => {
        progressCbs.push(cb);
        // CI-10: unsubscribe drops the listener, like the real IPC bridge, so a
        // test can tell a detached generation's subscription from the live one.
        return () => {
          const i = progressCbs.indexOf(cb);
          if (i >= 0) progressCbs.splice(i, 1);
          unsub();
        };
      },
      summary: vi.fn(async () => ({ cookieCount: 0, lastImportedAt: 0 })),
      clearCookies: vi.fn(async () => {}),
    },
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('chrome-import-modal', () => {
  // P2-49: a failed import must show the reason to the user, not "0 errors".
  it('shows the failure reason in the summary when the import fails', async () => {
    run.mockResolvedValue({
      ok: false,
      cookieCount: 0,
      skippedV11: 0,
      errors: ['Cookies: macOS keychain access denied'],
    });
    const overlay = await openModal();
    importButton(overlay).click();
    await flush();
    const summary = overlay.querySelector('.chrome-import-summary');
    expect(summary?.textContent).toContain('macOS keychain access denied');
  });

  // Chrome 127+ on Windows writes the v20 App-Bound prefix; the summary
  // label says "Chrome App-Bound Encryption" (the old "(Chrome v11 ...)"
  // named a version Chrome never writes for Windows cookies).
  it('labels App-Bound skips without the stale v11 name', async () => {
    run.mockResolvedValue({
      ok: true,
      cookieCount: 5,
      skippedV11: 2,
      errors: [],
    });
    const overlay = await openModal();
    importButton(overlay).click();
    await flush();
    const summary = overlay.querySelector('.chrome-import-summary');
    expect(summary?.textContent).toContain('Skipped 2 entries (Chrome App-Bound Encryption)');
    expect(summary?.textContent).not.toContain('v11');
  });

  // P2-109: dismissing mid-import must detach the progress subscription
  // immediately (before the run settles) and stop late DOM writes.
  it('detaches the in-flight import when dismissed', async () => {
    const deferred = Promise.withResolvers<unknown>();
    run.mockReturnValue(deferred.promise);
    const overlay = await openModal();
    importButton(overlay).click();
    await flush();

    // Overlay background click = dismissal path (bindModalDismiss).
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.style.display).toBe('none');
    expect(unsub).toHaveBeenCalled();

    deferred.resolve({ ok: true, cookieCount: 5, skippedV11: 0, errors: [] });
    await flush();
    // The detached closure must not write a summary into the hidden DOM.
    expect(overlay.querySelector('.chrome-import-summary')).toBeNull();
  });

  // P2-109: re-opening while a detached import is still running must not
  // offer a second concurrent import.
  it('disables Import on re-open while an import is still running', async () => {
    const deferred = Promise.withResolvers<unknown>();
    run.mockReturnValue(deferred.promise);
    const overlay = await openModal();
    importButton(overlay).click();
    await flush();
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const overlay2 = await openModal();
    expect(overlay2).toBe(overlay); // cached shell node is reused
    const btn2 = importButton(overlay2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(btn2.disabled).toBe(true);

    // When the running import signals done, Import becomes available again.
    progressCbs[progressCbs.length - 1]!({ stage: 'done' });
    expect(btn2.disabled).toBe(false);

    deferred.resolve({ ok: true, cookieCount: 5, skippedV11: 0, errors: [] });
    await flush();
  });

  // UI2-6: open() awaits the Chrome profile scan mid-build, so a second click
  // during the scan used to build the modal a second time on the cached shell
  // node, leaving the first run's select + subscriptions orphaned.
  it('single-flights a second open while the profile scan is pending', async () => {
    const selectFactory = vi.mocked((await import('./custom-select.js')).createCustomSelect);
    const scan = Promise.withResolvers<{ id: string; displayName: string }[]>();
    listProfiles.mockReturnValue(scan.promise);

    const { showChromeImportModal } = await import('./chrome-import-modal.js');
    const first = showChromeImportModal();
    const second = showChromeImportModal(); // clicked again while the scan runs
    scan.resolve([{ id: 'Default', displayName: 'Default' }]);
    await Promise.all([first, second]);

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(selectFactory).toHaveBeenCalledTimes(1);
    const overlay = document.getElementById(OVERLAY_ID)!;
    expect(overlay.style.display).toBe('flex');
    expect(overlay.querySelectorAll('.chrome-import-profile-slot > div')).toHaveLength(1);
  });

  // CI-10: an open that replaces a LIVE generation (no dismissal in between)
  // ran only `cleanupFn` — the old generation kept its progress subscription,
  // never set `disposed`, and its owner's onClosed never fired.
  it('a replacing open dismisses the previous generation completely', async () => {
    const deferred = Promise.withResolvers<unknown>();
    run.mockReturnValue(deferred.promise);
    const closed: number[] = [];

    const { showChromeImportModal } = await import('./chrome-import-modal.js');
    await showChromeImportModal(() => closed.push(1));
    const overlay = document.getElementById(OVERLAY_ID)!;
    importButton(overlay).click();
    await flush();
    expect(progressCbs).toHaveLength(1);
    const oldProgress = progressCbs[0]!;

    await showChromeImportModal(); // re-open over the live modal
    expect(document.getElementById(OVERLAY_ID)).toBe(overlay); // cached shell reused
    expect(closed).toEqual([1]); // the superseded owner was notified
    expect(unsub).toHaveBeenCalled();
    // CI-10: its subscription is gone from the bridge; the only live one is the
    // re-opened modal's own view of the abandoned run.
    expect(progressCbs).not.toContain(oldProgress);
    expect(progressCbs).toHaveLength(1);

    deferred.resolve({ ok: true, cookieCount: 5, skippedV11: 0, errors: [] });
    await flush();
    expect(overlay.querySelector('.chrome-import-summary')).toBeNull();
  });
});
