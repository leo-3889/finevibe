/**
 * Row 26 slice 5: the `ipcMain.on` crash wrapper, moved out of
 * ipc-handlers.ts verbatim so the ipc/ domain modules can register `on`
 * channels (fs:watchDir / fs:unwatchDir) without importing back into
 * ipc-handlers.ts (the slice-1 seam contract).
 */
/**
 * An `ipcMain.on` body runs on Electron's main-process dispatch path, and
 * src/main installs no uncaughtException handler — a throw escaping an `on`
 * body is a fatal main-process exception that kills every live PTY and
 * window (P2-108; the P2-84 sendSync class). `ipcMain.handle` bodies are
 * safe (invoke rejects the promise), so only `on` bodies need this wrap:
 * log in the channels' console.warn convention and swallow. A sendSync
 * channel must always answer, and passes `syncFallback` — the benign shape
 * it replies with when the body throws.
 */
export type IpcOnHandler = (event: Electron.IpcMainEvent, ...args: any[]) => void;

export function safeOn(channel: string, fn: IpcOnHandler, syncFallback?: () => unknown): IpcOnHandler {
  return (event, ...args) => {
    try {
      fn(event, ...args);
    } catch (err) {
      console.warn(`${channel} failed:`, err);
      if (syncFallback) event.returnValue = syncFallback();
    }
  };
}
