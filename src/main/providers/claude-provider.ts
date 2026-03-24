import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { BrowserWindow } from 'electron';
import type { CliProvider } from './provider';
import type { CliProviderMeta, ClaudeConfig, SettingsValidationResult } from '../../shared/types';
import { getFullPath } from '../pty-manager';
import { installStatusLineScript, cleanupAll as cleanupHookStatus } from '../hook-status';
import { startConfigWatcher as startConfigWatch, stopConfigWatcher as stopConfigWatch } from '../config-watcher';
import { installHooksOnly, installStatusLine, getClaudeConfig } from '../claude-cli';
import { guardedInstall, validateSettings, reinstallSettings } from '../settings-guard';

let cachedBinaryPath: string | null = null;

export class ClaudeProvider implements CliProvider {
  readonly meta: CliProviderMeta = {
    id: 'claude',
    displayName: 'Claude Code',
    binaryName: 'claude',
    capabilities: {
      sessionResume: true,
      costTracking: true,
      contextWindow: true,
      hookStatus: true,
      configReading: true,
      shiftEnterNewline: true,
    },
    defaultContextWindowSize: 200_000,
  };

  resolveBinaryPath(): string {
    if (cachedBinaryPath) return cachedBinaryPath;

    const fullPath = getFullPath();

    // Check common locations directly
    const candidates = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(os.homedir(), '.local', 'bin', 'claude'),
      path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          cachedBinaryPath = candidate;
          return candidate;
        }
      } catch {}
    }

    // Try `which` with augmented PATH
    try {
      const resolved = execSync('which claude', {
        env: { ...process.env, PATH: fullPath },
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved) {
        cachedBinaryPath = resolved;
        return resolved;
      }
    } catch (err) {
      console.warn('Failed to resolve claude path via which:', err);
    }

    cachedBinaryPath = 'claude';
    return 'claude';
  }

  validatePrerequisites(): { ok: boolean; message: string } {
    const home = os.homedir();
    const candidates = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      path.join(home, '.local', 'bin', 'claude'),
      path.join(home, '.npm-global', 'bin', 'claude'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return { ok: true, message: '' };
      } catch {}
    }

    // Try `which` with augmented PATH
    try {
      const currentPath = process.env.PATH || '';
      const extraDirs = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/usr/local/sbin',
        '/opt/homebrew/sbin',
      ];
      const pathSet = new Set(currentPath.split(':'));
      for (const dir of extraDirs) {
        pathSet.add(dir);
      }
      const augmentedPath = Array.from(pathSet).join(':');

      const resolved = execSync('which claude', {
        env: { ...process.env, PATH: augmentedPath },
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (resolved) return { ok: true, message: '' };
    } catch {}

    return {
      ok: false,
      message:
        'Claude CLI not found.\n\n' +
        'Vibeyard requires the Claude Code CLI to be installed.\n\n' +
        'Install it with:\n' +
        '  npm install -g @anthropic-ai/claude-code\n\n' +
        'After installing, restart Vibeyard.',
    };
  }

  buildEnv(sessionId: string, baseEnv: Record<string, string>): Record<string, string> {
    const env = { ...baseEnv };
    delete env.CLAUDE_CODE; // avoid subprocess detection conflicts
    env.CLAUDE_IDE_SESSION_ID = sessionId;
    env.PATH = getFullPath();
    return env;
  }

  buildArgs(opts: { cliSessionId: string | null; isResume: boolean; extraArgs: string }): string[] {
    const args: string[] = [];
    if (opts.cliSessionId) {
      if (opts.isResume) {
        args.push('-r', opts.cliSessionId);
      } else {
        args.push('--session-id', opts.cliSessionId);
      }
    }
    if (opts.extraArgs) {
      args.push(...opts.extraArgs.split(/\s+/).filter(Boolean));
    }
    return args;
  }

  async installHooks(win?: BrowserWindow | null): Promise<void> {
    await guardedInstall(win ?? null);
  }

  installStatusScripts(): void {
    installStatusLineScript();
  }

  cleanup(): void {
    stopConfigWatch();
    cleanupHookStatus();
  }

  startConfigWatcher(win: BrowserWindow, projectPath: string): void {
    startConfigWatch(win, projectPath);
  }

  stopConfigWatcher(): void {
    stopConfigWatch();
  }

  async getConfig(projectPath: string): Promise<ClaudeConfig | null> {
    return getClaudeConfig(projectPath);
  }

  validateSettings(): SettingsValidationResult {
    return validateSettings();
  }

  reinstallSettings(): void {
    reinstallSettings();
    installStatusLineScript();
  }

  getShiftEnterSequence(): string | null {
    return '\x1b[13;2u';
  }

  parseCostFromOutput(rawText: string): { totalCostUsd: number } | null {
    const COST_RE = /\$(\d+\.\d{2,})/g;
    let match: RegExpExecArray | null;
    let lastCost: string | null = null;
    while ((match = COST_RE.exec(rawText)) !== null) {
      lastCost = match[0];
    }
    if (lastCost) {
      return { totalCostUsd: parseFloat(lastCost.replace('$', '')) };
    }
    return null;
  }
}

/** @internal Test-only: reset cached binary path */
export function _resetCachedPath(): void {
  cachedBinaryPath = null;
}
