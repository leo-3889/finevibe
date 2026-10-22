import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ReadinessCheck } from '../../shared/types';

export { readFileSafe, fileExists, dirExists, readDirSafe } from '../fs-utils';

const execFileAsync = promisify(execFile);

/**
 * Cap on the tracked-file list. Readiness producers scan this list, not the
 * tree; past a few thousand files a full enumeration says nothing more about
 * instruction/context coverage, and the producers' per-file loops grow for
 * nothing. Mirrors the enumerateProjectFiles cap.
 */
export const MAX_TRACKED_FILES = 5000;

/**
 * `git ls-files` output ceiling: 5000 paths at ~260 chars each plus margin —
 * the 1 MiB child_process default ENOBUFS'd past ~30k files, which the catch
 * turned into a silent [] and a collapsed readiness score (C3M-02).
 */
const LS_FILES_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Project-relative paths of every git-tracked file, forward-slash separated.
 *
 * `core.quotePath=false` is load-bearing: git otherwise octal-escapes any non-ASCII
 * path (`"packages/caf\303\251/AGENTS.md"`), which breaks every consumer that matches
 * on a path segment. The Set dedupes unmerged paths, which `git ls-files` prints once
 * per index stage — three identical rows for one file mid-merge-conflict.
 */
export async function getTrackedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', 'ls-files'], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: LS_FILES_MAX_BUFFER,
    });
    const files = [...new Set(stdout.split('\n').filter(Boolean))];
    return files.length > MAX_TRACKED_FILES ? files.slice(0, MAX_TRACKED_FILES) : files;
  } catch {
    // Non-git, git missing, timeout: the empty list is the "no evidence"
    // shape every producer already handles.
    return [];
  }
}

/**
 * Counts lines in a file without reading the entire content into a single string.
 * Uses a buffer-based approach to avoid large string allocations.
 *
 * If `maxLines` is provided, stops reading once the count exceeds it and returns
 * `maxLines + 1`. Callers that only need a "≤ threshold or not" answer should
 * pass the threshold to skip scanning the rest of huge files.
 */
export function countFileLines(filePath: string, maxLines?: number): number {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let lines = 0;
    let bytesRead: number;
    outer: while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0x0a) {
          lines++;
          if (maxLines !== undefined && lines > maxLines) break outer;
        }
      }
    }
    if (maxLines !== undefined && lines > maxLines) return lines;
    const stat = fs.fstatSync(fd);
    if (stat.size > 0) lines++;
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

export function computeCategoryScore(checks: ReadinessCheck[]): number {
  const scored = checks.filter(c => !c.informational);
  const totalMax = scored.reduce((sum, c) => sum + c.maxScore, 0);
  const totalScore = scored.reduce((sum, c) => sum + c.score, 0);
  return totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
}

