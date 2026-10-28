/**
 * Row 26 slice 3: stats, readiness and profiles domains.
 *
 * Seam contract unchanged (leaf-domains.ts): string-literal channels, closure
 * state injected (here only `requireGitRoot`), bodies verbatim. The stats
 * memo was a `let` in `registerIpcHandlers` (called once at boot); module
 * scope is the same lifetime.
 *
 * `browser:saveScreenshot` deliberately stayed in ipc-handlers.ts: its prune
 * helper is shared with the clipboard paste dir, and pulling it here would
 * create an import edge back into the big file.
 */
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeReadiness } from '../readiness/analyzer';
import { getAvailableProviderIdsAsync } from '../providers/registry';
import { getHost } from '../hosts/host-registry';
import { provisionRemoteProfileDir } from '../hosts/enrollment';
import { provisionProfileDir } from '../profiles';
import { loadState } from '../store';
import { getKeychainIsolationStatus } from '../claude-keychain';
import { LOCAL_HOST_ID, type ProviderId } from '../../shared/types';

export interface SupportDomainsDeps {
  /** Git-target gate from ipc-handlers (readiness uses the same root rule as git:*). */
  requireGitRoot: (channel: string, projectPath: string) => string;
}

export function registerSupportDomains(deps: SupportDomainsDeps): void {
  // PA-24: the widget renders requested this every poll; the file was read
  // AND JSON.parsed in full each time. Memoize by (path, mtime, size) — the
  // hook-status poll rewrites the file when usage changes, and the resulting
  // mtime bump re-parses. Async body: the channel is ipcMain.handle.
  let statsCacheMemo: { file: string; mtimeMs: number; size: number; data: unknown } | null = null;
  ipcMain.handle('stats:getCache', async () => {
    try {
      const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
      const st = await fs.promises.stat(statsPath);
      const memo = statsCacheMemo;
      if (memo && memo.file === statsPath && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
        return memo.data;
      }
      const raw = await fs.promises.readFile(statsPath, 'utf-8');
      const data = JSON.parse(raw);
      statsCacheMemo = { file: statsPath, mtimeMs: st.mtimeMs, size: st.size, data };
      return data;
    } catch {
      statsCacheMemo = null;
      return null;
    }
  });

  // root gate as the 13 git:* handlers: a known project or a watched worktree.
  ipcMain.handle('readiness:analyze', async (_event, projectPath: string, excludedProviders?: ProviderId[]) => {
    const root = deps.requireGitRoot('readiness:analyze', projectPath);
    // S4-03: warm the registry availability cache with the async probe
    // twin. analyzeReadiness() reads availability through the sync
    // getAvailableProviderIds(); warming first makes that a cache hit, so
    // the first scan no longer runs the six sync probe chains on main.
    // Response shape is the same ReadinessResult promise.
    await getAvailableProviderIdsAsync();
    return analyzeReadiness(root, excludedProviders);
  });

  // Provision (create) a profile's config dir. Returns the resolved absolute
  // path and whether it is the auto-managed location.
  ipcMain.handle('profiles:provision', async (_event, profileId: string, customPath?: string, providerId?: ProviderId, hostId?: string) => {
    if (hostId !== undefined && hostId !== LOCAL_HOST_ID) {
      // Remote managed provisioning (plan §2): mkdir the managed dir on the
      // host over the exec lane; custom paths stay local-only (the renderer
      // must never steer a remote mkdir).
      if (customPath?.trim()) throw new Error('Custom profile dirs are local-only; remote profiles use the managed dir.');
      const record = getHost(hostId);
      if (!record) throw new Error(`Unknown host: ${JSON.stringify(hostId)}`);
      const configDir = await provisionRemoteProfileDir(record, profileId);
      return { configDir, managed: true };
    }
    const configDir = provisionProfileDir(profileId, customPath, providerId, loadState().profiles ?? []);
    return { configDir, managed: !customPath?.trim() };
  });

  // Report whether the installed Claude Code build can isolate per-profile
  // logins on this platform (macOS keychain namespacing). Drives the profile
  // guardrail in the UI.
  ipcMain.handle('profiles:keychainStatus', () => {
    return getKeychainIsolationStatus();
  });
}
