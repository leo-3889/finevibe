import * as fs from 'fs';
import * as path from 'path';

/** Write `<dir>/<slug>.md` with the given content. Creates the directory recursively. */
export async function writeAgentFile(
  dir: string,
  slug: string,
  content: string,
): Promise<{ filePath: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${slug}.md`);
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { filePath };
}

/** Delete `<dir>/<slug>.md`. Swallows ENOENT so callers can call freely. */
export async function deleteAgentFile(dir: string, slug: string): Promise<void> {
  const filePath = path.join(dir, `${slug}.md`);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
