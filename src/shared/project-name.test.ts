import { describe, it, expect } from 'vitest';
import { deriveProjectName } from './project-name';

describe('deriveProjectName', () => {
  it('extracts the basename from POSIX paths', () => {
    expect(deriveProjectName('/Users/me/dev/vibeyard')).toBe('vibeyard');
  });

  it('extracts the basename from Windows paths', () => {
    expect(deriveProjectName('C:\\Users\\lauferism\\git\\vibeyard')).toBe('vibeyard');
  });

  it('strips trailing separators', () => {
    expect(deriveProjectName('/Users/me/dev/vibeyard/')).toBe('vibeyard');
    expect(deriveProjectName('C:\\Users\\me\\vibeyard\\')).toBe('vibeyard');
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
