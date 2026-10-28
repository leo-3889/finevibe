/**
 * Row 26 slice 2: the github, app and mcp domains.
 *
 * Follows the seam contract of leaf-domains.ts: channels stay string literals
 * (`ipc-channel-parity.test.ts` pins both ends), closure state arrives as
 * injected deps and never as an import back into `ipc-handlers.ts`, and the
 * handler bodies are a verbatim move.
 *
 * The two injected values are exactly the closure state these nine handlers
 * captured:
 *  - `requireGitRoot`: the git/project gate `github:detectRepo` calls;
 *  - `getBrowserPreloadPath`: the `__dirname`-relative preload path, which
 *    must keep computing inside `ipc-handlers.ts` (a module move would
 *    silently rebase `__dirname`).
 */
import { app, ipcMain, shell } from 'electron';
import * as path from 'path';
import { addMcpServer, removeMcpServer, isManagedMcpConfigDir, type McpServerConfig } from '../claude-cli';

import { isGhAvailable, listPullRequests, listIssues, detectRepo } from '../github-cli';

export interface AppDomainsDeps {
  /** Git-target gate from ipc-handlers (remote-project block + watched-roots register). */
  requireGitRoot: (channel: string, projectPath: string) => string;
  /** Project-membership gate from ipc-handlers (canonical, state-backed). */
  isWithinKnownProject: (resolvedPath: string) => boolean;
  /** __dirname-relative browser-tab preload path, computed where it lives. */
  getBrowserPreloadPath: () => string;
}

export function registerAppDomains(deps: AppDomainsDeps): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getBrowserPreloadPath', () => deps.getBrowserPreloadPath());

  ipcMain.handle('app:openExternal', (_event, url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Same outcome as before — the invoke rejects — but explicit rather than
      // an escaping TypeError.
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Only HTTP(S) URLs are allowed');
    }
    return shell.openExternal(url);
  });

  ipcMain.handle('github:isAvailable', () => isGhAvailable());
  ipcMain.handle('github:detectRepo', (_event, projectPath: string) =>
    detectRepo(deps.requireGitRoot('github:detectRepo', projectPath))
  );
  ipcMain.handle('github:listPRs', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listPullRequests(repo, { state, max })
  );
  ipcMain.handle('github:listIssues', (_event, repo: string, state: 'open' | 'closed' | 'all', max: number) =>
    listIssues(repo, { state, max })
  );

  ipcMain.handle('mcp:addServer', (_event, name: string, config: McpServerConfig, scope: 'user' | 'project', projectPath?: string, configDir?: string) => {
    try {
      addMcpServer(name, config, scope, projectPath, configDir);
      return { success: true };
    } catch (err) {
      console.error('mcp:addServer failed:', err);
      return { success: false, error: String(err) };
    }
  });

  // C3A-01: filePath arrives via the renderer as an echo of the list results,
  // and removeMcpServer's self-built allowlist (claude-cli.ts) is derived from
  // the same projectPath+configDir args — so they both identify AND authorize
  // the write target. Gate the boundary like addMcpServer (claude-cli.ts) and
  // provider:getConfig: configDir must be a managed profile dir, and a project
  // scope must name a known project, or the allowlist is renderer-authored.
  ipcMain.handle('mcp:removeServer', (_event, name: string, filePath: string, scope: 'user' | 'project', projectPath?: string, configDir?: string) => {
    if (configDir && !isManagedMcpConfigDir(configDir)) {
      return { success: false, error: `Refused: ${configDir} is not a managed profile directory.` };
    }
    if (scope === 'project' && (!projectPath || !deps.isWithinKnownProject(path.resolve(projectPath)))) {
      return { success: false, error: 'Path is not within a known project' };
    }
    try {
      removeMcpServer(name, filePath, scope, projectPath, configDir);
      return { success: true };
    } catch (err) {
      console.error('mcp:removeServer failed:', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
