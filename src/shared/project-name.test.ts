import { describe, it, expect } from 'vitest';
import { deriveProjectName } from './project-name';

describe('deriveProjectName', () => {
  it('extracts the basename from POSIX paths', () => {
    expect(deriveProjectName('/Users/me/dev/finevibe')).toBe('finevibe');
  });

  it('extracts the basename from Windows paths', () => {
    expect(deriveProjectName('C:\\Users\\lauferism\\git\\finevibe')).toBe('finevibe');
  });

  it('strips trailing separators', () => {
    expect(deriveProjectName('/Users/me/dev/finevibe/')).toBe('finevibe');
    expect(deriveProjectName('C:\\Users\\me\\finevibe\\')).toBe('finevibe');
  });

  it('returns the fallback when cwd is empty', () => {
    expect(deriveProjectName('', 'my-slug')).toBe('my-slug');
  });

  it('returns the fallback when cwd has no basename', () => {
    expect(deriveProjectName('/', 'my-slug')).toBe('my-slug');
  });

  it('defaults to an empty string when no fallback is supplied', () => {
    expect(deriveProjectName('')).toBe('');
    expect(deriveProjectName('/')).toBe('');
  });
});
