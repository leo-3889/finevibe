import * as fs from 'fs';
import * as path from 'path';
import type { ImportableLegacyProject } from '../shared/types';

// Runtime companion to the one-time file migration (userdata-migration.ts).
// That migration copies `~/.vibeyard` -> `~/.finevibe` destination-wins, so
// on any install that had already written `~/.finevibe/state.json` before
// updating, the legacy project list was never merged: the projects vanish
// from the board even though every directory is still on disk. This module
// reads the legacy `state.json` (read-only, never mutated) and enumerates
// what can be imported; the renderer adds the user's picks through its own
// state -> persist path.
//
// Contract mirroring the module above: pure w.r.t. the injected options,
// framework-free (no electron import), and it NEVER throws - a missing
// file, garbage JSON, or a hostile entry degrades to `[]`/dropped entries.

const LEGACY_HOME_DIR = '.vibeyard';
/** Bound the import picker: a state.json can carry a decade of projects. */
const MAX_IMPORTABLE = 500;

interface ListImportableOptions {
  /** Injected for testability (same shape as UserDataMigrationOptions). */
  homedir: string;
  /** Normalized-equal project paths already in the live state; they never reappear as importable. */
  existingPaths: string[];
  pathExists?: (p: string) => boolean;
}

/** One entry of the legacy `{ version: 1, projects: [...] }` - untrusted JSON. */
interface LegacyProjectEntry {
  name?: unknown;
  path?: unknown;
  sessions?: unknown;
}

/**
 * Equality key for a project path: separators + relative/absolute spelling
 * are normalized away, and on win32 the comparison is case-insensitive (the
 * filesystem is). Legacy `path` values are Windows-style strings; on POSIX
 * they resolve under the cwd and fail `pathExists`, which is the correct
 * drop - a Windows path is never a live directory there.
 */
function comparablePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * List legacy vibeyard projects that can be imported into the current
 * project list: the entry must carry a usable name + path, that path must
 * exist, and it must not duplicate a project the board already knows
 * (case/separator-insensitively, and once within the legacy list itself).
 */
export function listImportableLegacyProjects(opts: ListImportableOptions): ImportableLegacyProject[] {
  const pathExists = opts.pathExists ?? fs.existsSync;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(opts.homedir, LEGACY_HOME_DIR, 'state.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return [];

  // One set serves both filters: the live paths seed it, and every accepted
  // entry joins it, so intra-legacy duplicates hit the same check.
  const taken = new Set<string>();
  for (const existing of opts.existingPaths) {
    if (typeof existing === 'string' && existing.trim()) {
      taken.add(comparablePath(existing));
    }
  }

  const out: ImportableLegacyProject[] = [];
  for (const entry of projects as LegacyProjectEntry[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = entry.name;
    const projectPath = entry.path;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof projectPath !== 'string' || !projectPath.trim()) continue;
    let exists = false;
    try {
      exists = pathExists(projectPath);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const key = comparablePath(projectPath);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({
      name,
      // Spell the path for the current platform; equality above used the
      // resolved form, the picker shows/imports the normalized spelling.
      path: path.normalize(projectPath),
      sessions: Array.isArray(entry.sessions) ? entry.sessions.length : 0,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, MAX_IMPORTABLE);
}
