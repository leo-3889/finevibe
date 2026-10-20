import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as mainPlatform from '../../../main/platform';

// Renderer platform: getter pattern from file-url.test.ts / terminal-utils.test.ts.
// sanitizeArgPrompt reads `isWin` at call time, so tests toggle the branch in-process.
const mocks = vi.hoisted(() => ({
  rendererIsWin: true,
  mainIsWin: true,
  mockSpawn: vi.fn(),
}));

vi.mock('../../platform.js', () => ({
  get isMac() { return false; },
  get isWin() { return mocks.rendererIsWin; },
  get isLinux() { return !mocks.rendererIsWin; },
}));

// Main-process platform: keep the real exports (pathSep, pythonBin, ...) and
// force `isWin` so pty-manager's cmd.exe quoting runs on every OS —
// pty-manager.test.ts can only gate its cmd.exe tests behind the real isWin.
vi.mock('../../../main/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof mainPlatform>()),
  get isWin() { return mocks.mainIsWin; },
}));

// Same module-load stubs pty-manager.test.ts uses to keep node-pty,
// child_process, fs and nvm out of the import graph.
vi.mock('node-pty', () => ({ default: { spawn: mocks.mockSpawn }, spawn: mocks.mockSpawn }));
vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn(),
}));
vi.mock('os', () => ({ homedir: () => '/mock/home', tmpdir: () => '/tmp' }));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => { throw new Error('ENOENT'); }),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  readdirSync: vi.fn(() => { throw new Error('ENOENT'); }),
}));
vi.mock('../../../main/providers/nvm', () => ({
  nvmDefaultNodeBinDir: vi.fn(() => null),
  findBinaryInNvm: vi.fn(() => null),
}));

import { sanitizeArgPrompt } from './prompt-utils.js';
import { resolveWindowsShell } from '../../../main/pty-manager.js';

const CLAUDE_CMD = 'C:\\tools\\claude.cmd';

describe('sanitizeArgPrompt', () => {
  beforeEach(() => {
    mocks.rendererIsWin = true;
    mocks.mainIsWin = true;
  });

  describe('on Windows', () => {
    it('replaces double quotes with single quotes', () => {
      expect(sanitizeArgPrompt('click the [data-x="submit"] button'))
        .toBe("click the [data-x='submit'] button");
    });

    it('produces an argument quoteArgForCmdExe accepts', () => {
      const prompt = sanitizeArgPrompt('focus [id="x"] run&calc.exe');
      const r = resolveWindowsShell(CLAUDE_CMD, [prompt]);
      expect(r.shell).toBe('cmd.exe');
      expect(r.args[0]).toBe('/c');
      expect(r.args[1]).toBe(CLAUDE_CMD);
      expect(r.args[2]).toBe(`"focus [id='x'] run&calc.exe"`);
    });

    it('kills the spawn when the raw quote-bearing prompt skips sanitizing', () => {
      expect(() => resolveWindowsShell(CLAUDE_CMD, ['focus [id="x"] run&calc.exe']))
        .toThrow(/double quote/);
    });

    it('flattens LF and CRLF to " | " so every line survives the /c line', () => {
      expect(sanitizeArgPrompt('summarize\nsecond line\r\nthird'))
        .toBe('summarize | second line | third');
      const r = resolveWindowsShell(CLAUDE_CMD, [sanitizeArgPrompt('a\nb\r\nc')]);
      expect(r.args[2]).toBe('"a | b | c"');
    });

    it('leaves text without quotes or newlines byte-identical', () => {
      const prompt = sanitizeArgPrompt('summarize the page');
      expect(prompt).toBe('summarize the page');
      const r = resolveWindowsShell(CLAUDE_CMD, [prompt]);
      expect(r.args[2]).toBe('summarize the page');
    });
  });

  describe('off Windows', () => {
    beforeEach(() => {
      mocks.rendererIsWin = false;
      mocks.mainIsWin = false;
    });

    it('leaves quotes and newlines intact for POSIX argv', () => {
      const raw = 'click [data-x="submit"]\nthen report';
      expect(sanitizeArgPrompt(raw)).toBe(raw);
      expect(resolveWindowsShell('/usr/local/bin/claude', [raw]))
        .toEqual({ shell: '/usr/local/bin/claude', args: [raw] });
    });
  });

  it('sanitizes on the Windows branch only', () => {
    const raw = 'a"b\nc';
    mocks.rendererIsWin = true;
    expect(sanitizeArgPrompt(raw)).toBe("a'b | c");
    mocks.rendererIsWin = false;
    expect(sanitizeArgPrompt(raw)).toBe(raw);
  });
});
