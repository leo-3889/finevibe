import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { ReadinessCheck } from '../../shared/types';
import { countFileLines, getTrackedFiles, computeCategoryScore, MAX_TRACKED_FILES } from './utils';

// Explicit factory: the automock carries execFile's util.promisify.custom
// symbol, whose closure calls the REAL git — the mocked implementation
// below would never run. Re-attach the custom promisify so the promisified
// call resolves with `{ stdout, stderr }` exactly like the real one.
vi.mock('child_process', () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFile(...args, (err: Error | null, stdout: string, stderr: string) =>
          err ? reject(err) : resolve({ stdout, stderr }));
      });
  return { execFile };
});

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
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      cb(null, stdout, '');
    }) as never);
  }

  it('disables git path quoting so non-ASCII directories stay matchable', async () => {
    mockLsFiles('packages/café/AGENTS.md\n');

    expect(await getTrackedFiles('/repo')).toEqual(['packages/café/AGENTS.md']);
    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[], { maxBuffer: number }];
    expect(cmd).toBe('git');
    expect(args).toContain('core.quotePath=false');
    // C3M-02: the 1 MiB child_process default ENOBUFS'd on huge repos and
    // the catch turned it into a silent [] — the buffer must be generous.
    expect(opts.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  it('dedupes unmerged paths, which git lists once per index stage', async () => {
    mockLsFiles('pkg/AGENTS.md\npkg/AGENTS.md\npkg/AGENTS.md\nREADME.md\n');

    expect(await getTrackedFiles('/repo')).toEqual(['pkg/AGENTS.md', 'README.md']);
  });

  it('returns an empty list outside a git repo', async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
      cb(new Error('not a git repository'), '', '');
    }) as never);

    expect(await getTrackedFiles('/repo')).toEqual([]);
  });

  it('caps the list at MAX_TRACKED_FILES (C3M-02)', async () => {
    mockLsFiles(Array.from({ length: MAX_TRACKED_FILES + 10 }, (_, i) => `f${i}.md`).join('\n'));

    expect(await getTrackedFiles('/repo')).toHaveLength(MAX_TRACKED_FILES);
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
