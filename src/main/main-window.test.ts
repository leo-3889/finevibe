import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAllWindows = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
}));

type Win = { isDestroyed(): boolean; webContents: { send: ReturnType<typeof vi.fn> } };

const win = (destroyed = false): Win => ({
  isDestroyed: () => destroyed,
  webContents: { send: vi.fn() },
});

async function fresh() {
  vi.resetModules();
  return await import('./main-window');
}

describe('getMainWindow', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('returns the live window, and null when none exists or all are destroyed', async () => {
    const { getMainWindow } = await fresh();
    getAllWindows.mockReturnValue([]);
    expect(getMainWindow()).toBeNull();
    const dead = win(true);
    getAllWindows.mockReturnValue([dead]);
    expect(getMainWindow()).toBeNull();
    const live = win();
    getAllWindows.mockReturnValue([live]);
    expect(getMainWindow()).toBe(live);
  });

  it('skips a destroyed window in front of a live one', async () => {
    const { getMainWindow } = await fresh();
    const live = win();
    getAllWindows.mockReturnValue([win(true), live]);
    expect(getMainWindow()).toBe(live);
  });

  it('warns once (not per call) when the single-window invariant is broken', async () => {
    const { getMainWindow } = await fresh();
    getAllWindows.mockReturnValue([win(), win(), win()]);
    getMainWindow();
    getMainWindow();
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('single-window');
  });
});

describe('showAndFocusWindow', () => {
  type FrontWin = Win & {
    isMinimized(): boolean;
    isVisible(): boolean;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };

  const frontWin = (minimized: boolean, visible: boolean): FrontWin => ({
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });

  it('restores a minimized window and shows a hidden one before focusing', async () => {
    const { showAndFocusWindow } = await fresh();
    const win = frontWin(true, false);

    showAndFocusWindow(win as never);

    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves a visible, un-minimized window alone apart from the focus', async () => {
    const { showAndFocusWindow } = await fresh();
    const win = frontWin(false, true);

    showAndFocusWindow(win as never);

    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);
  });
});

describe('sendToMainWindow', () => {
  it('sends through the live window and no-ops when there is none', async () => {
    const { sendToMainWindow } = await fresh();
    const live = win();
    getAllWindows.mockReturnValue([live]);
    sendToMainWindow('pty:data', 's1', 'hello');
    expect(live.webContents.send).toHaveBeenCalledWith('pty:data', 's1', 'hello');

    getAllWindows.mockReturnValue([win(true)]);
    expect(() => sendToMainWindow('pty:data', 's1', 'dropped')).not.toThrow();
  });
});
