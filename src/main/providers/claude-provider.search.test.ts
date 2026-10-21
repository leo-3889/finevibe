import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  createReadStream: vi.fn(),
  promises: { readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn() },
}));
vi.mock('os', () => ({ homedir: () => '/mock/home' }));

// Heavy main-process deps imported by claude-provider that we don't exercise here.
vi.mock('../pty-manager', () => ({ getFullPath: () => '' }));
vi.mock('../hook-status', () => ({ installStatusLineScript: () => {}, cleanupAll: () => {} }));
vi.mock('../config-watcher', () => ({ startConfigWatcher: () => {}, stopConfigWatcher: () => {} }));
vi.mock('../claude-cli', () => ({ installHooksOnly: () => {}, installStatusLine: () => {}, getClaudeConfig: async () => ({}) }));
vi.mock('../settings-guard', () => ({ guardedInstall: async () => {}, validateSettings: () => ({}), reinstallSettings: () => {} }));
vi.mock('./resolve-binary', () => ({ resolveBinary: () => '', validateBinaryExists: () => true }));
vi.mock('../store', () => ({ loadState: vi.fn(() => ({ profiles: [] })) }));

import * as fs from 'fs';
import { Readable } from 'stream';
import * as path from 'path';
import { ClaudeProvider } from './claude-provider';
import { loadState } from '../store';

const mockReadFile = vi.mocked(fs.promises.readFile);
const mockReaddir = vi.mocked(fs.promises.readdir);
const mockLoadState = vi.mocked(loadState);

const FAKE_UUID = '550e8400-e29b-41d4-a716-446655440000';

function dir(name: string) { return { name, isDirectory: () => true } as fs.Dirent; }
function file(name: string) { return { name, isDirectory: () => false } as fs.Dirent; }

function makeJsonl(entries: object[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

function mockIndexFile(jsonl: string): void {
  vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: Buffer.byteLength(jsonl) } as fs.Stats);
  vi.mocked(fs.createReadStream).mockReturnValueOnce(Readable.from([jsonl]) as fs.ReadStream);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadState.mockReturnValue({ profiles: [] } as any);
});

describe('ClaudeProvider.discoverTranscripts()', () => {
  it('reports a complete empty pass when the projects root is missing', async () => {
    mockReaddir.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await new ClaudeProvider().discoverTranscripts())
      .toEqual({ descriptors: [], complete: true, incompleteRoots: [] });
  });

  it('lists every UUID-named JSONL across slugs', async () => {
    mockReaddir
      .mockResolvedValueOnce([dir('proj-a'), dir('proj-b')] as any)
      .mockResolvedValueOnce([`${FAKE_UUID}.jsonl`, 'history.jsonl'] as any)
      .mockResolvedValueOnce([`${FAKE_UUID}.jsonl`] as any);

    const { descriptors: out, complete } = await new ClaudeProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(2);
    expect(out[0].cliSessionId).toBe(FAKE_UUID);
    expect(out[0].projectSlug).toBe('proj-a');
    expect(out[0].transcriptPath).toMatch(/proj-a/);
  });

  it('skips non-directory entries and non-UUID filenames', async () => {
    mockReaddir
      .mockResolvedValueOnce([file('file.json'), dir('validslug')] as any)
      .mockResolvedValueOnce(['notes.jsonl', `${FAKE_UUID}.jsonl`] as any);

    const { descriptors: out, complete } = await new ClaudeProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].projectSlug).toBe('validslug');
  });

  it('marks the pass incomplete when a slug readdir fails transiently (P2-70)', async () => {
    mockReaddir
      .mockResolvedValueOnce([dir('ok'), dir('bad')] as any)
      .mockResolvedValueOnce([`${FAKE_UUID}.jsonl`] as any)
      .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const { descriptors: out, complete, incompleteRoots } = await new ClaudeProvider().discoverTranscripts();
    // The partial corpus is not reportable as the truth: descriptors are
    // dropped and the root is named, so the caller keeps the derived index.
    expect(out).toEqual([]);
    expect(complete).toBe(false);
    expect(incompleteRoots).toEqual([path.join('/mock/home', '.claude', 'projects')]);
  });

  it('unions the default config dir with every claude profile config dir', async () => {
    mockLoadState.mockReturnValue({
      profiles: [
        { id: 'work', name: 'Work', providerId: 'claude', configDir: '/mock/home/.finevibe/profiles/work', managed: true, createdAt: 0 },
        // Non-claude profile is ignored.
        { id: 'cdx', name: 'Codex', providerId: 'codex', configDir: '/mock/home/.finevibe/profiles/cdx', managed: true, createdAt: 0 },
      ],
    } as any);
    // Default root, then its slug files; then the profile root, then its slug files.
    mockReaddir
      .mockResolvedValueOnce([dir('proj-default')] as any)
      .mockResolvedValueOnce([`${FAKE_UUID}.jsonl`] as any)
      .mockResolvedValueOnce([dir('proj-work')] as any)
      .mockResolvedValueOnce([`${FAKE_UUID}.jsonl`] as any);

    const { descriptors: out, complete } = await new ClaudeProvider().discoverTranscripts();
    expect(complete).toBe(true);
    expect(out).toHaveLength(2);
    const def = out.find(d => d.transcriptPath.includes('proj-default'));
    const work = out.find(d => d.transcriptPath.includes(path.join('profiles', 'work')));
    expect(def?.profileId).toBeUndefined();   // default root carries no profile
    expect(work?.profileId).toBe('work');     // profile root tags its profileId
  });
});

describe('ClaudeProvider.indexTranscript()', () => {
  it('extracts user-message text and the first cwd it sees', async () => {
    const jsonl = makeJsonl([
      { cwd: '/Users/me/repo' },
      { type: 'user', message: { content: 'hello world' } },
      { type: 'assistant', message: { content: 'never indexed' } },
    ]);
    mockIndexFile(jsonl);
    const r = await new ClaudeProvider().indexTranscript('/p');
    expect(r.cwd).toBe('/Users/me/repo');
    expect(r.text).toContain('hello world');
    expect(r.text).not.toContain('never indexed');
  });

  it('handles content as array of text blocks, ignoring non-text blocks', async () => {
    const jsonl = makeJsonl([
      { type: 'user', message: { content: [
        { type: 'text', text: 'refactor authentication' },
        { type: 'tool_use', id: 't1' },
      ] } },
    ]);
    mockIndexFile(jsonl);
    const r = await new ClaudeProvider().indexTranscript('/p');
    expect(r.text).toContain('refactor authentication');
  });

  it('tolerates malformed JSONL lines', async () => {
    const jsonl = 'not json\n{"type":"user","message":{"content":"valid"}}\n{broken';
    mockIndexFile(jsonl);
    const r = await new ClaudeProvider().indexTranscript('/p');
    expect(r.text).toContain('valid');
  });

  it('caps one oversized user message at the per-session index limit', async () => {
    const jsonl = makeJsonl([{ type: 'user', message: { content: 'x'.repeat(100_000) } }]);
    mockIndexFile(jsonl);
    const r = await new ClaudeProvider().indexTranscript('/p');
    expect(r.text.length).toBe(50 * 1024);
  });
});
