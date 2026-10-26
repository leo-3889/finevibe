// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initUpdateBanner } from './update-banner';

vi.mock('../i18n', () => ({ t: (key: string) => `T:${key}` }));

type UpdateEvent = 'onAvailable' | 'onDownloadProgress' | 'onDownloaded' | 'onError';
const listeners: Partial<Record<UpdateEvent, (info: { version?: string; percent?: number }) => void>> = {};

function setUpdateApi(): void {
  (window as unknown as { finevibe: unknown }).finevibe = {
    update: {
      onAvailable: (cb: typeof listeners.onAvailable) => { listeners.onAvailable = cb; },
      onDownloadProgress: (cb: typeof listeners.onDownloadProgress) => { listeners.onDownloadProgress = cb; },
      onDownloaded: (cb: typeof listeners.onDownloaded) => { listeners.onDownloaded = cb; },
      onError: (cb: typeof listeners.onError) => { listeners.onError = cb; },
      install: vi.fn(),
    },
  };
}

function mainArea(): HTMLElement | null {
  return document.getElementById('main-area');
}
function banner(): HTMLElement | null {
  return document.getElementById('update-banner');
}
function isHidden(): boolean {
  return banner()?.classList.contains('hidden') ?? true;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="main-area"></div>';
  for (const k of Object.keys(listeners)) delete listeners[k as UpdateEvent];
  setUpdateApi();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('update-banner (J-matrix #12)', () => {
  it('attaches as the first child of #main-area, hidden', () => {
    initUpdateBanner();
    expect(mainArea()!.firstElementChild!.id).toBe('update-banner');
    expect(isHidden()).toBe(true);
  });

  it('no #main-area: init is a no-op', () => {
    document.body.innerHTML = '';
    initUpdateBanner();
    expect(banner()).toBeNull();
    expect(listeners.onAvailable).toBeUndefined();
  });

  it('available -> visible "Downloading update v1.2.3..." with no action button', () => {
    initUpdateBanner();
    listeners.onAvailable!({ version: '1.2.3' });
    expect(isHidden()).toBe(false);
    expect(banner()!.querySelector('.update-banner-message')!.textContent).toBe('Downloading update v1.2.3...');
    expect(banner()!.querySelector('.update-banner-btn')!.classList.contains('hidden')).toBe(true);
  });

  it('progress renders the known version, falls back to "update" without one', () => {
    initUpdateBanner();
    listeners.onDownloadProgress!({ percent: 42 });
    expect(banner()!.querySelector('.update-banner-message')!.textContent).toBe('Downloading update... 42%');
    listeners.onAvailable!({ version: '1.2.3' });
    listeners.onDownloadProgress!({ percent: 60 });
    expect(banner()!.querySelector('.update-banner-message')!.textContent).toBe('Downloading v1.2.3... 60%');
  });

  it('downloaded -> "ready." + Restart button wired to update.install', () => {
    initUpdateBanner();
    listeners.onAvailable!({ version: '1.2.3' });
    listeners.onDownloaded!({ version: '1.2.3' });
    expect(banner()!.querySelector('.update-banner-message')!.textContent).toBe('Update v1.2.3 ready.');
    const btn = banner()!.querySelector('.update-banner-btn')! as HTMLButtonElement;
    expect(btn.classList.contains('hidden')).toBe(false);
    expect(btn.textContent).toBe('Restart');
    btn.click();
    expect((window as unknown as { finevibe: { update: { install: ReturnType<typeof vi.fn> } } }).finevibe.update.install)
      .toHaveBeenCalledTimes(1);
  });

  it('C4S-05: error during download replaces the stalled progress and auto-hides; idle error stays silent', () => {
    initUpdateBanner();
    // Idle error: nothing was in flight -> silent.
    listeners.onError!({});
    expect(isHidden()).toBe(true);
    // Now a download is in flight...
    listeners.onAvailable!({ version: '1.2.3' });
    listeners.onError!({});
    expect(banner()!.querySelector('.update-banner-message')!.textContent).toBe('T:update.downloadFailed');
    // ...and auto-hides after 5 s.
    vi.advanceTimersByTime(5001);
    expect(isHidden()).toBe(true);
  });
});
