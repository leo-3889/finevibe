// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appStateMock = { preferences: { debugMode: false } };
vi.mock('../../state.js', () => ({ appState: appStateMock }));

type AvailableHandler = (info: { version: string }) => void;
type ErrorHandler = () => void;

// The real channel resolves to auto-updater's UpdateCheckResult (or undefined
// from an older main); renderer/types.ts still declares Promise<void>.
const checkNow = vi.fn<[], Promise<unknown>>();
const availableHandlers: AvailableHandler[] = [];
const errorHandlers: ErrorHandler[] = [];

// Mimics the preload bridge: every registration returns a closure that
// removes exactly its own listener. The test counts what survives.
function register<T extends (...args: never[]) => void>(list: T[]) {
  return (cb: T) => {
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  availableHandlers.length = 0;
  errorHandlers.length = 0;
  checkNow.mockResolvedValue(undefined);
  (window as unknown as { finevibe: unknown }).finevibe = {
    app: { getVersion: () => Promise.resolve('1.0.0'), openExternal: vi.fn() },
    update: {
      checkNow,
      onAvailable: register(availableHandlers),
      onError: register(errorHandlers),
    },
  };
});

async function mount() {
  const { createAboutSection } = await import('./about-section.js');
  const { t } = await import('../../i18n.js');
  const container = document.createElement('div');
  createAboutSection().render(container);
  return {
    t,
    btn: container.querySelector('.about-update-btn') as HTMLButtonElement,
    status: container.querySelector('.about-update-status') as HTMLElement,
  };
}

describe('update-check listener lifecycle (P3-1)', () => {
  it('the "up to date" branch unregisters the listener pair', async () => {
    const { btn, status, t } = await mount();

    for (let i = 0; i < 2; i++) {
      btn.disabled = false;
      btn.click();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(status.textContent).toBe(t('about.upToDate'));
    }

    // Two fruitless checks, zero survivors: a leaked pair would make the
    // next `update:available` run stale callbacks from both checks.
    expect(availableHandlers).toHaveLength(0);
    expect(errorHandlers).toHaveLength(0);
  });

  it('the "available" branch unregisters the whole pair, not just its own', async () => {
    const { btn, status, t } = await mount();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(availableHandlers).toHaveLength(1);
    expect(errorHandlers).toHaveLength(1);

    availableHandlers[0]({ version: '9.9.9' });
    expect(status.textContent).toBe(t('about.updateAvailable', { version: '9.9.9' }));
    expect(availableHandlers).toHaveLength(0);
    expect(errorHandlers).toHaveLength(0);
  });

  it('the "failed" branch unregisters the whole pair', async () => {
    const { btn, status, t } = await mount();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(errorHandlers).toHaveLength(1);

    errorHandlers[0]();
    expect(status.textContent).toBe(t('about.updateFailed'));
    expect(errorHandlers).toHaveLength(0);
    expect(availableHandlers).toHaveLength(0);
  });

  // Rows 57/64/65: main gates auto-update per install (deb, portable, foreign
  // feed) and reports the reason on the channel. The pane must show it, not a
  // fabricated "Update available"/"Update failed" for a check that never ran.
  it('a gated install shows the reported reason and registers no listeners', async () => {
    checkNow.mockResolvedValue({ disabled: 'deb install: the linux feed ships the AppImage only' });
    const { btn, status, t } = await mount();
    btn.click();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(status.textContent).toContain('deb install');
    expect(status.textContent).not.toBe(t('about.upToDate'));
    expect(status.textContent).not.toBe(t('about.updateFailed'));
    expect(availableHandlers).toHaveLength(0);
    expect(errorHandlers).toHaveLength(0);
    // Re-enabled: the gate is per install, the button is not a one-shot.
    expect(btn.disabled).toBe(false);
  });
});
