import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Root directory holding all auto-managed profile config dirs. */
export const PROFILES_ROOT = path.join(os.homedir(), '.vibeyard', 'profiles');

/** Default managed config dir for a profile id. */
export function managedProfileDir(profileId: string): string {
  return path.join(PROFILES_ROOT, profileId);
}

/**
 * Provision (mkdir -p) a profile config dir and return its resolved absolute
 * path. With no customPath, uses the managed location under PROFILES_ROOT.
 * A custom path is expanded (leading ~) and resolved to an absolute path.
 *
 * A custom path already used by an existing profile of a DIFFERENT provider
 * is rejected: Pi and OMP both relocate their whole agent tree via
 * PI_CODING_AGENT_DIR, so two providers pointed at the same dir would
 * silently share sessions and auth. Same-provider same path stays allowed
 * (e.g. re-provisioning).
 */
export function provisionProfileDir(
  profileId: string,
  customPath?: string,
  newProviderId?: string,
  existingProfiles: ReadonlyArray<{ providerId: string; configDir: string }> = []
): string {
  const trimmed = customPath?.trim();
  const dir = trimmed
    ? path.resolve(trimmed.replace(/^~(?=$|[/\\])/, os.homedir()))
    : managedProfileDir(profileId);
  if (trimmed) {
    const collision = existingProfiles.find(
      (p) => p.providerId !== newProviderId && path.resolve(p.configDir) === dir
    );
    if (collision) {
      throw new Error(
        `Custom profile path ${dir} is already used by a ${collision.providerId} profile. ` +
        `Choose a different directory — a config dir is scoped to one provider.`
      );
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
