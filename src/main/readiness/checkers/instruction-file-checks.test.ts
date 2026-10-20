import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  checkFileExists,
  checkFileSize,
  checkNestedFileSizes,
  checkNotBloated,
  resolveInstructionFilePath,
  runAllInstructionChecks,
  SIZE_WARN_LINES,
  SIZE_FAIL_LINES,
  type InstructionFileOpts,
} from './instruction-file-checks';
import { claudeInstructionFileOpts } from './ai-instructions';
import { linesOf, makeAnalysisContext, mockInstructionFiles } from '../test-utils';

vi.mock('fs');

const mockFs = vi.mocked(fs);
const opts = claudeInstructionFileOpts;

/** Permission-denied error, the shape Node's fs callsites throw (code, not message). */
function eacces(): Error & { code: string } {
  return Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('checkFileSize size verdicts at the thresholds', () => {
  it('classifies a 0-byte file as missing, not too short', () => {
    const check = checkFileSize('', opts);
    expect(check.status).toBe('fail');
    expect(check.score).toBe(0);
    expect(check.description).toBe('CLAUDE.md missing.');
  });

  it('fails at 9 lines and warns at 10', () => {
    const fail = checkFileSize(linesOf(9), opts);
    expect(fail.status).toBe('fail');
    expect(fail.score).toBe(0);
    expect(fail.description).toBe('CLAUDE.md is only 9 lines — too short to be useful.');

    const warn = checkFileSize(linesOf(10), opts);
    expect(warn.status).toBe('warning');
    expect(warn.score).toBe(50);
    expect(warn.description).toBe('CLAUDE.md is only 10 lines — consider adding more detail.');
  });

  it('warns at 49 lines and passes at 50', () => {
    expect(checkFileSize(linesOf(49), opts).status).toBe('warning');

    const pass = checkFileSize(linesOf(50), opts);
    expect(pass.status).toBe('pass');
    expect(pass.score).toBe(100);
    expect(pass.description).toBe('CLAUDE.md is 50 lines — good size.');
  });

  it('passes at SIZE_WARN_LINES and warns one line past it', () => {
    const at = checkFileSize(linesOf(SIZE_WARN_LINES), opts);
    expect(at.status).toBe('pass');
    expect(at.description).toBe(`CLAUDE.md is ${SIZE_WARN_LINES} lines — good size.`);

    const past = checkFileSize(linesOf(SIZE_WARN_LINES + 1), opts);
    expect(past.status).toBe('warning');
    expect(past.score).toBe(50);
    expect(past.description).toBe(`CLAUDE.md is ${SIZE_WARN_LINES + 1} lines — consider trimming for focus.`);
    expect(past.fixPrompt).toBeTruthy();
  });

  it('warns at SIZE_FAIL_LINES and fails one line past it', () => {
    const at = checkFileSize(linesOf(SIZE_FAIL_LINES), opts);
    expect(at.status).toBe('warning');
    expect(at.score).toBe(50);

    const past = checkFileSize(linesOf(SIZE_FAIL_LINES + 1), opts);
    expect(past.status).toBe('fail');
    expect(past.score).toBe(0);
    expect(past.description).toBe(`CLAUDE.md is ${SIZE_FAIL_LINES + 1} lines — too long, may waste context window.`);
  });
});

describe('checkNotBloated', () => {
  it('passes when no instruction file exists', () => {
    mockFs.statSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const check = checkNotBloated('/test/project', opts);
    expect(check.status).toBe('pass');
    expect(check.score).toBe(100);
    expect(check.description).toBe('No CLAUDE.md to check for bloat (checked in instructions).');
  });

  it('passes at SIZE_WARN_LINES and warns one line past it', () => {
    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(SIZE_WARN_LINES) });
    expect(checkNotBloated('/test/project', opts).status).toBe('pass');

    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(SIZE_WARN_LINES + 1) });
    const past = checkNotBloated('/test/project', opts);
    expect(past.status).toBe('warning');
    expect(past.score).toBe(50);
    expect(past.description).toBe(`CLAUDE.md is ${SIZE_WARN_LINES + 1} lines — getting large.`);
  });

  it('warns at SIZE_FAIL_LINES and fails one line past it', () => {
    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(SIZE_FAIL_LINES) });
    expect(checkNotBloated('/test/project', opts).status).toBe('warning');

    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(SIZE_FAIL_LINES + 1) });
    const past = checkNotBloated('/test/project', opts);
    expect(past.status).toBe('fail');
    expect(past.score).toBe(0);
    expect(past.fixPrompt).toBeTruthy();
  });

  it('treats a permission-denied file as absent, not bloated', () => {
    // statSync says the file is there; the read is refused. The bloat row must not
    // fail a file it cannot measure — the panel says "nothing to check", not "bloated".
    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(600) });
    vi.mocked(mockFs.readFileSync).mockImplementation(() => {
      throw eacces();
    });

    const check = checkNotBloated('/test/project', opts);
    expect(check.status).toBe('pass');
    expect(check.description).toBe('No CLAUDE.md to check for bloat (checked in instructions).');
  });
});

describe('instruction file resolution under permission denial', () => {
  it('treats a permission-denied stat as missing', () => {
    mockFs.statSync.mockImplementation(() => {
      throw eacces();
    });

    expect(resolveInstructionFilePath('/test/project', opts)).toBeNull();

    const check = checkFileExists('/test/project', opts);
    expect(check.status).toBe('fail');
    expect(check.score).toBe(0);
    expect(check.fixPrompt).toBeTruthy();
  });

  it('resolves the fallback directory with the platform separator', () => {
    mockInstructionFiles(mockFs, { [path.join('.claude', 'CLAUDE.md')]: 'x' });

    expect(resolveInstructionFilePath('/test/project', opts))
      .toBe(path.join('/test/project', '.claude', 'CLAUDE.md'));
  });
});

describe('checkNestedFileSizes thresholds and resilience', () => {
  const agentsOpts: InstructionFileOpts = { fileName: 'AGENTS.md', idPrefix: 'agents-md', displayName: 'AGENTS.md' };
  const NESTED = 'packages/api/AGENTS.md';
  const NESTED_KEY = path.join('packages', 'api', 'AGENTS.md');

  function nested(tracked: string[]) {
    return checkNestedFileSizes('/test/project', makeAnalysisContext(tracked), agentsOpts);
  }

  it('stays silent at SIZE_WARN_LINES and warns one line past it', () => {
    mockInstructionFiles(mockFs, { [NESTED_KEY]: linesOf(SIZE_WARN_LINES) });
    expect(nested([NESTED])).toHaveLength(0);

    mockInstructionFiles(mockFs, { [NESTED_KEY]: linesOf(SIZE_WARN_LINES + 1) });
    const rows = nested([NESTED]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('warning');
    expect(rows[0].description).toBe(`${NESTED} is ${SIZE_WARN_LINES + 1} lines — consider trimming for focus.`);
  });

  it('warns at SIZE_FAIL_LINES and fails one line past it', () => {
    mockInstructionFiles(mockFs, { [NESTED_KEY]: linesOf(SIZE_FAIL_LINES) });
    expect(nested([NESTED])[0].status).toBe('warning');

    mockInstructionFiles(mockFs, { [NESTED_KEY]: linesOf(SIZE_FAIL_LINES + 1) });
    const rows = nested([NESTED]);
    expect(rows[0].status).toBe('fail');
    expect(rows[0].description).toBe(`${NESTED} is ${SIZE_FAIL_LINES + 1} lines — too long, may waste context window.`);
  });

  it('skips a tracked file it cannot open and keeps scanning', () => {
    // git listed both files; by scan time one is permission-denied. The readable
    // oversized sibling must still be reported — the skip is per file, not per scan.
    const GONE = 'packages/gone/AGENTS.md';
    const GONE_KEY = path.join('packages', 'gone', 'AGENTS.md');
    mockInstructionFiles(mockFs, {
      [GONE_KEY]: linesOf(700),
      [NESTED_KEY]: linesOf(700),
    });
    const baseOpen = vi.mocked(mockFs.openSync).getMockImplementation()!;
    vi.mocked(mockFs.openSync).mockImplementation(((filePath: fs.PathLike) => {
      if (String(filePath).endsWith(GONE_KEY)) throw eacces();
      return baseOpen(filePath);
    }) as typeof fs.openSync);

    const rows = nested([GONE, NESTED]);

    expect(rows.map(r => r.id)).toEqual([`agents-md-size:${NESTED}`]);
  });
});

describe('runAllInstructionChecks with an unreadable instruction file', () => {
  it('reports the file as existing while every content check reports it missing', () => {
    // The exists check stats, the content checks read. When the read is denied the
    // panel must show exactly that split — exists: pass, content rows: "missing".
    mockInstructionFiles(mockFs, { 'CLAUDE.md': linesOf(100) });
    vi.mocked(mockFs.readFileSync).mockImplementation(() => {
      throw eacces();
    });

    const checks = runAllInstructionChecks('/test/project', opts, makeAnalysisContext());
    const byId = new Map(checks.map(c => [c.id, c]));

    expect(checks).toHaveLength(5);
    expect(byId.get('claude-md-exists')!.status).toBe('pass');
    for (const id of ['claude-md-build', 'claude-md-test', 'claude-md-architecture', 'claude-md-size']) {
      expect(byId.get(id)!.status).toBe('fail');
    }
    expect(byId.get('claude-md-size')!.description).toBe('CLAUDE.md missing.');
  });
});
