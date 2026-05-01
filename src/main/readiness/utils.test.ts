import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countFileLines } from './utils';

describe('countFileLines', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-file-lines-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTmp(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('counts lines without trailing newline', () => {
    const p = writeTmp('no-trailing.txt', 'a\nb\nc');
    expect(countFileLines(p)).toBe(3);
  });

  it('counts lines with trailing newline (current behavior over-counts by 1)', () => {
    const p = writeTmp('trailing.txt', 'a\nb\nc\n');
    expect(countFileLines(p)).toBe(4);
  });

  it('returns 0 for empty file', () => {
    const p = writeTmp('empty.txt', '');
    expect(countFileLines(p)).toBe(0);
  });

  it('returns full count when under maxLines cutoff', () => {
    const p = writeTmp('small.txt', Array(100).fill('line').join('\n'));
    expect(countFileLines(p, 500)).toBe(100);
  });

  it('stops at maxLines + 1 for files larger than the cutoff', () => {
    const p = writeTmp('huge.txt', Array(10000).fill('line').join('\n'));
    expect(countFileLines(p, 500)).toBe(501);
  });

  it('returns exact count when file lands on the cutoff boundary', () => {
    const p = writeTmp('exact.txt', Array(500).fill('line').join('\n'));
    expect(countFileLines(p, 500)).toBe(500);
  });
});
