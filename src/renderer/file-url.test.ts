import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: { isMac: false, isWin: false, isLinux: true },
}));

vi.mock('./platform.js', () => ({
  get isMac() { return mockPlatform.isMac; },
  get isWin() { return mockPlatform.isWin; },
  get isLinux() { return mockPlatform.isLinux; },
}));

import { pathToFileURL } from './file-url.js';

describe('pathToFileURL', () => {
  beforeEach(() => {
    mockPlatform.isMac = false;
    mockPlatform.isWin = false;
    mockPlatform.isLinux = true;
  });

  describe('on macOS/Linux', () => {
    it('converts a plain absolute path', () => {
      expect(pathToFileURL('/Users/foo/index.html')).toBe('file:///Users/foo/index.html');
    });

    it('encodes spaces in segments', () => {
      expect(pathToFileURL('/Users/foo/has space.html')).toBe('file:///Users/foo/has%20space.html');
    });

    it('encodes characters that would otherwise be parsed as URL fragments or queries', () => {
      expect(pathToFileURL('/Users/foo/odd#name?.html'))
        .toBe('file:///Users/foo/odd%23name%3F.html');
    });

    it('does not encode forward slashes', () => {
      const url = pathToFileURL('/a/b/c/file.txt');
      expect(url).toBe('file:///a/b/c/file.txt');
      expect(url).not.toContain('%2F');
    });

    it('encodes literal percent signs in filenames', () => {
      expect(pathToFileURL('/tmp/100%off.html')).toBe('file:///tmp/100%25off.html');
    });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      mockPlatform.isWin = true;
      mockPlatform.isMac = false;
      mockPlatform.isLinux = false;
    });

    it('converts a path with a drive letter and backslashes', () => {
      expect(pathToFileURL('C:\\Users\\foo\\index.html'))
        .toBe('file:///C:/Users/foo/index.html');
    });

    it('preserves the drive-letter colon (does not encode it)', () => {
      const url = pathToFileURL('D:\\projects\\app.html');
      expect(url).toBe('file:///D:/projects/app.html');
      expect(url).not.toContain('%3A');
    });

    it('encodes spaces in Windows paths', () => {
      expect(pathToFileURL('C:\\Users\\my user\\page.html'))
        .toBe('file:///C:/Users/my%20user/page.html');
    });

    it('handles forward-slash Windows paths too', () => {
      expect(pathToFileURL('C:/Users/foo/index.html'))
        .toBe('file:///C:/Users/foo/index.html');
    });
  });
});
