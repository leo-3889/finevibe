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

/**
 * Audit 108 — the Pi/Pi-Bolt/OMP `--append-system-prompt` value is "text OR
 * FILE CONTENTS": a one-line prompt that spells an existing file is replaced
 * by that file's contents (verified live on omp/18.15.0 — see the guard's
 * comment). On POSIX the prefix flips the CLI into text mode
 * (`launch-session-dir.systemprompt.posix.test.ts`); on Windows the newline
 * trick is the byte the `cmd.exe /c` fallback truncates at, so the file
 * branch takes the case — and everything else must reach the CLI
 * byte-identical.
 */
describe('systemPromptArg (audit 108 path-spelling guard)', () => {
  it('routes a one-line prompt that spells an existing file into the session-dir file (Windows: cmd.exe truncates the newline trick)', () => {
    const file = path.join(dir, 'cmo-persona.md');
    fs.writeFileSync(file, 'You are the CMO.', 'utf8');
    const out = path.join(dir, 'guard');
    const written = systemPromptArg(file, out);
    expect(written).toBe(path.join(out, 'system-prompt.md'));
    expect(fs.readFileSync(written, 'utf8')).toBe(file);
  });

  it('leaves a prompt spelling a missing path byte-identical', () => {
    const missing = path.join(dir, 'no-such-persona.md');
    expect(systemPromptArg(missing, path.join(dir, 'guard'))).toBe(missing);
  });

  it('leaves a prompt spelling a directory byte-identical (files are what expand)', () => {
    const sub = path.join(dir, 'guard-dir');
    fs.mkdirSync(sub, { recursive: true });
    expect(systemPromptArg(sub, path.join(dir, 'guard'))).toBe(sub);
  });

  it('leaves a multi-line prompt byte-identical (newline already means text)', () => {
    const multi = `You are the CMO.
Reply in 3 lines.`;
    expect(systemPromptArg(multi, path.join(dir, 'guard'))).toBe(multi);
  });

  it('writes the Windows file branch verbatim — file contents are never re-resolved', () => {
    const persona = path.join(dir, 'spelled-file.md');
    fs.writeFileSync(persona, 'You are the CMO.', 'utf8');
    const prompt = `Load ${persona} — you are the "CMO".`;
    const out = path.join(dir, 'guard-win');
    const written = systemPromptArg(prompt, out);
    expect(written).toBe(path.join(out, 'system-prompt.md'));
    expect(fs.readFileSync(written, 'utf8')).toBe(prompt);
  });
});
