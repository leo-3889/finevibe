import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { loadScanIgnorePatterns, buildFineVibeIgnoreMatcher } from './finevibeignore';

vi.mock('fs');

const mockFs = vi.mocked(fs);

/** Make readFileSync return `content` for `.finevibeignore`, throw ENOENT otherwise. */
function mockFineVibeIgnore(content: string | null): void {
  mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    if (String(p).endsWith('.finevibeignore') && content !== null) return content;
    throw new Error('ENOENT');
  });
}

/** Make readFileSync return content by filename suffix; ENOENT for anything else. */
function mockIgnoreFiles(files: Record<string, string>): void {
  mockFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
    const name = String(p);
    for (const [suffix, content] of Object.entries(files)) {
      if (name.endsWith(suffix)) return content;
    }
    throw new Error('ENOENT');
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('loadScanIgnorePatterns', () => {
  it('strips comments and blank lines', () => {
    mockFineVibeIgnore('# a comment\n\n*.min.js\n   \n  dist/  \n');
    expect(loadScanIgnorePatterns('/proj')).toEqual(['*.min.js', 'dist/']);
  });

  it('uses built-in patterns when the file is missing', () => {
    mockFineVibeIgnore(null);
    expect(loadScanIgnorePatterns('/proj')).toContain('*.min.js');
  });

  it('returns empty array when the file has only comments/blanks', () => {
    mockFineVibeIgnore('# only comments\n\n   \n');
    expect(loadScanIgnorePatterns('/proj')).toEqual([]);
  });

  it('falls back to the legacy .vibeyardignore when the new file is absent', () => {
    mockIgnoreFiles({ '.vibeyardignore': 'vendor/**\n' });
    expect(loadScanIgnorePatterns('/proj')).toEqual(['vendor/**']);
  });

  it('prefers .finevibeignore when both names exist', () => {
    mockIgnoreFiles({ '.vibeyardignore': 'old/**\n', '.finevibeignore': 'new/**\n' });
    expect(loadScanIgnorePatterns('/proj')).toEqual(['new/**']);
  });
});

describe('buildFineVibeIgnoreMatcher', () => {
  it('matches basename globs', () => {
    mockFineVibeIgnore('*.min.js\n');
    const isIgnored = buildFineVibeIgnoreMatcher('/proj');
    expect(isIgnored('vendor/app.min.js')).toBe(true);
    expect(isIgnored('src/app.ts')).toBe(false);
  });

  it('matches full-path globs', () => {
    mockFineVibeIgnore('src/**/*.generated.ts\n');
    const isIgnored = buildFineVibeIgnoreMatcher('/proj');
    expect(isIgnored('src/api/types.generated.ts')).toBe(true);
    expect(isIgnored('lib/types.generated.ts')).toBe(false);
  });

  it('uses built-in patterns when the file is missing', () => {
    mockFineVibeIgnore(null);
    const isIgnored = buildFineVibeIgnoreMatcher('/proj');
    expect(isIgnored('anything.min.js')).toBe(true);
  });
});
