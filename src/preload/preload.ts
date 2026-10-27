import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import type { ImportableLegacyProject } from '../shared/types';
import type { DiskHealth } from '../shared/types';
import type { CostData, ProviderId, CliProviderMeta, StatsCache, ReadinessResult, ToolFailureData, SettingsWarningData, SettingsValidationResult, StatusLineConflictData, InspectorEvent, CliSessionStatus, GitWorktree, McpResult, ProviderConfig, ReadFileResult, FileStatResult, TopFilesResult, FsChange, DeepSearchResult, GithubFetchResult, GithubRepo, ChromeProfile, ChromeImportOptions, ChromeImportProgress, ChromeImportResult, ClipboardSource, ClipboardPastePayload, StartupPrefs, ArchivedSession, HostRecord } from '../shared/types';
// Mirrors ZOOM_MIN/ZOOM_MAX from src/shared/types.ts. These two values are
// duplicated rather than imported because the main window runs with
// sandbox: true, and a sandboxed preload's polyfilled require cannot load
// local CommonJS files — only electron, events, timers and url.
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 2.0;
export type { CostData } from '../shared/types';

export interface FineVibeApi {
  pty: {
    create(sessionId: string, cwd: string, cliSessionId: string | null, isResume: boolean, extraArgs?: string, providerId?: ProviderId, initialPrompt?: string, systemPrompt?: string, envVars?: string, configDir?: string, hostId?: string): Promise<void>;
    createShell(sessionId: string, cwd: string): Promise<void>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): Promise<void>;
    getCwd(sessionId: string): Promise<string | null>;
    onData(callback: (sessionId: string, data: string) => void): () => void;
      onExit(callback: (sessionId: string, exitCode: number, signal?: number, exitReason?: string, pid?: number) => void): () => void;
  };
  session: {
    buildResumeWithPrompt(sourceProviderId: ProviderId, sourceCliSessionId: string | null, projectPath: string, sessionName: string, configDir?: string, liveSessionId?: string): Promise<string>;
    transcriptExists(providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir?: string, liveSessionId?: string): Promise<boolean>;
    /** Save-dialog backup of one session. `zip`: meta.json + provider transcript + sidecars; `file`: the transcript verbatim. Returns the written path or null when canceled. */
    exportArchive(providerId: ProviderId, cliSessionId: string | null, projectPath: string, configDir: string | undefined, meta: ArchivedSession, format: 'zip' | 'file'): Promise<string | null>;
    deepSearch(query: string): Promise<DeepSearchResult[]>;
    cancelDeepSearch(): void;
    onHookStatus(callback: (sessionId: string, status: CliSessionStatus, hookName: string) => void): () => void;
    onCliSessionId(callback: (sessionId: string, cliSessionId: string) => void): () => void;
    onCostData(callback: (sessionId: string, costData: CostData) => void): () => void;
    onSessionName(callback: (sessionId: string, name: string, cliSessionId: string) => void): () => void;
    resyncStatus(): void;
    syncRestored(sessions: { sessionId: string; providerId: ProviderId; cliSessionId: string | null; cwd: string; configDir?: string; createdAt: string }[]): Promise<void>;
    release(sessionId: string): void;
    onToolFailure(callback: (sessionId: string, data: ToolFailureData) => void): () => void;
    onInspectorEvents(callback: (sessionId: string, events: InspectorEvent[]) => void): () => void;
  };
  fs: {
    isDirectory(path: string): Promise<boolean>;
    expandPath(path: string): Promise<string>;
    listDirs(dirPath: string, prefix?: string): Promise<string[]>;
    listDir(dirPath: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>>;
    browseDirectory(): Promise<string | null>;
    cloneRepo(url: string, destPath: string): Promise<{ ok: boolean; error?: string }>;
    ensureDirectory(dirPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    listFiles(cwd: string, query: string, hostId?: string): Promise<string[]>;
    topFilesByTokens(cwd: string, limit: number): Promise<TopFilesResult>;
    exists(filePath: string): Promise<boolean>;
    readFile(filePath: string): Promise<ReadFileResult>;
    stat(filePath: string): Promise<FileStatResult>;
    readImage(filePath: string): Promise<{ dataUrl: string } | null>;
    trashItem(filePath: string): Promise<{ ok: boolean; error?: string }>;
    showInFolder(targetPath: string): Promise<{ ok: boolean; error?: string }>;
    watchDir(dirPath: string): void;
    unwatchDir(dirPath: string): void;
    onFsChange(callback: (changes: FsChange[]) => void): () => void;
    getDroppedFilePath(file: File): string;
  };
  store: {
    load(): Promise<unknown>;
    save(state: unknown): Promise<void>;
    /** Quit-path synchronous flush (sendSync; true only when main wrote the state). */
    saveSync(state: unknown): boolean;
    startupPrefs(): StartupPrefs;
  };
  vibeyard: {
    /** Legacy `~/.vibeyard/state.json` projects that can be imported into the current list. */
    listImportableProjects(): Promise<ImportableLegacyProject[]>;
  };
  profiles: {
    provision(profileId: string, customPath?: string, providerId?: ProviderId, hostId?: string): Promise<{ configDir: string; managed: boolean }>;
    keychainStatus(): Promise<{ status: 'supported' | 'unsupported' | 'unknown'; version: string | null }>;
  };
  hosts: {
    list(): Promise<HostRecord[]>;
    create(draft: unknown): Promise<HostRecord>;
    update(id: string, patch: Record<string, unknown>): Promise<HostRecord>;
    delete(id: string): Promise<void>;
    openShell(id: string, sessionId: string): Promise<void>;
    generateKey(): Promise<{ id: string; privateKeyPath: string; publicKey: string }>;
    secretsAvailable(): Promise<boolean>;
    setSecret(id: string, kind: 'password' | 'keypass', secret: string): Promise<void>;
    forgetPassword(id: string): Promise<void>;
    test(id: string): Promise<{ ok: boolean; fingerprint?: string; newFingerprint?: string; hostKeyChanged: boolean; steps: { step: string; ok: boolean; detail?: string }[] }>;
    approveHostKey(id: string, fingerprint: string): Promise<HostRecord | null>;
    enroll(id: string, opts?: { pin?: string }): Promise<{ ok: boolean; steps: { step: string; ok: boolean; detail?: string }[] }>;
    unenroll(id: string): Promise<{ ok: boolean; detail?: string }>;
    syncSettings(id: string, providerIds: ProviderId[], confirmOverwrite?: boolean): Promise<{ ok: boolean; drift?: string[]; steps: { step: string; ok: boolean; detail?: string }[] }>;
    /** Remote open/add folder (T5, UR-6): the Add-project verbs on the host.
     * Main owns normalization/traversal/quoting; the record is the consent. */
    listDirs(id: string, dirPath: string, prefix?: string): Promise<{ ok: boolean; dirs?: string[]; error?: string }>;
    stat(id: string, path: string): Promise<{ ok: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number; error?: string }>;
    ensureDir(id: string, dirPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    cloneRepo(id: string, url: string, destPath: string): Promise<{ ok: boolean; error?: string }>;
    onStatus(callback: (event: { id: string; status: string; detail?: string }) => void): () => void;
  };
  provider: {
    getConfig(providerId: ProviderId, projectPath: string, configDir?: string, hostId?: string): Promise<ProviderConfig>;
    listProviders(): Promise<CliProviderMeta[]>;
    checkBinary(providerId?: ProviderId, hostId?: string): Promise<boolean>;
    watchProject(providerId: ProviderId, projectPath: string): void;
    onConfigChanged(callback: () => void): () => void;
    installAgent(slug: string, content: string, configDir?: string): Promise<Array<{ providerId: ProviderId; ok: boolean; filePath?: string; error?: string }>>;
    removeAgent(slug: string): Promise<void>;
  };
  git: {
    getStatus(path: string): Promise<unknown>;
    getFiles(path: string): Promise<unknown>;
    getDiff(path: string, file: string, area: string): Promise<string>;
    getWorktrees(path: string): Promise<GitWorktree[]>;
    getRemoteUrl(path: string): Promise<string | null>;
    stageFile(path: string, file: string): Promise<void>;
    unstageFile(path: string, file: string): Promise<void>;
    discardFile(path: string, file: string, area: string): Promise<void>;
    openInEditor(path: string, file: string): Promise<void>;
    listBranches(path: string): Promise<{ name: string; current: boolean }[]>;
    checkoutBranch(path: string, branch: string): Promise<void>;
    createBranch(path: string, branch: string): Promise<void>;
    watchProject(path: string): void;
    onChanged(callback: () => void): () => void;
  };
  update: {
    checkNow(): Promise<void>;
    install(): Promise<void>;
    onAvailable(cb: (info: { version: string }) => void): () => void;
    onDownloadProgress(cb: (info: { percent: number }) => void): () => void;
    onDownloaded(cb: (info: { version: string }) => void): () => void;
    onError(cb: (info: { message: string }) => void): () => void;
  };
  disk: {
    get(): Promise<DiskHealth | null>;
    onStatus(callback: (status: DiskHealth) => void): () => void;
  };
  app: {
    focus(): void;
    getVersion(): Promise<string>;
    openExternal(url: string): Promise<void>;
    getBrowserPreloadPath(): Promise<string>;
    onQuitting(callback: () => void): () => void;
    onConfirmClose(callback: () => void): () => void;
    closeConfirmed(): void;
  };

  /** One row of the A3 legacy-retirement audit log (main/userdata-migration.ts). */
  storage: {
    /** userData subtree sizes, descending; `truncated` on scan caps. */
    scan(): Promise<{ entries: Array<{ name: string; bytes: number }>; truncated: boolean }>;
    /** Clear caches ONLY (see clearSafeCaches in main/ipc-handlers.ts). */
    clear(): Promise<{ tempDirsSwept: number }>;
    /** Read-only A3 retirement audit log. */
    retirement(): Promise<Array<{
      id: string;
      from: string;
      at: string;
      outcome: 'removed' | 'kept' | 'unverified' | 'error';
      bytesFreed?: number;
      reason?: string;
    }>>;
  };
  browser: {
    saveScreenshot(sessionId: string, dataUrl: string): Promise<string>;
    clearIsolatedStorage(sessionId: string): void;
  };
  chromeImport: {
    listProfiles(): Promise<ChromeProfile[]>;
    run(options: ChromeImportOptions): Promise<ChromeImportResult>;
    onProgress(callback: (progress: ChromeImportProgress) => void): () => void;
    summary(): Promise<{ cookieCount: number; lastImportedAt: number }>;
    clearCookies(): Promise<void>;
  };
  mcp: {
    connect(id: string, url: string): Promise<McpResult>;
    disconnect(id: string): Promise<McpResult>;
    listTools(id: string): Promise<McpResult>;
    listResources(id: string): Promise<McpResult>;
    listPrompts(id: string): Promise<McpResult>;
    callTool(id: string, name: string, args: Record<string, unknown>): Promise<McpResult>;
    readResource(id: string, uri: string): Promise<McpResult>;
    getPrompt(id: string, name: string, args: Record<string, string>): Promise<McpResult>;
    addServer(name: string, config: unknown, scope: 'user' | 'project', projectPath?: string, configDir?: string): Promise<McpResult>;
    removeServer(name: string, filePath: string, scope: 'user' | 'project', projectPath?: string, configDir?: string): Promise<McpResult>;
  };
  readiness: {
    analyze(projectPath: string, excludedProviders?: string[]): Promise<ReadinessResult>;
  };
  github: {
    isAvailable(): Promise<boolean>;
    detectRepo(projectPath: string): Promise<GithubRepo | null>;
    listPRs(repo: string, state: 'open' | 'closed' | 'all', max: number): Promise<GithubFetchResult>;
    listIssues(repo: string, state: 'open' | 'closed' | 'all', max: number): Promise<GithubFetchResult>;
  };
  stats: {
    getCache(): Promise<StatsCache | null>;
  };
  settings: {
    onWarning(callback: (data: SettingsWarningData) => void): () => void;
    onConflictDialog(callback: (data: StatusLineConflictData) => void): () => void;
    respondConflictDialog(choice: 'replace' | 'keep'): void;
    reinstall(providerId?: ProviderId, configDir?: string, projectPath?: string): Promise<{ success: boolean; error?: string }>;
    validate(providerId?: ProviderId, projectPath?: string, configDir?: string): Promise<SettingsValidationResult>;
    declineConflict(configDir?: string, foreignCommand?: string | null): void;
  };
  clipboard: {
    // P3: fire-and-forget — copies never need a reply; the invoke twin paid
    // a promise round trip (and cloned the reply) per selection.
    write(text: string, source?: ClipboardSource): void;
    readForPaste(): Promise<ClipboardPastePayload>;
    saveImage(dataUrl: string): Promise<string | null>;
  };
  zoom: {
    set(factor: number): void;
  };
  menu: {
    onNewProject(callback: () => void): () => void;
    onNewSession(callback: () => void): () => void;
    onToggleSplit(callback: () => void): () => void;
    onToggleDebug(callback: () => void): () => void;
    onToggleInspector(callback: () => void): () => void;
    onCloseSession(callback: () => void): () => void;
    rebuild(debugMode: boolean): Promise<void>;
  };
}

function onChannel(channel: string, callback: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: FineVibeApi = {
  pty: {
    create: (sessionId, cwd, cliSessionId, isResume, extraArgs, providerId, initialPrompt, systemPrompt, envVars, configDir, hostId) =>
      ipcRenderer.invoke('pty:create', sessionId, cwd, cliSessionId, isResume, extraArgs || '', providerId || 'claude', initialPrompt, systemPrompt, envVars || '', configDir, hostId),
    createShell: (sessionId, cwd) =>
      ipcRenderer.invoke('pty:createShell', sessionId, cwd),
    write: (sessionId, data) =>
      ipcRenderer.send('pty:write', sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send('pty:resize', sessionId, cols, rows),
    kill: (sessionId) =>
      ipcRenderer.invoke('pty:kill', sessionId),
    getCwd: (sessionId: string) =>
      ipcRenderer.invoke('pty:getCwd', sessionId),
    onData: (callback) =>
      onChannel('pty:data', (sessionId, data) => callback(sessionId as string, data as string)),
      onExit: (callback) =>
        onChannel('pty:exit', (sessionId, exitCode, signal, exitReason, pid) =>
          callback(sessionId as string, exitCode as number, signal as number | undefined, exitReason as string | undefined, pid as number | undefined)),
  },
  session: {
    buildResumeWithPrompt: (sourceProviderId, sourceCliSessionId, projectPath, sessionName, configDir, liveSessionId) =>
      ipcRenderer.invoke('session:buildResumeWithPrompt', sourceProviderId, sourceCliSessionId, projectPath, sessionName, configDir, liveSessionId),
    transcriptExists: (providerId, cliSessionId, projectPath, configDir, liveSessionId) =>
      ipcRenderer.invoke('session:transcriptExists', providerId, cliSessionId, projectPath, configDir, liveSessionId),
    exportArchive: (providerId, cliSessionId, projectPath, configDir, meta, format) =>
      ipcRenderer.invoke('session:exportArchive', providerId, cliSessionId, projectPath, configDir, meta, format),
    cancelDeepSearch: () => ipcRenderer.send('session:cancelDeepSearch'),
    deepSearch: (query) =>
      ipcRenderer.invoke('session:deepSearch', query),
    onHookStatus: (callback) =>
      onChannel('session:hookStatus', (sessionId, status, hookName) =>
        callback(sessionId as string, status as CliSessionStatus, (hookName as string) || '')),
    onCliSessionId: (callback) =>
      onChannel('session:cliSessionId', (sessionId, cliSessionId) =>
        callback(sessionId as string, cliSessionId as string)),
    onCostData: (callback) =>
      onChannel('session:costData', (sessionId, costData) =>
        callback(sessionId as string, costData as CostData)),
    onSessionName: (callback) =>
      onChannel('session:sessionName', (sessionId, name, cliSessionId) =>
        callback(sessionId as string, name as string, (cliSessionId as string) || '')),
    resyncStatus: () => ipcRenderer.send('session:resyncStatus'),
    syncRestored: (sessions) => ipcRenderer.invoke('session:syncRestored', sessions),
    release: (sessionId) => ipcRenderer.send('session:release', sessionId),
    onToolFailure: (callback) =>
      onChannel('session:toolFailure', (sessionId, data) =>
        callback(sessionId as string, data as ToolFailureData)),
    onInspectorEvents: (callback) =>
      onChannel('session:inspectorEvents', (sessionId, events) =>
        callback(sessionId as string, events as InspectorEvent[])),
  },
  fs: {
    isDirectory: (path, hostId?: string) => ipcRenderer.invoke('fs:isDirectory', path, hostId),
    expandPath: (path: string) => ipcRenderer.invoke('fs:expandPath', path),
    listDirs: (dirPath: string, prefix?: string) => ipcRenderer.invoke('fs:listDirs', dirPath, prefix),
    listDir: (dirPath: string, hostId?: string) => ipcRenderer.invoke('fs:listDir', dirPath, hostId),
    browseDirectory: () => ipcRenderer.invoke('fs:browseDirectory'),
    cloneRepo: (url: string, destPath: string) => ipcRenderer.invoke('fs:cloneRepo', url, destPath),
    ensureDirectory: (dirPath: string) => ipcRenderer.invoke('fs:ensureDirectory', dirPath),
    listFiles: (cwd: string, query: string, hostId?: string) => ipcRenderer.invoke('fs:listFiles', cwd, query, hostId),
    topFilesByTokens: (cwd: string, limit: number) => ipcRenderer.invoke('fs:topFilesByTokens', cwd, limit),
    exists: (filePath: string, hostId?: string) => ipcRenderer.invoke('fs:exists', filePath, hostId),
    readFile: (filePath: string, hostId?: string) => ipcRenderer.invoke('fs:readFile', filePath, hostId),
    stat: (filePath: string, hostId?: string) => ipcRenderer.invoke('fs:stat', filePath, hostId),
    readImage: (filePath: string) => ipcRenderer.invoke('fs:readImage', filePath),
    trashItem: (filePath: string) => ipcRenderer.invoke('fs:trashItem', filePath),
    showInFolder: (targetPath: string) => ipcRenderer.invoke('fs:showInFolder', targetPath),
    watchDir: (dirPath: string, hostId?: string) => ipcRenderer.send('fs:watchDir', dirPath, hostId),
    unwatchDir: (dirPath: string, hostId?: string) => ipcRenderer.send('fs:unwatchDir', dirPath, hostId),
    onFsChange: (callback: (changes: FsChange[]) => void) => onChannel('fs:changed', (changes) => callback(changes as FsChange[])),
    getDroppedFilePath: (file: File) => webUtils.getPathForFile(file),
  },
  provider: {
    getConfig: (providerId, projectPath, configDir?, hostId?) => ipcRenderer.invoke('provider:getConfig', providerId, projectPath, configDir, hostId),
    listProviders: () => ipcRenderer.invoke('provider:listProviders'),
    checkBinary: (providerId, hostId) => ipcRenderer.invoke('provider:checkBinary', providerId || 'claude', hostId),
    watchProject: (providerId, projectPath) => ipcRenderer.send('config:watchProject', providerId, projectPath),
    onConfigChanged: (callback) => onChannel('config:changed', callback),
    installAgent: (slug, content, configDir) => ipcRenderer.invoke('provider:installAgent', slug, content, configDir),
    removeAgent: (slug) => ipcRenderer.invoke('provider:removeAgent', slug),
  },
  store: {
    load: () => ipcRenderer.invoke('store:load'),
    save: (state) => ipcRenderer.invoke('store:save', state),
    // S1-03: beforeunload flush must reach disk before the window tears
    // down — sendSync blocks the renderer until the write is on disk.
    saveSync: (state) => ipcRenderer.sendSync('store:save-sync', state) === true,
    // Sync round-trip: the renderer needs theme/zoom before its first paint,
    // which is earlier than any invoke promise can resolve.
    startupPrefs: () => ipcRenderer.sendSync('store:startup-prefs'),
  },
  vibeyard: {
    listImportableProjects: () => ipcRenderer.invoke('vibeyard:listImportableProjects'),
  },
  profiles: {
    provision: (profileId, customPath, providerId, hostId) => ipcRenderer.invoke('profiles:provision', profileId, customPath, providerId, hostId),
    keychainStatus: () => ipcRenderer.invoke('profiles:keychainStatus'),
  },
  hosts: {
    list: () => ipcRenderer.invoke('hosts:list'),
    create: (draft) => ipcRenderer.invoke('hosts:create', draft),
    update: (id, patch) => ipcRenderer.invoke('hosts:update', id, patch),
    delete: (id) => ipcRenderer.invoke('hosts:delete', id),
    openShell: (id, sessionId) => ipcRenderer.invoke('hosts:openShell', id, sessionId),
    generateKey: () => ipcRenderer.invoke('hosts:generateKey'),
    secretsAvailable: () => ipcRenderer.invoke('hosts:secretsAvailable'),
    setSecret: (id, kind, secret) => ipcRenderer.invoke('hosts:setSecret', id, kind, secret),
    forgetPassword: (id) => ipcRenderer.invoke('hosts:forgetPassword', id),
    test: (id) => ipcRenderer.invoke('hosts:test', id),
    approveHostKey: (id, fingerprint) => ipcRenderer.invoke('hosts:approveHostKey', id, fingerprint),
    enroll: (id, opts) => ipcRenderer.invoke('hosts:enroll', id, opts),
    unenroll: (id) => ipcRenderer.invoke('hosts:unenroll', id),
    syncSettings: (id, providerIds, confirmOverwrite) => ipcRenderer.invoke('hosts:syncSettings', id, providerIds, confirmOverwrite),
    listDirs: (id, dirPath, prefix) => ipcRenderer.invoke('hosts:listDirs', id, dirPath, prefix),
    stat: (id, target) => ipcRenderer.invoke('hosts:stat', id, target),
    ensureDir: (id, dirPath) => ipcRenderer.invoke('hosts:ensureDir', id, dirPath),
    cloneRepo: (id, url, destPath) => ipcRenderer.invoke('hosts:cloneRepo', id, url, destPath),
    onStatus: (callback) => onChannel('hosts:status', callback as (...args: unknown[]) => void),
  },
  git: {
    getStatus: (path) => ipcRenderer.invoke('git:getStatus', path),
    getFiles: (path) => ipcRenderer.invoke('git:getFiles', path),
    getDiff: (path: string, file: string, area: string) => ipcRenderer.invoke('git:getDiff', path, file, area),
    getWorktrees: (path: string) => ipcRenderer.invoke('git:getWorktrees', path),
    getRemoteUrl: (path: string) => ipcRenderer.invoke('git:getRemoteUrl', path),
    stageFile: (path: string, file: string) => ipcRenderer.invoke('git:stageFile', path, file),
    unstageFile: (path: string, file: string) => ipcRenderer.invoke('git:unstageFile', path, file),
    discardFile: (path: string, file: string, area: string) => ipcRenderer.invoke('git:discardFile', path, file, area),
    openInEditor: (path: string, file: string) => ipcRenderer.invoke('git:openInEditor', path, file),
    listBranches: (path: string) => ipcRenderer.invoke('git:listBranches', path),
    checkoutBranch: (path: string, branch: string) => ipcRenderer.invoke('git:checkoutBranch', path, branch),
    createBranch: (path: string, branch: string) => ipcRenderer.invoke('git:createBranch', path, branch),
    watchProject: (path: string) => ipcRenderer.send('git:watchProject', path),
    onChanged: (callback: () => void) => onChannel('git:changed', callback),
  },
  update: {
    checkNow: () => ipcRenderer.invoke('update:checkNow'),
    install: () => ipcRenderer.invoke('update:install'),
    onAvailable: (cb) => onChannel('update:available', (info) => cb(info as { version: string })),
    onDownloadProgress: (cb) => onChannel('update:download-progress', (info) => cb(info as { percent: number })),
    onDownloaded: (cb) => onChannel('update:downloaded', (info) => cb(info as { version: string })),
    onError: (cb) => onChannel('update:error', (info) => cb(info as { message: string })),
  },
  disk: {
    get: () => ipcRenderer.invoke('disk-health:get'),
    onStatus: (cb) => onChannel('disk-health:status', (status) => cb(status as DiskHealth)),
  },
  app: {
    focus: () => { ipcRenderer.send('app:focus'); },
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    getBrowserPreloadPath: () => ipcRenderer.invoke('app:getBrowserPreloadPath'),
    onQuitting: (cb: () => void) => onChannel('app:quitting', cb),
    onConfirmClose: (cb: () => void) => onChannel('app:confirmClose', cb),
    closeConfirmed: () => { ipcRenderer.send('app:closeConfirmed'); },
  },
  storage: {
    scan: () => ipcRenderer.invoke('storage:scan'),
    clear: () => ipcRenderer.invoke('storage:clear'),
    retirement: () => ipcRenderer.invoke('storage:retirement'),
  },
  browser: {
    saveScreenshot: (sessionId: string, dataUrl: string) =>
      ipcRenderer.invoke('browser:saveScreenshot', sessionId, dataUrl),
    clearIsolatedStorage: (sessionId: string) =>
      ipcRenderer.send('browser:clearIsolatedStorage', sessionId),
  },
  chromeImport: {
    listProfiles: () => ipcRenderer.invoke('chromeImport:listProfiles'),
    run: (options: ChromeImportOptions) => ipcRenderer.invoke('chromeImport:run', options),
    onProgress: (callback) =>
      onChannel('chromeImport:progress', (progress) => callback(progress as ChromeImportProgress)),
    summary: () => ipcRenderer.invoke('chromeImport:summary'),
    clearCookies: () => ipcRenderer.invoke('chromeImport:clearCookies'),
  },
  mcp: {
    connect: (id: string, url: string) => ipcRenderer.invoke('mcp:connect', id, url),
    disconnect: (id: string) => ipcRenderer.invoke('mcp:disconnect', id),
    listTools: (id: string) => ipcRenderer.invoke('mcp:listTools', id),
    listResources: (id: string) => ipcRenderer.invoke('mcp:listResources', id),
    listPrompts: (id: string) => ipcRenderer.invoke('mcp:listPrompts', id),
    callTool: (id: string, name: string, args: Record<string, unknown>) => ipcRenderer.invoke('mcp:callTool', id, name, args),
    readResource: (id: string, uri: string) => ipcRenderer.invoke('mcp:readResource', id, uri),
    getPrompt: (id: string, name: string, args: Record<string, string>) => ipcRenderer.invoke('mcp:getPrompt', id, name, args),
    addServer: (name: string, config: unknown, scope: 'user' | 'project', projectPath?: string, configDir?: string) => ipcRenderer.invoke('mcp:addServer', name, config, scope, projectPath, configDir),
    removeServer: (name: string, filePath: string, scope: 'user' | 'project', projectPath?: string, configDir?: string) => ipcRenderer.invoke('mcp:removeServer', name, filePath, scope, projectPath, configDir),
  },
  readiness: {
    analyze: (projectPath: string, excludedProviders?: string[]) => ipcRenderer.invoke('readiness:analyze', projectPath, excludedProviders),
  },
  github: {
    isAvailable: () => ipcRenderer.invoke('github:isAvailable'),
    detectRepo: (projectPath: string) => ipcRenderer.invoke('github:detectRepo', projectPath),
    listPRs: (repo: string, state: 'open' | 'closed' | 'all', max: number) => ipcRenderer.invoke('github:listPRs', repo, state, max),
    listIssues: (repo: string, state: 'open' | 'closed' | 'all', max: number) => ipcRenderer.invoke('github:listIssues', repo, state, max),
  },
  stats: {
    getCache: () => ipcRenderer.invoke('stats:getCache'),
  },
  settings: {
    onWarning: (cb) => onChannel('settings:warning', (data) => cb(data as SettingsWarningData)),
    onConflictDialog: (cb) => onChannel('settings:showConflictDialog', (data) => cb(data as StatusLineConflictData)),
    respondConflictDialog: (choice) => ipcRenderer.send('settings:conflictDialogResponse', choice),
    reinstall: (providerId, configDir, projectPath) => ipcRenderer.invoke('settings:reinstall', providerId || 'claude', configDir, projectPath),
    validate: (providerId, projectPath, configDir) => ipcRenderer.invoke('settings:validate', providerId || 'claude', projectPath, configDir),
    declineConflict: (configDir, foreignCommand) => ipcRenderer.send('settings:declineStatusLine', configDir, foreignCommand),
  },
  clipboard: {
    write: (text: string, source?: ClipboardSource) => ipcRenderer.send('clipboard:write', text, source),
    readForPaste: () => ipcRenderer.invoke('clipboard:readForPaste'),
    saveImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:saveImage', dataUrl),
  },
  zoom: {
    set: (factor: number) => {
      webFrame.setZoomFactor(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor)));
    },
  },
  menu: {
    onNewProject: (cb) => onChannel('menu:new-project', cb),
    onNewSession: (cb) => onChannel('menu:new-session', cb),
    onToggleSplit: (cb) => onChannel('menu:toggle-split', cb),
    onToggleDebug: (cb) => onChannel('menu:toggle-debug', cb),
    onToggleInspector: (cb) => onChannel('menu:toggle-inspector', cb),
    onCloseSession: (cb) => onChannel('menu:close-session', cb),
    rebuild: (debugMode) => ipcRenderer.invoke('menu:rebuild', debugMode),
  },
};

contextBridge.exposeInMainWorld('finevibe', api);

// P0 clipboard-timing env forwarding. The renderer is a sandboxed Browser
// World with no process.env, so `clipboardTimingOn()` in
// renderer/components/terminal-utils.ts reads this global; the preload is a
// sandboxed context whose polyfilled `process` does expose `env`. This makes
// `FINEVIBE_CLIPBOARD_TIMING=1 electron .` light the [paste-timing] /
// [copy-timing] probes end to end.
contextBridge.exposeInMainWorld(
  '__FINEVIBE_CLIPBOARD_TIMING__',
  process.env.FINEVIBE_CLIPBOARD_TIMING === '1'
);
