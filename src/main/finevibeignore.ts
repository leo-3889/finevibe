import * as path from 'path';
import picomatch from 'picomatch';
import { readFileSafe } from './fs-utils';
import { DEFAULT_SCAN_IGNORE } from '../shared/constants';

/** Current and pre-rename ignore-file names. The legacy name stays readable so
 * projects configured before the rename keep their exclusions; the new name wins
 * when both exist, matching the renderer's `loadFineVibeignore` contract. */
const IGNORE_FILE = '.finevibeignore';
const LEGACY_IGNORE_FILE = '.vibeyardignore';

/**
 * Reads `.finevibeignore` (falling back to the legacy `.vibeyardignore`) from a
 * project root and returns its active glob patterns (blank lines and `#`
 * comments stripped). When neither file is present, built-in exclusions apply in
 * memory without creating a project file.
 */
export function loadScanIgnorePatterns(projectPath: string): string[] {
  const patterns: string[] = [];
  const content = readFileSafe(path.join(projectPath, IGNORE_FILE))
    ?? readFileSafe(path.join(projectPath, LEGACY_IGNORE_FILE));
  if (content === null) return [...DEFAULT_SCAN_IGNORE];
  if (content) {
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line && !line.startsWith('#')) {
        patterns.push(line);
      }
    }
  }
  return patterns;
}

/**
 * Builds a predicate that reports whether a project-relative path is excluded
 * by the project's `.finevibeignore`. Patterns are matched against both the
 * basename (e.g. `*.min.js`) and the full relative path (e.g. a glob under
 * `src/`). When there are no patterns, the predicate is a constant `false`
 * (nothing is ignored).
 */
export function buildFineVibeIgnoreMatcher(projectPath: string): (relPath: string) => boolean {
  const patterns = loadScanIgnorePatterns(projectPath);
  if (patterns.length === 0) return () => false;
  const matchBasename = picomatch(patterns, { basename: true });
  const matchFullPath = picomatch(patterns);
  return (relPath: string) => matchBasename(relPath) || matchFullPath(relPath);
}
