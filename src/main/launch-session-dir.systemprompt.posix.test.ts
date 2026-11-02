import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('./platform', () => ({ isWin: false, whichCmd: 'which' }));
const userData = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => userData.path } }));

import { systemPromptArg } from './launch-session-dir';

/**
 * POSIX/remote lane of the audit-108 guard (the Windows lane is pinned in
 * launch-session-dir.systemprompt.test.ts): the newline prefix flips the
 * Pi-family CLIs into literal-text mode, and NO prompt ever writes a file
 * here — no session dir is touched on any path.
 */
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-sysprompt-posix-'));
  userData.path = dir;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('systemPromptArg (POSIX guard lane)', () => {
  it('prefixes a one-line prompt that spells an existing file, writing nothing', () => {
    const file = path.join(dir, 'cmo-persona.md');
    fs.writeFileSync(file, 'You are the CMO.', 'utf8');
    const out = path.join(dir, 'guard');
    expect(systemPromptArg(file, out)).toBe(`\n${file}`);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('remote launches stay inline with the guard applied (a host-only path stats as missing locally)', () => {
    const hostPath = '/home/dev/personas/cmo.md';
    fs.writeFileSync(path.join(dir, 'cmo.md'), 'x', 'utf8');
    // The stat is LOCAL by contract (provider-contracts.md): a host-spelled
    // path is unmatched here — the remote CLI's own substitution is the
    // documented remote ceiling, charters must not spell host paths.
    expect(systemPromptArg(hostPath, path.join(dir, 'guard-remote'), true)).toBe(hostPath);
  });
});
