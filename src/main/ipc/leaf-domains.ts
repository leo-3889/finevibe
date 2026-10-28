/**
 * Row 26 (code-cleanup audit) slice 1: the leaf IPC domains.
 *
 * `ipc-handlers.ts` is 3 157 lines and 106 registrations across 22 domains; the
 * domain prefixes are the split seams. This module takes the five handlers that
 * close over nothing from `registerIpcHandlers` except the known-project path
 * list, which arrives as an injected getter: `disk-health:get`,
 * `vibeyard:listImportableProjects`, `menu:rebuild`, `update:checkNow`,
 * `update:install`.
 *
 * The seam contract for every future slice, kept deliberately small:
 *  - the module registers its channels with string literals, so
 *    `ipc-channel-parity.test.ts` keeps pinning both ends (unregistered channel
 *    / dead handler) with no changes;
 *  - anything the handler needs from the big file's closure is an explicit
 *    dependency parameter, never an import back into `ipc-handlers.ts`
 *    (that would only move the coupling);
 *  - behaviour, order and argument shapes are unchanged — this is a move.
 */
import { ipcMain } from 'electron';
import * as os from 'os';
import { listImportableLegacyProjects } from '../legacy-import';
import { createAppMenu } from '../menu';
import { getLastDiskHealth } from '../disk-health';
import { checkForUpdates, quitAndInstall } from '../auto-updater';

export interface LeafDomainDeps {
  /** Live read of the known project paths (store state), as `registerIpcHandlers` sees it. */
  getKnownProjectPaths: () => string[];
}

/** Register the five leaf-domain channels. Call once, from `registerIpcHandlers`. */
export function registerLeafDomains(deps: LeafDomainDeps): void {
  // Disk-health preflight (src/main/disk-health.ts): the renderer fetches
  // the last emitted status on mount; main.ts pushes transitions on
  // 'disk-health:status'. Transition-only emissions keep a full disk at one
  // banner, not a per-write stream.
  ipcMain.handle('disk-health:get', () => getLastDiskHealth());

  // List projects from the legacy `~/.vibeyard/state.json` that can be
  // imported into the board. The one-time file migration is destination-
  // wins, so the legacy project list never merged into a live state.json
  // written under the new name. Read-only: the renderer adds the user's
  // picks through its own state -> persist path.
  ipcMain.handle('vibeyard:listImportableProjects', () =>
    listImportableLegacyProjects({ homedir: os.homedir(), existingPaths: deps.getKnownProjectPaths() }),
  );

  ipcMain.handle('menu:rebuild', (_event, debugMode: boolean) => {
    createAppMenu(debugMode);
  });

  ipcMain.handle('update:checkNow', () => checkForUpdates());
  ipcMain.handle('update:install', () => quitAndInstall());
}
