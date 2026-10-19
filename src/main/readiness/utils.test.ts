import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReadinessCheck } from '../../shared/types';
import { countFileLines, getTrackedFiles, computeCategoryScore } from './utils';

vi.mock('child_process');

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

describe('getTrackedFiles', () => {
  function mockLsFiles(stdout: string): void {
    vi.mocked(execSync).mockReturnValue(stdout as unknown as Buffer);
  }

  it('disables git path quoting so non-ASCII directories stay matchable', () => {
    mockLsFiles('packages/café/AGENTS.md\n');

    expect(getTrackedFiles('/repo')).toEqual(['packages/café/AGENTS.md']);
    expect(vi.mocked(execSync).mock.calls[0][0]).toContain('core.quotePath=false');
  });

  it('dedupes unmerged paths, which git lists once per index stage', () => {
    mockLsFiles('pkg/AGENTS.md\npkg/AGENTS.md\npkg/AGENTS.md\nREADME.md\n');

    expect(getTrackedFiles('/repo')).toEqual(['pkg/AGENTS.md', 'README.md']);
  });

  it('returns an empty list outside a git repo', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not a git repository'); });

    expect(getTrackedFiles('/repo')).toEqual([]);
  });
});

/** Minimal scored row; tests override only the fields computeCategoryScore reads. */
function check(over: Partial<ReadinessCheck>): ReadinessCheck {
  return { id: 'c', name: 'c', status: 'pass', description: '', score: 0, maxScore: 100, ...over };
}

describe('computeCategoryScore', () => {
  it('returns 0 for an empty category', () => {
    expect(computeCategoryScore([])).toBe(0);
  });

  it('averages weighted scores and rounds to the nearest integer', () => {
    expect(computeCategoryScore([check({ score: 1, maxScore: 3 })])).toBe(33);
    expect(computeCategoryScore([check({ score: 2, maxScore: 3 })])).toBe(67);
    expect(computeCategoryScore([check({ score: 100 }), check({ score: 80 })])).toBe(90);
  });

  it('excludes informational rows from numerator and denominator', () => {
    // A failing informational row must not drag a fully passing category down:
    // if it were counted, (100 + 0) / (100 + 100) would score 50.
    const checks = [check({ score: 100 }), check({ score: 0, informational: true })];
    expect(computeCategoryScore(checks)).toBe(100);
  });

  it('returns 0 when every row is informational, not NaN', () => {
    // Guarding the divide-by-zero the analyzer would surface as a NaN category score.
    expect(computeCategoryScore([check({ score: 100, informational: true })])).toBe(0);
  });
});
