/**
 * Window-icon layout pin (audit 2026-12: "packaged icon path is dead" was a
 * false alarm — the packaged __dirname is app.asar/dist/main/main, three ups
 * = app.asar root, and build/icon.png IS shipped via build.files; the icon
 * resolves in dev AND packaged). This test replaces a fix: it fails if a
 * future restructure breaks that alignment.
 *
 * Everything is derived, nothing hardcoded:
 *   - the runtime __dirname location  <- package.json "main" entry
 *   - the packaged icon location      <- package.json build.files icon entry
 *     (electron-builder preserves repo-relative paths inside the asar)
 *   - the resolution expression itself <- the icon: path.join(__dirname, ...)
 *     line in main.ts
 * So moving outDir, the files glob, or the '..' depth each independently
 * break a case below. If the icon expression is rewritten into a helper, the
 * parse case fails with a message — update the pin together with the new
 * asar-path proof, never silently.
 */
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// e.g. dist/main/main — main.js lives here in dev (under the repo root) and
// inside app.asar when packaged, so the runtime __dirname is
// <root>/<entryDir> in both.
const entryDir = path.dirname(pkg.main as string);

// The exact (no-glob, non-negated) icon.png entry in build.files: that file
// ships into the asar at <asarRoot>/<that path>.
const iconFile = (pkg.build.files as string[]).find(
  (f) => !f.startsWith('!') && !f.includes('*') && f.endsWith('icon.png'),
);

/** The argument list after __dirname in the createWindow icon expression. */
function iconJoinArgs(): string[] {
  const src = readFileSync(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8');
  const match = src.match(/icon:\s*path\.join\(\s*__dirname\s*((?:,\s*'[^']*')+)\s*\)/);
  if (!match) {
    throw new Error(
      'icon: path.join(__dirname, ...) not found in main.ts — the icon expression was rewritten; ' +
        're-derive the packaged __dirname from package.json "main" and prove the asar path before updating this pin.',
    );
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

const resolveIcon = (root: string) => path.join(root, entryDir, ...iconJoinArgs());

describe('window icon layout (main.ts + package.json packaging)', () => {
  it('build.files ships an exact build/icon.png entry (the packaged icon source)', () => {
    expect(iconFile, 'package.json build.files must carry an exact icon.png entry — the window icon reads it at <asarRoot>/build/icon.png').toBeTruthy();
  });

  it('packaged: icon resolves to app.asar/<files icon entry>', () => {
    const asarRoot = path.join('/opt', 'FineVibe', 'resources', 'app.asar');
    expect(resolveIcon(asarRoot)).toBe(path.join(asarRoot, iconFile as string));
  });

  it('dev: icon resolves to the repo build/icon.png, and that file exists', () => {
    const dev = resolveIcon(repoRoot);
    expect(dev).toBe(path.join(repoRoot, iconFile as string));
    expect(existsSync(dev), `${dev} is git-tracked; a dev run without it ships no window icon`).toBe(true);
  });
});
