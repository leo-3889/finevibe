import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { deleteAgentFile, writeAgentFile } from './agent-files';

vi.mock('fs', () => {
  const mkdirSync = vi.fn();
  const writeFile = vi.fn(async () => undefined);
  const unlink = vi.fn(async () => undefined);
  return {
    mkdirSync,
    promises: { writeFile, unlink },
  };
});

import * as fs from 'fs';

const mkdirSync = vi.mocked(fs.mkdirSync);
const writeFile = vi.mocked(fs.promises.writeFile);
const unlink = vi.mocked(fs.promises.unlink);

beforeEach(() => {
  mkdirSync.mockReset();
  writeFile.mockReset().mockResolvedValue(undefined as never);
  unlink.mockReset().mockResolvedValue(undefined as never);
});

describe('writeAgentFile', () => {
  it('creates the directory recursively and writes UTF-8', async () => {
    const dir = path.join('/home/u', '.claude', 'agents');
    const result = await writeAgentFile(dir, 'cmo', '---\nname: cmo\n---\nhi');

    expect(mkdirSync).toHaveBeenCalledWith(dir, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(path.join(dir, 'cmo.md'), '---\nname: cmo\n---\nhi', 'utf8');
    expect(result.filePath).toBe(path.join(dir, 'cmo.md'));
  });

  it('overwrites existing files (writeFile is the destination)', async () => {
    const dir = path.join('/x');
    await writeAgentFile(dir, 'a', 'one');
    await writeAgentFile(dir, 'a', 'two');
    expect(writeFile).toHaveBeenLastCalledWith(path.join(dir, 'a.md'), 'two', 'utf8');
  });

  it('honors a custom extension', async () => {
    const dir = path.join('/home/u', '.copilot', 'agents');
    const result = await writeAgentFile(dir, 'cmo', 'body', '.agent.md');

    expect(writeFile).toHaveBeenCalledWith(path.join(dir, 'cmo.agent.md'), 'body', 'utf8');
    expect(result.filePath).toBe(path.join(dir, 'cmo.agent.md'));
  });
});

describe('deleteAgentFile', () => {
  it('unlinks the agent file', async () => {
    const dir = path.join('/home/u', '.codex', 'agents');
    await deleteAgentFile(dir, 'cmo');
    expect(unlink).toHaveBeenCalledWith(path.join(dir, 'cmo.md'));
  });

  it('honors a custom extension', async () => {
    const dir = path.join('/home/u', '.copilot', 'agents');
    await deleteAgentFile(dir, 'cmo', '.agent.md');
    expect(unlink).toHaveBeenCalledWith(path.join(dir, 'cmo.agent.md'));
  });

  it('swallows ENOENT', async () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    unlink.mockRejectedValueOnce(err);
    await expect(deleteAgentFile('/x', 'gone')).resolves.toBeUndefined();
  });

  it('rethrows non-ENOENT errors', async () => {
    const err = Object.assign(new Error('perm'), { code: 'EACCES' });
    unlink.mockRejectedValueOnce(err);
    await expect(deleteAgentFile('/x', 'cmo')).rejects.toThrow('perm');
  });
});
