import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Windows spawns an npm-installed CLI through cmd.exe, which has no escape
 * for a literal `"` — so a team member's system prompt containing a quote is
 * handed to the Pi-compatible CLIs as a FILE (`--append-system-prompt` reads
 * file contents). This file pins that gate: file only for Windows + quote +
 * local launch; inline otherwise.
 */
vi.mock('./platform', () => ({ isWin: true, whichCmd: 'where' }));

const userData = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
}));

import { systemPromptArg } from './launch-session-dir';

const QUOTED = 'You are the "CMO". Reply in 3 lines.';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-sysprompt-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('systemPromptArg (Windows cmd.exe quote gate)', () => {
  it('routes a quote-bearing prompt through a file in the launch session dir', () => {
    const file = systemPromptArg(QUOTED, dir);
    expect(file).toBe(path.join(dir, 'system-prompt.md'));
    expect(fs.readFileSync(file, 'utf8')).toBe(QUOTED);
  });

  it('creates the session dir when the launch has not pre-created it', () => {
    const fresh = path.join(dir, 'nested', 'session');
    expect(fs.existsSync(fresh)).toBe(false);
    systemPromptArg(QUOTED, fresh);
    expect(fs.existsSync(path.join(fresh, 'system-prompt.md'))).toBe(true);
  });

  it('keeps a quote-free prompt inline (unchanged argv, no file)', () => {
    const out = path.join(dir, 'inline');
    expect(systemPromptArg('You are the CMO.', out)).toBe('You are the CMO.');
    expect(fs.existsSync(out)).toBe(false);
  });

  it('keeps a quoted prompt inline for a remote launch — the host cannot read a local path', () => {
    const out = path.join(dir, 'remote');
    expect(systemPromptArg(QUOTED, out, true)).toBe(QUOTED);
    expect(fs.existsSync(out)).toBe(false);
  });
});
