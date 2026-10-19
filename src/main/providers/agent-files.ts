import * as fs from 'fs';
import * as path from 'path';

/** Slugs become file names; they must not carry path syntax (IPC callers pass renderer-supplied values). */
const AGENT_SLUG_RE = /^[A-Za-z0-9._-]+$/;

function assertSafeSlug(slug: string): void {
  if (!AGENT_SLUG_RE.test(slug)) {
    throw new Error(`Unsafe agent slug: ${JSON.stringify(slug)}`);
  }
}

/** Write `<dir>/<slug><ext>` with the given content. Creates the directory recursively. */
export async function writeAgentFile(
  dir: string,
  slug: string,
  content: string,
  ext: string = '.md',
): Promise<{ filePath: string }> {
  assertSafeSlug(slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}${ext}`);
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { filePath };
}

/** Delete `<dir>/<slug><ext>`. Swallows ENOENT so callers can call freely. */
export async function deleteAgentFile(dir: string, slug: string, ext: string = '.md'): Promise<void> {
  assertSafeSlug(slug);
  const filePath = path.join(dir, `${slug}${ext}`);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
