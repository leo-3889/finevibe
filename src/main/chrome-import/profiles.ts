import * as fs from 'fs';
import * as path from 'path';
import type { ChromeProfile } from '../../shared/types';
import { chromeUserDataDir, localStatePath } from './paths';

interface LocalState {
  profile?: {
    info_cache?: Record<string, { name?: string; user_name?: string; gaia_name?: string }>;
  };
}

/** Lists available Chrome profiles. Returns empty array if Chrome isn't installed. */
export function listProfiles(): ChromeProfile[] {
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) return [];

  const profiles: ChromeProfile[] = [];
  const seen = new Set<string>();

  try {
    const raw = fs.readFileSync(localStatePath(userDataDir), 'utf-8');
    const parsed = JSON.parse(raw) as LocalState;
    const cache = parsed.profile?.info_cache;
    if (cache) {
      for (const [id, info] of Object.entries(cache)) {
        const displayName = info.name || info.gaia_name || info.user_name || id;
        if (fs.existsSync(path.join(userDataDir, id))) {
          profiles.push({ id, displayName });
          seen.add(id);
        }
      }
    }
  } catch {
    // fall through to directory scan
  }

  // Always scan for profile dirs in case Local State is missing/corrupt
  try {
    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name !== 'Default' && !name.startsWith('Profile ')) continue;
      if (seen.has(name)) continue;
      profiles.push({ id: name, displayName: name });
      seen.add(name);
    }
  } catch {
    // ignore
  }

  // Sort: Default first, then by id
  profiles.sort((a, b) => {
    if (a.id === 'Default') return -1;
    if (b.id === 'Default') return 1;
    return a.id.localeCompare(b.id);
  });

  return profiles;
}
