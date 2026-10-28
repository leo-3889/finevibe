// Test-only stub for the `electron` module.
//
// CI installs dependencies with ELECTRON_SKIP_BINARY_DOWNLOAD=1, so the real
// `node_modules/electron/index.js` throws ("Electron failed to install
// correctly") the moment it is imported. Several main-process modules
// value-import from 'electron' (e.g. `import { BrowserWindow } from 'electron'`
// in hook-status.ts), and those modules are pulled in transitively by provider
// and pty-manager tests. Aliasing 'electron' to this stub in vitest.config.ts
// keeps those suites from loading the real binary-backed module.
//
// Only the surface that test-reachable code touches needs to exist. Members are
// no-op fakes; tests that exercise electron behaviour should mock it explicitly.

const noop = () => {};

class BrowserWindow {
  static getAllWindows() {
    return [] as BrowserWindow[];
  }
  static fromWebContents() {
    return null;
  }
  webContents = { send: noop };
}

export { BrowserWindow };

export const app = {
  getPath: () => '/mock/app-path',
  getName: () => 'FineVibe',
  getVersion: () => '0.0.0-test',
  on: noop,
  // main.ts sets the Windows AppUserModelID at boot (see startMainProcess);
  // the stub records nothing, so suites that assert on it mock 'electron'
  // explicitly (main-app-user-model-id.test.ts).
  setAppUserModelId: noop,
  whenReady: () => Promise.resolve(),
  quit: noop,
};

export const ipcMain = {
  on: noop,
  handle: noop,
  removeHandler: noop,
  removeAllListeners: noop,
};

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
};

export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: noop,
};

export const clipboard = {
  writeText: noop,
  readText: () => '',
};

export const Menu = Object.assign(class Menu {}, {
  buildFromTemplate: () => ({ popup: noop }),
  setApplicationMenu: noop,
});

export const powerMonitor = {
  on: noop,
};

export const session = {
  defaultSession: { cookies: { set: () => Promise.resolve() } },
};

// app-scheme.ts value-imports these at module scope (protocol registration +
// net.fetch in the handler); tests only exercise its pure functions, so
// registration is recorded and fetch is never called.
export const protocol = { registerSchemesAsPrivileged: noop, handle: noop };
export const net = { fetch: () => Promise.reject(new Error('electron-stub: net.fetch is not implemented')) };

export default {
  BrowserWindow,
  app,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  powerMonitor,
  session,
  protocol,
  net,
};
