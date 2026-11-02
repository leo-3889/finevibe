// Gate spec for .githooks/pre-push (review 2c59c91d: the gate shipped one
// regression green precisely because nothing tested the hook itself).
// Builds throwaway fixture repos and pipes real pre-push ref lines to the hook.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVACY_PATTERNS, formatHits, scanPush, scanText } from './pre-push-gate';

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

function commit(repo: string, file: string, content: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', file);
  return git(repo, 'rev-parse', 'HEAD').trim();
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

// The permanent privacy gate (src/main/pre-push-gate.ts): hard blockers on the
// operator's identity + credential shapes, no exemptions, value never echoed.

// Same 'st'+'rix' concatenation the gate uses: a test that spells the literals
// it blocks flags itself in every pushed range that touches it.
const HOST = 'leo-' + '9950X';
const LAN_IP = '192.16' + '8.2.242';
const HOME = '/hom' + 'e/leo';
const NOREPLY = 'leo-3889@users' + '.noreply.github.com';
const TOKEN = 'ghp_' + 'a'.repeat(30);

function gate(repo: string, localSha: string, remoteSha: string) {
  return scanPush(repo, `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`);
}

describe('pre-push privacy gate (identity + credentials)', () => {
  it('range: identity literal in an added line blocks, and the value is not echoed', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const tip = commit(repo, 'cfg.txt', `host = ${HOST}\n`);
    const hits = gate(repo, tip, base);
    expect(hits.map((h) => h.pattern)).toContain('GIT_IDENTITY_HOST');
    const report = formatHits(hits);
    expect(report).toContain('cfg.txt:1');
    expect(report).toContain('GIT_IDENTITY_HOST');
    expect(report).not.toContain(HOST);
  });

  it('range: lan ip, home path and noreply identity all block', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const tip = commit(repo, 'notes.md', `# ${NOREPLY}\nbox ${LAN_IP} under ${HOME}\n`);
    const report = formatHits(gate(repo, tip, base));
    expect(PRIVACY_PATTERNS.map((p) => p.name)).toEqual([
      'GIT_IDENTITY_HOST',
      'GIT_LAN_IP',
      'GIT_HOME_PATH',
      'GIT_IDENTITY_NOREPLY',
      'GIT_SECRET_TOKEN',
      'GIT_PRIVATE_KEY',
      'GIT_SECRET_TOKEN_GOOGLE',
      'GIT_SECRET_TOKEN_NPM',
      'GIT_SECRET_TOKEN_SLACK',
    ]);
    expect(report).toContain('GIT_LAN_IP');
    expect(report).toContain('GIT_HOME_PATH');
    expect(report).toContain('GIT_IDENTITY_NOREPLY');
    expect(report).not.toContain(LAN_IP);
    expect(report).not.toContain(NOREPLY);
  });

  it('range: clean content passes', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const tip = commit(repo, 'ok.txt', 'host = localhost\nkey = public\n');
    expect(gate(repo, tip, base)).toEqual([]);
  });

  it('range: a ghp_ token blocks with GIT_SECRET_TOKEN, value not echoed', () => {
    const repo = makeRepo();
    repos.push(repo);
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    const tip = commit(repo, 'ci.sh', `export GH=${TOKEN}\n`);
    const hits = gate(repo, tip, base);
    expect(hits.map((h) => h.pattern)).toContain('GIT_SECRET_TOKEN');
    expect(formatHits(hits)).not.toContain(TOKEN);
  });

  it('gate source scanned by its own patterns finds nothing (self-clean)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'pre-push-gate.ts'), 'utf8');
    expect(scanText(source)).toEqual([]);
    // the spec is in the same pushed range, so it has to be clean too
    expect(scanText(fs.readFileSync(path.join(__dirname, 'pre-push-gate.test.ts'), 'utf8'))).toEqual([]);
  });

  it('new ref: tip-TREE scan catches the literal in a file the tip commit never touched', () => {
    const repo = makeRepo();
    repos.push(repo);
    commit(repo, 'leak.txt', `host=${HOST}\n`);
    const tip = commit(repo, 't.txt', 'x=1\n'); // leak.txt is unchanged here
    const hits = gate(repo, tip, ZERO);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'leak.txt', line: 1, pattern: 'GIT_IDENTITY_HOST' });
    expect(hits[0].rev).toBe(tip.slice(0, 7));
    expect(formatHits(hits)).not.toContain(HOST);
  });
});
