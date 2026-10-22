import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMember } from '../../../shared/types';

vi.mock('../../../shared/team-config.js', () => ({
  buildContentsApiUrl: () => 'https://api.github.com/repos/leo-3889/vibeyard/contents/team',
}));
vi.mock('./frontmatter.js', () => ({
  memberFromMarkdown: (raw: string, meta: { fallbackId: string }) => ({ id: meta.fallbackId, raw }),
}));

import { fetchPredefinedMembers } from './github-fetcher';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const LIST = [
  { name: 'ada.md', type: 'file', download_url: 'https://raw.example/ada.md' },
  { name: 'grace.md', type: 'file', download_url: 'https://raw.example/grace.md' },
  { name: 'no-url.md', type: 'file', download_url: null },
  { name: 'archive', type: 'dir', download_url: null },
];

const listResponse = { ok: true, json: async () => LIST };

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchPredefinedMembers fetch deadlines (C4G-08)', () => {
  it('arms a 15 s AbortSignal.timeout on the listing fetch and on every download', async () => {
    const timeouts: number[] = [];
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return controller.signal;
    });
    mockFetch.mockImplementationOnce(async () => listResponse);
    mockFetch.mockImplementation(async () => ({ ok: true, text: async () => '# member' }));

    const members = await fetchPredefinedMembers();
    expect(members).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(3); // listing + the two .md downloads
    expect(timeouts).toEqual([15_000, 15_000, 15_000]);

    const listInit = mockFetch.mock.calls[0][1] as { headers: Record<string, string>; signal: AbortSignal };
    expect(listInit.headers.Accept).toContain('github');
    expect(listInit.signal).toBe(controller.signal);
  });

  it('skips a download whose request times out and still settles', async () => {
    mockFetch.mockImplementationOnce(async () => listResponse);
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('ada.md')) {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      return { ok: true, text: async () => '# grace' };
    });

    const members = (await fetchPredefinedMembers()) as unknown as Array<{ id: string }>;
    expect(members.map(m => m.id)).toEqual(['grace']);
  });

  it('rejects (so the caller settles) when the listing fetch times out', async () => {
    mockFetch.mockImplementationOnce(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    await expect(fetchPredefinedMembers() as Promise<TeamMember[]>).rejects.toThrow(/timeout/i);
  });
});
