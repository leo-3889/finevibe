import { describe, expect, it } from 'vitest';
import { joinChildPath } from './path-join.js';

// The renderer joins strings for paths it only ever sees as text: the Add-
// project modal's `<default projects folder>/<name>` sync and its clone
// target. A hardcoded '/' produced `E:\AI/Brillance` on Windows and main
// persisted the mixed spelling verbatim, so the separator style is the whole
// contract — plus the drive-root trap where `E:` + `AI` = `E:AI` means
// cwd-relative, not `E:\AI`.

describe('joinChildPath Windows spellings', () => {
  it('separates a bare drive root (E: + AI is never E:AI)', () => {
    expect(joinChildPath('E:', 'AI')).toBe('E:\\AI');
  });

  it('keeps one separator under a drive root with its own separator', () => {
    expect(joinChildPath('E:\\', 'AI')).toBe('E:\\AI');
  });

  it('joins with a backslash under a drive folder', () => {
    expect(joinChildPath('E:\\AI', 'Brillance')).toBe('E:\\AI\\Brillance');
    expect(joinChildPath('E:\\AI\\', 'Brillance')).toBe('E:\\AI\\Brillance');
  });

  it('keeps the drive style when the parent mixes separators', () => {
    expect(joinChildPath('E:\\AI/proj', 'x')).toBe('E:\\AI/proj\\x');
  });

  it('joins with a backslash under a UNC share', () => {
    expect(joinChildPath('\\\\srv\\share', 'x')).toBe('\\\\srv\\share\\x');
    expect(joinChildPath('\\\\srv\\share\\', 'x')).toBe('\\\\srv\\share\\x');
  });

  it('does not double the separator when the child brings its own', () => {
    expect(joinChildPath('E:\\AI', '\\Brillance')).toBe('E:\\AI\\Brillance');
    expect(joinChildPath('E:\\AI', '/Brillance')).toBe('E:\\AI\\Brillance');
  });
});

describe('joinChildPath POSIX spellings', () => {
  it('keeps a bare root a single separator', () => {
    expect(joinChildPath('/', 'x')).toBe('/x');
    expect(joinChildPath('//', 'x')).toBe('/x');
  });

  it('joins with a slash under a POSIX folder', () => {
    expect(joinChildPath('/home/u', 'x')).toBe('/home/u/x');
    expect(joinChildPath('/home/u/', 'x')).toBe('/home/u/x');
  });

  it('follows the parent for a relative path, defaulting to slash', () => {
    expect(joinChildPath('projects/app', 'x')).toBe('projects/app/x');
    expect(joinChildPath('projects', 'x')).toBe('projects/x');
  });

  it('does not double the separator when the child brings its own', () => {
    expect(joinChildPath('/home/u', '/x')).toBe('/home/u/x');
  });
});

describe('joinChildPath blank inputs', () => {
  it('returns the child for a blank parent', () => {
    expect(joinChildPath('', '/home/u/x')).toBe('/home/u/x');
    expect(joinChildPath('   ', 'x')).toBe('x');
  });

  it('returns the trimmed parent for a blank child', () => {
    expect(joinChildPath('/home/u/projects/', '')).toBe('/home/u/projects/');
    expect(joinChildPath('  /home/u/projects  ', '   ')).toBe('/home/u/projects');
  });

  it('trims whitespace around the child segment', () => {
    expect(joinChildPath('/home/u', '  x  ')).toBe('/home/u/x');
  });
});
