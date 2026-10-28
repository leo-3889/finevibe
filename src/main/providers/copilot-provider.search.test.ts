import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  createReadStream: vi.fn(),
  promises: { readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home' }));

vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('../copilot-config', () => ({ getCopilotConfig: () => ({}) }));
vi.mock('../copilot-hooks', () => ({
  installCopilotHooks: () => {}, validateCopilotHooks: () => ({}), cleanupCopilotHooks: () => {}, SESSION_ID_VAR: 'COPILOT_SESSION_ID',
}));
vi.mock('../config-watcher', () => ({ startConfigWatcher: () => {}, stopConfigWatcher: () => {} }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true, validateBinaryExistsAsync: async () => true }));

import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough } from 'stream';
import { CopilotProvider } from './copilot-provider';

const mockReadFile = vi.mocked(fs.promises.readFile);
const mockReaddir = vi.mocked(fs.promises.readdir);

const UUID = '54c23d7f-4fd6-4078-8a69-5eb73317a421';

function dir(name: string) { return { name, isDirectory: () => true } as fs.Dirent; }
function file(name: string) { return { name, isDirectory: () => false } as fs.Dirent; }

function makeJsonl(entries: object[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

function mockIndexFile(jsonl: string): void {
  vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: Buffer.byteLength(jsonl) } as fs.Stats);
  vi.mocked(fs.createReadStream).mockReturnValueOnce(Readable.from([jsonl]) as fs.ReadStream);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('CopilotProvider.discoverTranscripts()', () => {
  it('uses dir name as cliSessionId and parses cwd from workspace.yaml', async () => {
    mockReaddir.mockResolvedValueOnce([dir(UUID), dir('not-a-uuid'), file('stray.txt')] as any);
    mockReadFile.mockResolvedValueOnce(
      `id: ${UUID}\ncwd: /Users/me/dev/repo\nsummary_count: 0\n` as any,
    );

    const { descriptors: out, complete } = await new CopilotProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(UUID);
    expect(out[0].projectCwd).toBe('/Users/me/dev/repo');
    expect(out[0].transcriptPath).toContain('events.jsonl');
  });

  it('still discovers when workspace.yaml is missing (cwd empty)', async () => {
    mockReaddir.mockResolvedValueOnce([dir(UUID)] as any);
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

    const { descriptors: out, complete } = await new CopilotProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].projectCwd).toBe('');
  });

  it('reports a complete empty pass when the session-state root is missing', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await new CopilotProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('marks the pass incomplete when the root readdir fails transiently (P2-70)', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    const { descriptors: out, complete, incompleteRoots } = await new CopilotProvider().discoverTranscripts();
    expect(out).toEqual([]);
    expect(complete).toBe(false);
    expect(incompleteRoots).toEqual([path.join('/mock/home', '.copilot', 'session-state')]);
  });
});

describe('CopilotProvider.indexTranscript()', () => {
  it('only extracts user.message data.content', async () => {
    const jsonl = makeJsonl([
      { type: 'session.start', data: {} },
      { type: 'user.message', data: { content: 'first prompt' } },
      { type: 'assistant.message', data: { content: 'never indexed' } },
      { type: 'user.message', data: { content: 'follow-up' } },
    ]);
    mockIndexFile(jsonl);
    const r = await new CopilotProvider().indexTranscript('/p');
    expect(r.text).toContain('first prompt');
    expect(r.text).toContain('follow-up');
    expect(r.text).not.toContain('never indexed');
  });

  it('tolerates malformed lines', async () => {
    const jsonl = `{broken\n${JSON.stringify({ type: 'user.message', data: { content: 'good prompt' } })}`;
    mockIndexFile(jsonl);
    const r = await new CopilotProvider().indexTranscript('/p');
    expect(r.text).toContain('good prompt');
  });

  it('skips non-string content and keeps indexing later entries (P2-56)', async () => {
    // Array/object content threw into the best-effort catch: the entry was
    // silently dropped from the persistent index. Non-strings are skipped;
    // the stream continues.
    const jsonl = makeJsonl([
      { type: 'user.message', data: { content: ['array', 'parts'] } },
      { type: 'user.message', data: {} },
      { type: 'user.message', data: { content: 'real prompt' } },
    ]);
    mockIndexFile(jsonl);
    const r = await new CopilotProvider().indexTranscript('/p');
    expect(r.text).toContain('real prompt');
    expect(r.text).not.toContain('array');
  });

  it('terminates the read loop when the budget fills (C3M-07)', async () => {
    // ~100 KiB of user text fills the 50 KiB budget mid-stream. The input
    // NEVER ends: the old `if (budget.full) continue` loop would await the
    // stream to its end and hang; the break resolves the call.
    const jsonl = Array.from({ length: 800 }, (_, i) =>
      JSON.stringify({ type: 'user.message', data: { content: `prompt ${i} ${'x'.repeat(100)}` } })).join('\n');
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: 10 * 1024 * 1024 } as fs.Stats);
    const open = new PassThrough();
    vi.mocked(fs.createReadStream).mockReturnValueOnce(open as unknown as fs.ReadStream);

    const run = new CopilotProvider().indexTranscript('/p');
    open.write(jsonl);
    const r = await run;
    expect(r.text.length).toBeLessThanOrEqual(50 * 1024);
    expect(r.text).toContain('prompt 0');
  });
});
