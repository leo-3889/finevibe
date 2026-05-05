import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { mockInstructionFiles } from './test-utils';

vi.mock('fs');

const mockFs = vi.mocked(fs);

describe('mockInstructionFiles', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('stubs statSync and readFileSync for matching instruction files', () => {
    mockInstructionFiles(mockFs, {
      'AGENTS.md': 'agents content',
      'nested/CLAUDE.md': 'claude content',
    });

    const agentsStats = mockFs.statSync('/tmp/project/AGENTS.md');
    const claudeStats = mockFs.statSync('/tmp/project/nested/CLAUDE.md');

    expect(agentsStats.isFile()).toBe(true);
    expect(agentsStats.isDirectory()).toBe(false);
    expect(claudeStats.isFile()).toBe(true);
    expect(mockFs.readFileSync('/tmp/project/AGENTS.md', 'utf-8')).toBe('agents content');
    expect(mockFs.readFileSync('/tmp/project/nested/CLAUDE.md', 'utf-8')).toBe('claude content');
    expect(() => mockFs.statSync('/tmp/project/GEMINI.md')).toThrow('ENOENT');
    expect(() => mockFs.readFileSync('/tmp/project/GEMINI.md', 'utf-8')).toThrow('ENOENT');
  });
});