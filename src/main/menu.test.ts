import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RELOAD_MAIN_WINDOW_ACCELERATOR } from '../shared/constants';

// Menu-accelerator guard. The win/linux GTK menu bar claims role-based
// accelerators (Ctrl+C/V/X/Z/A, Ctrl+Q) before the renderer/xterm.js sees
// them, so on those platforms the template must register NO accelerator at
// all: every custom item is registerAccelerator:false, every role item uses
// accelerator:''. The Quit item is a custom entry whose click routes through
// app.quit() — the main.ts before-quit close-confirm pipeline, not a raw
// flush-skipping quit. These tests drive createAppMenu with mocked platform
// getters and inspect the captured buildFromTemplate argument.

type MenuTemplate = Array<Record<string, unknown>>;

const { state, electron } = vi.hoisted(() => {
  const state = {
    templates: [] as MenuTemplate[],
    quit: vi.fn(),
    send: vi.fn(),
    focusedWindow: undefined as { webContents: { send: (...args: unknown[]) => void } } | undefined,
  };
  const electron = {
    app: { name: 'FineVibe', quit: state.quit },
    Menu: {
      buildFromTemplate: (template: MenuTemplate) => {
        state.templates.push(template);
        return { items: [] };
      },
      setApplicationMenu: vi.fn(),
    },
    BrowserWindow: { getFocusedWindow: () => state.focusedWindow },
  };
  return { state, electron };
});

vi.mock('electron', () => electron);

/** Fresh menu.ts import per platform combo: the platform getters are
 * module-level constants, so each case needs a resetModules + doMock. */
async function buildTemplate(platform: {
  isMac?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
}): Promise<MenuTemplate> {
  vi.resetModules();
  state.templates.length = 0;
  vi.doMock('./platform', () => ({
    isMac: false,
    isWin: false,
    isLinux: false,
    ...platform,
  }));
  const { createAppMenu } = await import('./menu');
  // debugMode=true: the toggleDevTools role (the only role item left on
  // win/linux) is part of the template and must not claim a key.
  createAppMenu(true);
  return state.templates[0];
}

function flatten(template: MenuTemplate): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of template) {
    out.push(item);
    const submenu = item.submenu;
    if (Array.isArray(submenu)) out.push(...flatten(submenu as MenuTemplate));
  }
  return out;
}

function submenuOf(template: MenuTemplate, label: string): MenuTemplate {
  const top = template.find((i) => i.label === label);
  return (top?.submenu ?? []) as MenuTemplate;
}

/** Accelerators the native menu bar actually registers: present, non-empty,
 * and not opted out via registerAccelerator:false. */
function claimedAccelerators(items: Array<Record<string, unknown>>): string[] {
  return items
    .filter((i) => typeof i.accelerator === 'string' && i.accelerator !== '' && i.registerAccelerator !== false)
    .map((i) => `${String(i.label ?? i.role)}: ${String(i.accelerator)}`);
}

beforeEach(() => {
  state.quit.mockClear();
  state.send.mockClear();
  state.focusedWindow = undefined;
});

describe.each([
  ['linux', { isLinux: true }],
  ['windows', { isWin: true }],
])('%s menu claims no accelerator', (_name, platform) => {
  it('uses the accelerator-free custom Edit submenu', async () => {
    const template = await buildTemplate(platform);
    const edit = submenuOf(template, 'Edit');
    expect(edit.map((i) => i.label)).toEqual([
      'Undo', 'Redo', undefined, 'Cut', 'Copy', 'Paste', 'Delete', 'Select All',
    ]);
    for (const item of edit) {
      expect(item.role).toBeUndefined();
      expect(item.accelerator).toBeUndefined();
    }
  });

  it('replaces the Ctrl+Q quit role with a custom Quit item', async () => {
    const template = await buildTemplate(platform);
    const items = flatten(template);
    expect(items.some((i) => i.role === 'quit')).toBe(false);
    const quit = submenuOf(template, 'File').find((i) => i.label === 'Quit');
    expect(quit).toBeDefined();
    expect(quit!.accelerator).toBeUndefined();
    expect(quit!.registerAccelerator).toBe(false);
    // Clicking goes through app.quit() → the main.ts before-quit gate →
    // requestConfirmClose()/flushState teardown.
    (quit!.click as () => void)();
    expect(state.quit).toHaveBeenCalledTimes(1);
  });

  it('registers no menu-bar accelerator anywhere (debug template included)', async () => {
    const template = await buildTemplate(platform);
    expect(claimedAccelerators(flatten(template))).toEqual([]);
  });

  // Row 77 negative half: Preferences… is a macOS convention (and the one
  // non-role accelerator in the template), so win/linux keep the sidebar gear
  // as their only entry and their zero-claimed-accelerator invariant.
  it('offers no Preferences item off macOS', async () => {
    const template = await buildTemplate(platform);
    expect(flatten(template).some((i) => i.label === 'Preferences…')).toBe(false);
  });

  // Row 99: every displayed accelerator must be a chord something actually
  // binds. Reload Main Window prints the shared constant that the renderer
  // registers for real (shortcuts.ts `reload-main-window`), so the label and
  // the behavior agree: display-only here (the native bar must claim no key —
  // F5 belongs to the terminal), live in the renderer.
  it('prints the reload chord the renderer really binds, on every platform', async () => {
    const template = await buildTemplate(platform);
    const reload = flatten(template).find((i) => i.label === 'Reload Main Window');
    expect(reload).toBeDefined();
    expect(reload!.accelerator).toBe(RELOAD_MAIN_WINDOW_ACCELERATOR);
    expect(reload!.registerAccelerator).toBe(false);
  });
});

describe('mac menu', () => {
  it('keeps the role-based Edit submenu', async () => {
    const template = await buildTemplate({ isMac: true });
    const roles = submenuOf(template, 'Edit').map((i) => i.role);
    expect(roles).toContain('undo');
    expect(roles).toContain('cut');
    expect(roles).toContain('selectAll');
  });

  it('carries the standard app-menu roles', async () => {
    const template = await buildTemplate({ isMac: true });
    const appMenu = submenuOf(template, 'FineVibe');
    const roles = appMenu.map((i) => i.role);
    for (const role of ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']) {
      expect(roles).toContain(role);
    }
  });

  it('has a Window submenu with minimize and an accelerator-free close', async () => {
    const template = await buildTemplate({ isMac: true });
    const win = submenuOf(template, 'Window');
    const minimize = win.find((i) => i.role === 'minimize');
    const close = win.find((i) => i.role === 'close');
    expect(minimize).toBeDefined();
    expect(close).toBeDefined();
    // Cmd+W belongs to File → Close Session; the role must claim no key.
    expect(close!.accelerator).toBe('');
  });

  // Row 92 (+ its row-70 Cmd+C sibling): the mac Edit roles must keep their
  // labels and click actions but claim no key, or macOS intercepts Cmd+Z/X/C/V/A
  // before xterm's customKeyEventHandler and the role acts on the hidden helper
  // textarea. Same accelerator:'' idiom the toggleDevTools/role:close rows use.
  it('keeps the Edit role labels while freeing the terminal chords', async () => {
    const template = await buildTemplate({ isMac: true });
    const edit = submenuOf(template, 'Edit');
    for (const role of ['undo', 'cut', 'copy', 'paste', 'selectAll']) {
      const item = edit.find((i) => i.role === role);
      expect(item, `role ${role} stays in the menu`).toBeDefined();
      expect(item!.accelerator).toBe('');
      expect(item!.registerAccelerator).toBeUndefined();
    }
    expect(claimedAccelerators(edit)).toEqual([]);
  });

  it('leaves the non-terminal Edit roles on their defaults', async () => {
    // Negative check: only the five PTY chords were touched. Redo (Cmd+Shift+Z),
    // pasteAndMatchStyle (Cmd+Shift+V) and Delete are not bytes a shell or
    // readline expects, so they keep the role's own accelerator.
    const template = await buildTemplate({ isMac: true });
    const edit = submenuOf(template, 'Edit');
    for (const role of ['redo', 'pasteAndMatchStyle', 'delete']) {
      expect(edit.find((i) => i.role === role)!.accelerator).toBeUndefined();
    }
  });

  // Row 99 (mac is where the display lied): the item used to print ⇧⌘R, the
  // chord the renderer binds to the browser-tab HARD reload — so the menu
  // showed one action and the key did another. It now prints the same shared
  // constant win/linux show and the renderer binds.
  it('prints the reload chord the renderer really binds', async () => {
    const template = await buildTemplate({ isMac: true });
    const reload = flatten(template).find((i) => i.label === 'Reload Main Window');
    expect(reload).toBeDefined();
    expect(reload!.accelerator).toBe(RELOAD_MAIN_WINDOW_ACCELERATOR);
    expect(reload!.accelerator).not.toBe('Command+Shift+R');
    expect(reload!.registerAccelerator).toBe(false);
    // Display-only: it must not join the claimed set (Preferences and Close
    // Window are the two real ones), or macOS would eat the event before the
    // renderer.
    expect(claimedAccelerators(flatten(template))).toEqual([
      'Preferences…: CmdOrCtrl+,',
      'Close Window: CmdOrCtrl+Shift+W',
    ]);
  });

  // Row 77: Cmd+, was dead — no menu anywhere carried a Preferences item, so
  // the sidebar gear was the only entry to the settings modal. Row 99's lesson
  // is that a displayed chord must be a chord something binds; here the
  // mac menu binds it itself. `registerAccelerator` is left at its default
  // because Cmd+, is not a byte a shell or readline expects (unlike the
  // Cmd+Z/X/C/V/A chords row 92/70 had to free), and a native accelerator
  // still fires while an <input> owns the keyboard — the renderer's shortcut
  // dispatcher suppresses app chords there, so this is the one item that must
  // claim its key to behave like a macOS Preferences item.
  it('registers Preferences… on Cmd+, between About and Services', async () => {
    const template = await buildTemplate({ isMac: true });
    const appMenu = submenuOf(template, 'FineVibe');
    const prefs = appMenu.find((i) => i.label === 'Preferences…');
    expect(prefs).toBeDefined();
    expect(prefs!.accelerator).toBe('CmdOrCtrl+,');
    expect(prefs!.registerAccelerator).toBeUndefined();
    const roles = appMenu.map((i) => i.role);
    expect(roles.indexOf('about')).toBeLessThan(appMenu.indexOf(prefs!));
    expect(appMenu.indexOf(prefs!)).toBeLessThan(roles.indexOf('services'));
  });

  // The click half of the chord: menu → `menu:open-preferences` → preload
  // onOpenPreferences → keybindings showPreferencesModal(), i.e. the same
  // modal the gear opens.
  it('forwards a Preferences… click to the focused window', async () => {
    const template = await buildTemplate({ isMac: true });
    const prefs = flatten(template).find((i) => i.label === 'Preferences…');
    state.focusedWindow = { webContents: { send: state.send } };

    (prefs!.click as () => void)();

    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send).toHaveBeenCalledWith('menu:open-preferences');
  });

  it('claims exactly two accelerators: Preferences Cmd+, and Close Window Cmd+Shift+W', async () => {
    // command, not a PTY byte, and row 117 tracks its confirm-gating concern
    // separately. Every other entry is registerAccelerator:false, an empty
    // accelerator, or a role left on its default (hide/quit ⇒ Cmd+H/Cmd+Q:
    // invisible to this template-level check, and no shell or readline binding
    // — only the Cmd+Z/X/C/V/A chords above ever reached xterm as bytes).
    const template = await buildTemplate({ isMac: true });
    expect(claimedAccelerators(flatten(template))).toEqual([
      'Preferences…: CmdOrCtrl+,',
      'Close Window: CmdOrCtrl+Shift+W',
    ]);
  });
});
