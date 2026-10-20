import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeAgentFile, deleteAgentFile } from './agent-files';

describe('agent-files slug guard', () => {
  // The slug arrives from the renderer over provider:installAgent; a slug
  // with path syntax used to be a write/unlink primitive outside the agents
  // dir ("../../evil", absolute fragments, separators).
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-files-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outside-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('writes a well-formed slug inside the dir', async () => {
    const { filePath } = await writeAgentFile(dir, 'review-bot.v1', 'content');
    expect(filePath).toBe(path.join(dir, 'review-bot.v1.md'));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('content');
  });

  it('rejects traversal slugs without touching the filesystem', async () => {
    const victim = path.join(outside, 'evil.md');
    await expect(writeAgentFile(dir, '../evil', 'x')).rejects.toThrow(/Unsafe agent slug/);
    await expect(writeAgentFile(dir, '..\\..\\evil', 'x')).rejects.toThrow(/Unsafe agent slug/);
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('rejects separator and empty slugs on delete', async () => {
    const victim = path.join(outside, 'target.md');
    fs.writeFileSync(victim, 'keep');
    await expect(deleteAgentFile(dir, '../../target')).rejects.toThrow(/Unsafe agent slug/);
    await expect(deleteAgentFile(dir, '')).rejects.toThrow(/Unsafe agent slug/);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('delete of a safe slug swallows ENOENT', async () => {
    await expect(deleteAgentFile(dir, 'ghost')).resolves.toBeUndefined();
  });
});
