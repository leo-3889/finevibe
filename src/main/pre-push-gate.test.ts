// Gate spec for .githooks/pre-push (review 2c59c91d: the gate shipped one
// regression green precisely because nothing tested the hook itself).
// Builds throwaway fixture repos and pipes real pre-push ref lines to the hook.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const HOOK = path.join(ROOT, '.githooks', 'pre-push');
const PATTERNS = path.join(ROOT, '.secrets.patterns');
const ALLOWLIST = path.join(ROOT, '.secrets.allowlist');
const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz12';

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-gate-'));
  git(repo, 'init', '-q');
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.copyFileSync(PATTERNS, path.join(repo, '.secrets.patterns'));
  fs.copyFileSync(ALLOWLIST, path.join(repo, '.secrets.allowlist'));
  fs.copyFileSync(HOOK, path.join(repo, '.githooks', 'pre-push'));
  fs.chmodSync(path.join(repo, '.githooks', 'pre-push'), 0o755);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

function push(repo: string, localSha: string, remoteSha: string): number {
  const r = spawnSync('bash', [path.join(repo, '.githooks', 'pre-push')], {
    cwd: repo,
    input: `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`,
    encoding: 'utf8',
  });
  return r.status ?? -1;
}

const ZERO = '0000000000000000000000000000000000000000';
const ZEROS: string[] = [];
let repos: string[] = [];

describe.skipIf(process.platform === 'win32')('pre-push gate (fixture repos)', () => {
  beforeAll(() => {
    repos = ZEROS;
  });
  afterAll(() => {
    for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
  });

  it('new ref: secret anywhere in the published history fires (tip-tree scan, not tip-commit diff)', () => {
    const repo = makeRepo();
    repos.push(repo);
    fs.writeFileSync(path.join(repo, 'leak.txt'), `key = "${SECRET}"\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add secret');
    fs.writeFileSync(path.join(repo, 't.txt'), 'x=1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'trivial tip'); // secret NOT added by the tip commit
    expect(push(repo, git(repo, 'rev-parse', 'HEAD').trim(), ZERO)).toBe(1);
  });

  it('range: secret added mid-range and DELETED before the tip still fires (it is published)', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'leak.txt'), `key = "${SECRET}"\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add secret');
    fs.rmSync(path.join(repo, 'leak.txt'));
    fs.writeFileSync(path.join(repo, 'z.txt'), 'z=1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'delete it');
    expect(push(repo, git(repo, 'rev-parse', 'HEAD').trim(), base)).toBe(1);
  });

  it('range: a scrub commit that only DELETES pattern content does not fire (no --no-verify pressure)', () => {
    const repo = makeRepo();
    repos.push(repo);
    // Ship a fixture (pii-allow-marked) so the base is already public.
    fs.writeFileSync(path.join(repo, 'fx.ts'), "const h = 'leo395max'; // pii-allow\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'fixture');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.rmSync(path.join(repo, 'fx.ts'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'scrub');
    expect(push(repo, git(repo, 'rev-parse', 'HEAD').trim(), base)).toBe(0);
  });

  it('same-push allowlist widening does not exempt the push', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.appendFileSync(path.join(repo, '.secrets.allowlist'), 'leak2.txt\n');
    fs.writeFileSync(path.join(repo, 'leak2.txt'), `key = "${SECRET}"\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'widen + leak');
    expect(push(repo, git(repo, 'rev-parse', 'HEAD').trim(), base)).toBe(1);
  });

  it('clean range passes', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'fine\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'clean');
    expect(push(repo, git(repo, 'rev-parse', 'HEAD').trim(), base)).toBe(0);
  });
});
