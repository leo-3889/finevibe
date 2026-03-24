import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserWindow } from 'electron';

const DEBOUNCE_MS = 500;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let watchedFiles: string[] = [];
let dirWatchers: fs.FSWatcher[] = [];
let currentProjectPath: string | null = null;
let currentWin: BrowserWindow | null = null;

function notify(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (currentWin && !currentWin.isDestroyed()) {
      currentWin.webContents.send('config:changed');
    }
  }, DEBOUNCE_MS);
}

function watchFile(filePath: string): void {
  fs.watchFile(filePath, { interval: 2000 }, () => notify());
  watchedFiles.push(filePath);
}

function watchDir(dirPath: string): void {
  try {
    const watcher = fs.watch(dirPath, { recursive: true }, () => notify());
    watcher.on('error', () => {}); // ignore errors (dir deleted, etc.)
    dirWatchers.push(watcher);
  } catch {
    // Directory doesn't exist — that's fine
  }
}

function stopAll(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const f of watchedFiles) fs.unwatchFile(f);
  watchedFiles = [];
  for (const w of dirWatchers) w.close();
  dirWatchers = [];
}

function setupWatchers(projectPath: string): void {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');

  // Config files
  const files = [
    path.join(home, '.claude.json'),
    path.join(claudeDir, 'settings.json'),
    path.join(home, '.mcp.json'),
    path.join(projectPath, '.claude', 'settings.json'),
    path.join(projectPath, '.mcp.json'),
  ];
  for (const f of files) watchFile(f);

  // Directories for agents/skills/commands
  const dirs = [
    path.join(claudeDir, 'agents'),
    path.join(claudeDir, 'skills'),
    path.join(claudeDir, 'commands'),
    path.join(projectPath, '.claude', 'agents'),
    path.join(projectPath, '.claude', 'skills'),
    path.join(projectPath, '.claude', 'commands'),
  ];
  for (const d of dirs) watchDir(d);
}

export function startConfigWatcher(win: BrowserWindow, projectPath: string): void {
  if (projectPath === currentProjectPath) return;
  stopAll();
  currentWin = win;
  currentProjectPath = projectPath;
  setupWatchers(projectPath);
}

export function stopConfigWatcher(): void {
  stopAll();
  currentWin = null;
  currentProjectPath = null;
}
