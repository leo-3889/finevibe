import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAllWindows = vi.hoisted(() => vi.fn());
const getAllDisplays = vi.hoisted(() => vi.fn());
const loadState = vi.hoisted(() => vi.fn());
const saveStateSync = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
  screen: { getAllDisplays },
}));
vi.mock('./store', () => ({ loadState, saveStateSync }));

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

describe('restoredWindowBounds (audit row 79)', () => {
  const display = (x: number, y: number, width: number, height: number) => ({ workArea: { x, y, width, height } });
  const bounds = { x: 120, y: 60, width: 1280, height: 800 };

  beforeEach(() => {
    getAllDisplays.mockReturnValue([display(0, 0, 1920, 1080)]);
    loadState.mockReturnValue({ version: 1, projects: [], activeProjectId: null, windowBounds: bounds });
  });

  it('restores the persisted bounds when they sit inside a work area', async () => {
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toEqual(bounds);
  });

  it('restores bounds on a secondary display left of the primary', async () => {
    getAllDisplays.mockReturnValue([display(0, 0, 1920, 1080), display(-1920, 0, 1920, 1080)]);
    loadState.mockReturnValue({ windowBounds: { x: -1700, y: 100, width: 1280, height: 800 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toEqual({ x: -1700, y: 100, width: 1280, height: 800 });
  });

  it('drops bounds that only a monitor that is gone would show', async () => {
    // x 3000 is on-screen when a third display exists, off-screen once it is
    // unplugged — the invisible-window case the containment check exists for.
    loadState.mockReturnValue({ windowBounds: { x: 3000, y: 200, width: 1280, height: 800 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toBeNull();

    getAllDisplays.mockReturnValue([display(0, 0, 1920, 1080), display(1920, 0, 2560, 1440)]);
    expect(restoredWindowBounds()).toEqual({ x: 3000, y: 200, width: 1280, height: 800 });
  });

  it('drops a window a hand-edited state.json left with almost nothing on screen', async () => {
    // 1900 + 1280 overlaps the 1920 work area by 20 px: technically visible,
    // practically an unreachable title bar.
    loadState.mockReturnValue({ windowBounds: { x: 1900, y: 40, width: 1280, height: 800 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toBeNull();
  });

  // Row 79 follow-up: the containment check alone only asks "is 100 px of this
  // rect visible?", so the rect remembered on a 2560x1440 monitor passed on a
  // 1920x1080 screen and restored bigger than the display under it.
  it('clamps a remembered rect that is larger than the display it lands on', async () => {
    loadState.mockReturnValue({ windowBounds: { x: 0, y: 0, width: 2560, height: 1440 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('clamps against the display that actually holds the rect', async () => {
    // The rect lives on the small secondary; the big primary must not set the
    // ceiling, or the clamp lets the window hang off the screen it is on.
    getAllDisplays.mockReturnValue([display(0, 0, 2560, 1440), display(2560, 0, 1280, 1024)]);
    loadState.mockReturnValue({ windowBounds: { x: 2600, y: 20, width: 2560, height: 1440 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toEqual({ x: 2600, y: 20, width: 1280, height: 1024 });
  });

  it('clamps to a menu-bar-excluded work area, not the panel size', async () => {
    // macOS primary: workArea is the screen minus the menu bar / Dock.
    getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 25, width: 1440, height: 855 } }]);
    loadState.mockReturnValue({ windowBounds: { x: 0, y: 25, width: 1440, height: 900 } });
    const { restoredWindowBounds } = await fresh();
    expect(restoredWindowBounds()).toEqual({ x: 0, y: 25, width: 1440, height: 855 });
  });

  it('ignores malformed bounds instead of handing them to the constructor', async () => {
    for (const bad of [undefined, null, 'top', {}, { x: 0, y: 0, width: 0, height: 400 }, { x: '0', y: 0, width: 800, height: 600 }]) {
      loadState.mockReturnValue({ windowBounds: bad });
      const { restoredWindowBounds } = await fresh();
      expect(restoredWindowBounds(), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('saveWindowBounds (audit row 79)', () => {
  it('writes the live window bounds through the state store', async () => {
    const state = { version: 1 as const, projects: [], activeProjectId: null };
    loadState.mockReturnValue(state);
    const { saveWindowBounds } = await fresh();

    saveWindowBounds({ getBounds: () => ({ x: 120, y: 60, width: 1280, height: 800 }) } as never);

    expect(saveStateSync).toHaveBeenCalledTimes(1);
    expect(saveStateSync.mock.calls[0][0]).toEqual(
      expect.objectContaining({ windowBounds: { x: 120, y: 60, width: 1280, height: 800 } }),
    );
  });
});

describe('main.ts wiring (audit row 79)', () => {
  // The two call sites are the whole feature; the ordering below is the part
  // that silently regresses (a bounds write BEFORE flushState() is overwritten
  // by the renderer payload that flush carries). Static scan in the
  // ipc-channel-parity.test.ts idiom: no Electron boot, real source.
  const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts'), 'utf8');

  it('builds the window from the restored bounds, default size as the fallback', () => {
    expect(mainSource).toContain('...(restoredWindowBounds() ?? { width: 1400, height: 900 })');
  });

  it('saves the bounds on the confirmed close and restores them on create', () => {
    const start = mainSource.indexOf("mainWindow.on('close'");
    const handler = mainSource.slice(start, mainSource.indexOf("mainWindow.on('closed'", start));
    // Both halves of the lane, in the handler that only runs once the close is
    // confirmed. Order against flushState() is deliberately NOT pinned: the
    // store grafts `windowBounds` as a main-owned key, so the renderer's
    // whole-state flush can no longer rewrite it (store.ts graftMainOwnedState,
    // tested in store.test.ts row 79).
    expect(handler).toContain('saveWindowBounds(mainWindow)');
    expect(handler).toContain('flushState()');
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
