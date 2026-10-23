import { app, Menu, BrowserWindow } from 'electron';
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
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'pasteAndMatchStyle' as const },
        { role: 'delete' as const },
        { role: 'selectAll' as const },
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
            accelerator: isMac ? 'Command+Shift+R' : 'Ctrl+Shift+F5',
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
