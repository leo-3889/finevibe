import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readdirSync: vi.fn(() => []),
  createReadStream: vi.fn(),
  promises: { readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home' }));

vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('../codex-config', () => ({ getCodexConfig: async () => ({}) }));
vi.mock('../codex-hooks', () => ({
  installCodexHooks: () => {}, validateCodexHooks: () => ({}), cleanupCodexHooks: () => {}, SESSION_ID_VAR: 'CODEX_SESSION_ID',
}));
vi.mock('../config-watcher', () => ({ startConfigWatcher: () => {}, stopConfigWatcher: () => {} }));
vi.mock('../codex-session-watcher', () => ({
  startCodexSessionWatcher: vi.fn(),
  registerPendingCodexSession: vi.fn(),
  unregisterCodexSession: vi.fn(),
}));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true }));

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { CodexProvider } from './codex-provider';

const mockReaddir = vi.mocked(fs.promises.readdir);

const UUID = '019d3512-caf9-7b50-8d2b-ccccdcf8ff14';

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

describe('CodexProvider.discoverTranscripts()', () => {
  it('walks YYYY/MM/DD and parses cliSessionId from filename suffix', async () => {
    // Walker uses readdir withFileTypes at each level; depth 3 enumerates files.
    mockReaddir
      .mockResolvedValueOnce([dir('2026')] as any)
      .mockResolvedValueOnce([dir('03')] as any)
      .mockResolvedValueOnce([dir('28')] as any)
      .mockResolvedValueOnce([
        file(`rollout-2026-03-28T18-31-57-${UUID}.jsonl`),
        file('README.md'),
      ] as any);

    const { descriptors: out, complete } = await new CodexProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(UUID);
    expect(out[0].transcriptPath).toContain(`rollout-2026-03-28T18-31-57-${UUID}.jsonl`);
  });

  it('reports a complete empty pass when the root is missing', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await new CodexProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('marks the pass incomplete when a day dir readdir fails transiently (P2-70)', async () => {
    mockReaddir
      .mockResolvedValueOnce([dir('2026')] as any)
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));

    const { descriptors: out, complete, incompleteRoots } = await new CodexProvider().discoverTranscripts();
    expect(out).toEqual([]);
    expect(complete).toBe(false);
    expect(incompleteRoots).toEqual([path.join('/mock/home', '.codex', 'sessions')]);
  });
});

describe('CodexProvider.indexTranscript()', () => {
  it('pulls cwd from session_meta and user text from response_item with role=user', async () => {
    const jsonl = makeJsonl([
      { type: 'session_meta', payload: { cwd: '/Users/me/repo', id: UUID } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'fix the bug' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'never indexed' },
      ] } },
    ]);
    mockIndexFile(jsonl);
    const r = await new CodexProvider().indexTranscript('/p');
    expect(r.cwd).toBe('/Users/me/repo');
    expect(r.text).toContain('fix the bug');
    expect(r.text).not.toContain('never indexed');
  });

  it('concatenates multiple input_text blocks', async () => {
    const jsonl = makeJsonl([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'part one' },
        { type: 'input_text', text: 'part two' },
      ] } },
    ]);
    mockIndexFile(jsonl);
    const r = await new CodexProvider().indexTranscript('/p');
    expect(r.text).toContain('part one');
    expect(r.text).toContain('part two');
  });
});

describe('CodexProvider .jsonl.zst transcripts', () => {
  // Recent Codex builds compress every rollout to `.jsonl.zst`; before this
  // the provider matched only `.jsonl`, so resume/transcripts were dead on
  // every modern install.
  const zlib = require('zlib') as typeof import('zlib');

  function mockIndexFileZst(jsonl: string): void {
    const compressed = zlib.zstdCompressSync(Buffer.from(jsonl, 'utf-8'));
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: compressed.length } as fs.Stats);
    vi.mocked(fs.createReadStream).mockReturnValueOnce(Readable.from([compressed]) as fs.ReadStream);
  }

  it('discoverTranscripts matches .jsonl.zst rollout files', async () => {
    mockReaddir
      .mockResolvedValueOnce([dir('2026')] as any)
      .mockResolvedValueOnce([dir('10')] as any)
      .mockResolvedValueOnce([dir('10')] as any)
      .mockResolvedValueOnce([
        file(`rollout-2026-10-10T22-12-14-${UUID}.jsonl.zst`),
      ] as any);

    const { descriptors: out, complete } = await new CodexProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].cliSessionId).toBe(UUID);
  });

  it('getTranscriptPath resolves the compressed file', () => {
    const readdirSync = vi.mocked<(p: string) => string[]>(fs.readdirSync);
    readdirSync
      .mockReturnValueOnce(['2026'])
      .mockReturnValueOnce(['10'])
      .mockReturnValueOnce(['10'])
      .mockReturnValueOnce([`rollout-2026-10-10T22-12-14-${UUID}.jsonl.zst`]);

    const p = new CodexProvider().getTranscriptPath(UUID, '/proj');
    expect(p).toBe(path.join('/mock/home/.codex/sessions', '2026', '10', '10', `rollout-2026-10-10T22-12-14-${UUID}.jsonl.zst`));
  });

  it('indexTranscript decompresses zst and extracts cwd + user text', async () => {
    const jsonl = makeJsonl([
      { type: 'session_meta', payload: { cwd: 'C:\\repo', id: UUID } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'compressed prompt' },
      ] } },
    ]);
    mockIndexFileZst(jsonl);
    const r = await new CodexProvider().indexTranscript(`/p/rollout-x-${UUID}.jsonl.zst`);
    expect(r.cwd).toBe('C:\\repo');
    expect(r.text).toContain('compressed prompt');
  });

  it('indexTranscript tolerates a truncated zstd tail frame (incremental compression)', async () => {
    // Codex compresses incrementally: concatenated frames, the newest frame
    // truncated mid-write. A single frame decoded atomically yields nothing
    // when cut, so stage two frames — the head must decode, the tail die.
    const head = makeJsonl([
      { type: 'session_meta', payload: { cwd: '/repo', id: UUID } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'first frame survives' },
      ] } },
    ]);
    const tail = makeJsonl([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'tail frame is cut off' },
      ] } },
    ]);
    const c1 = zlib.zstdCompressSync(Buffer.from(`${head}\n`, 'utf-8'));
    const c2 = zlib.zstdCompressSync(Buffer.from(`${tail}\n`, 'utf-8'));
    const truncated = Buffer.concat([c1, c2.subarray(0, Math.max(1, c2.length >> 1))]);
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: truncated.length } as fs.Stats);
    vi.mocked(fs.createReadStream).mockReturnValueOnce(Readable.from([truncated]) as fs.ReadStream);

    const r = await new CodexProvider().indexTranscript(`/p/rollout-x-${UUID}.jsonl.zst`);
    // Best-effort: at least the head frame's content is indexed; no throw.
    expect(r.text).toContain('first frame survives');
  });
});
