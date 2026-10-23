import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';

const openFileReaderChecked = vi.fn();
vi.mock('../open-file-reader.js', () => ({ openFileReaderChecked }));

const { FilePathLinkProvider } = await import('./terminal-link-provider.js');

beforeEach(() => {
  vi.clearAllMocks();
  openFileReaderChecked.mockResolvedValue(true);
});

/** A one-line terminal buffer stub — the provider only reads the line text. */
function terminalWith(lineText: string): Terminal {
  return {
    buffer: { active: { getLine: () => ({ translateToString: () => lineText }) } },
  } as unknown as Terminal;
}

function linksFor(lineText: string): ILink[] {
  const provider = new FilePathLinkProvider('p1', '/repo', terminalWith(lineText));
  let links: ILink[] | undefined;
  provider.provideLinks(1, (result) => { links = result; });
  return links ?? [];
}

// The provider only reads `metaKey`, so a literal keeps this suite DOM-free.
const cmdClick = { metaKey: true } as MouseEvent;
const plainClick = { metaKey: false } as MouseEvent;

describe('FilePathLinkProvider', () => {
  it('routes a cmd+click through the checked opener instead of opening blind', () => {
    const [link] = linksFor('see src/foo/bar.ts:42 for details');
    expect(link.text).toBe('src/foo/bar.ts:42');

    link.activate(cmdClick, link.text);

    // The check is what keeps a dead path from spawning a tab that is torn down
    // a moment later, dropping the user on an unrelated tab.
    expect(openFileReaderChecked).toHaveBeenCalledWith('p1', 'src/foo/bar.ts', 42);
  });

  it('passes no line number when the path carries none', () => {
    const [link] = linksFor('edited src/foo/bar.ts');
    link.activate(cmdClick, link.text);
    expect(openFileReaderChecked).toHaveBeenCalledWith('p1', 'src/foo/bar.ts', undefined);
  });

  it('ignores a plain click', () => {
    const [link] = linksFor('see src/foo/bar.ts');
    link.activate(plainClick, link.text);
    expect(openFileReaderChecked).not.toHaveBeenCalled();
  });

  it('linkifies Windows backslash-separated paths', () => {
    const [link] = linksFor('see src\\foo\\bar.ts for details');
    expect(link.text).toBe('src\\foo\\bar.ts');
    link.activate(cmdClick, link.text);
    expect(openFileReaderChecked).toHaveBeenCalledWith('p1', 'src\\foo\\bar.ts', undefined);
  });

  it('linkifies drive-letter paths with a line suffix', () => {
    const [link] = linksFor('open C:\\Users\\me\\x.ts:42 now');
    expect(link.text).toBe('C:\\Users\\me\\x.ts:42');
    link.activate(cmdClick, link.text);
    // The matched text passes through as-is: resolveProjectFilePath treats a
    // drive path as absolute, so the fs/open IPCs receive the native path
    // unchanged.
    expect(openFileReaderChecked).toHaveBeenCalledWith('p1', 'C:\\Users\\me\\x.ts', 42);
  });

  it('linkifies a file at the drive root', () => {
    const [link] = linksFor('log at C:\\temp.log');
    expect(link.text).toBe('C:\\temp.log');
  });

  it('keeps POSIX slash paths with line suffixes', () => {
    const [link] = linksFor('see src/foo/bar.ts:10-20');
    expect(link.text).toBe('src/foo/bar.ts:10-20');
    link.activate(cmdClick, link.text);
    expect(openFileReaderChecked).toHaveBeenCalledWith('p1', 'src/foo/bar.ts', 10);
  });

  it('leaves separator noise unlinked', () => {
    // No extension segment: the false-positive discipline of the slash path
    // carries over to backslashes.
    expect(linksFor('count 2\\2 done')).toEqual([]);
  });

  it('keeps the pre-existing scope for leading-slash absolute paths', () => {
    // `/a/b/c.ts:7` was outside FILE_PATH_RE before (the leading `/` is not a
    // valid segment start) and stays outside it.
    expect(linksFor('at /a/b/c.ts:7')).toEqual([]);
  });

});
