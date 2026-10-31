import { app, Menu, BrowserWindow } from 'electron';
import { RELOAD_MAIN_WINDOW_ACCELERATOR } from '../shared/constants';
import { isMac, isWin, isLinux } from './platform';

export function createAppMenu(debugMode = false): void {

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+Shift+P',
          registerAccelerator: false,
          click: () => sendToRenderer('menu:new-project'),
        },
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: false,
          click: () => sendToRenderer('menu:new-session'),
        },
        { type: 'separator' },
        isMac ? {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+W',
          registerAccelerator: false,
          click: () => sendToRenderer('menu:close-session'),
        } : {
          // Menu quit accelerator: role:'quit' registers a Ctrl+Q accelerator on
          // win/linux, stealing the XON flow-control byte from xterm.js
          // PTYs. A custom item claims no key — the renderer owns the
          // Ctrl+W/Ctrl+Q session semantics. app.quit() here is NOT a raw
          // quit: main.ts before-quit gates on isCloseConfirmed() and
          // routes through requestConfirmClose() — the same close pipeline
          // as mainWindow 'close' — before the flushState/killAllPtys
          // teardown runs.
          label: 'Quit',
          registerAccelerator: false,
          click: () => app.quit(),
        },
        ...(isMac ? [{
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => { BrowserWindow.getFocusedWindow()?.close(); },
        }] : []),
      ],
    },
    {
      label: 'Edit',
      // On Windows and Linux (GTK), role-based items register Ctrl+C/V/X/Z/A
      // as menu-bar accelerators which steal keystrokes from xterm.js
      // terminals before the renderer sees them.
      // Use custom items without accelerators — Chromium still handles
      // these shortcuts natively in regular DOM inputs/textareas.
      submenu: isWin || isLinux ? [
        { label: 'Undo', click: () => focusedContents()?.undo() },
        { label: 'Redo', click: () => focusedContents()?.redo() },
        { type: 'separator' as const },
        { label: 'Cut', click: () => focusedContents()?.cut() },
        { label: 'Copy', click: () => focusedContents()?.copy() },
        { label: 'Paste', click: () => focusedContents()?.paste() },
        { label: 'Delete', click: () => focusedContents()?.delete() },
        { label: 'Select All', click: () => focusedContents()?.selectAll() },
      ] : [
        // macOS row 92/70: a role item registers its default accelerator
        // (registerAccelerator defaults to true), so macOS claims Cmd+Z/X/C/V/A
        // at the menu bar BEFORE the renderer — xterm's customKeyEventHandler
        // never sees them and the role acts on xterm's hidden helper textarea
        // (Select All is a visual no-op, undo/cut land in the textarea). An
        // empty accelerator keeps the label and the click action while
        // claiming no key; these five are the chords a focused PTY needs, and
        // terminal-utils.ts routes them from there. Redo/pasteAndMatchStyle/
        // Delete stay claimed: none is a byte a PTY expects.
        //
        // Ordinary inputs keep working: unregistering a MENU accelerator does
        // not disable Chromium's own editing commands. Cmd+C/V/X/Z/A in an
        // <input>/<textarea> are handled by the browser's editable-element
        // behavior, which is exactly how the unclaimed Cmd+V paste path (the
        // paste event attachImagePasteHandler listens for) already reaches the
        // renderer here.
        { role: 'undo' as const, accelerator: '' },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const, accelerator: '' },
        { role: 'copy' as const, accelerator: '' },
        { role: 'paste' as const, accelerator: '' },
        { role: 'pasteAndMatchStyle' as const },
        { role: 'delete' as const },
        { role: 'selectAll' as const, accelerator: '' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Split Mode',
          accelerator: 'CmdOrCtrl+\\',
          registerAccelerator: false,
          click: () => sendToRenderer('menu:toggle-split'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Session Inspector',
          accelerator: 'CmdOrCtrl+Shift+I',
          registerAccelerator: false,
          click: () => sendToRenderer('menu:toggle-inspector'),
        },
        ...(debugMode ? [
          {
            label: 'Toggle Debug Panel',
            accelerator: 'CmdOrCtrl+Shift+D',
            registerAccelerator: false,
            click: () => sendToRenderer('menu:toggle-debug'),
          },
          { type: 'separator' as const },
          {
            role: 'toggleDevTools' as const,
            // C4S-02: the role's default accelerator is Ctrl+Shift+I on
            // win/linux — the exact key the registered 'toggle-inspector'
            // shortcut needs. An empty accelerator keeps the menu entry
            // while claiming no key.
            accelerator: '',
          },
          {
            label: 'Reload Main Window',
            // C4S-03: Ctrl+Alt+R is AltGr+R on many non-US layouts, so the
            // AltGr half of a dead-key/compose press would fire a reload.
            // Row 99: the chord is display-only HERE but real in the renderer —
            // the same shared constant is the `reload-main-window` shortcut's
            // default keys, so the printed keys fire the same action on all
            // three platforms (the old Command+Shift+R display collided with
            // the browser-tab hard reload, and Ctrl+Shift+F5 was bound by
            // nothing on win/linux).
            accelerator: RELOAD_MAIN_WINDOW_ACCELERATOR,
            registerAccelerator: false,
            click: () => BrowserWindow.getFocusedWindow()?.reload(),
          },
        ] : []),
      ],
    },
    ...(isMac ? [{
      label: 'Window',
      role: 'window' as const,
      submenu: [
        { role: 'minimize' as const },
        // The renderer owns Cmd+W (File → Close Session above); an empty
        // accelerator keeps the entry while claiming no key.
        { role: 'close' as const, accelerator: '' },
      ],
    }] : []),
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function focusedContents(): Electron.WebContents | undefined {
  return BrowserWindow.getFocusedWindow()?.webContents;
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    win.webContents.send(channel, ...args);
  }
}
