import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGitFiles, getGitDiff, checkoutGitBranch, createGitBranch } from './git-status';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Real temporary-repository tests. These intentionally do NOT mock
// child_process or fs so that Git's own -z porcelain output (raw, unquoted
// path bytes) is exercised end to end, including non-ASCII filenames that
// Git C-quotes in non -z mode.
describe('getGitFiles (real repository)', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-status-real-'));
    await git(repoDir, ['init', '-q']);
    await git(repoDir, ['config', 'core.quotePath', 'true']);
    await git(repoDir, ['config', 'user.email', 'test@example.com']);
    await git(repoDir, ['config', 'user.name', 'Test']);
  });

  afterEach(async () => {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
  });

  it('decodes a non-ASCII untracked filename and reads its diff', async () => {
    fs.writeFileSync(path.join(repoDir, 'café.txt'), 'cafe content\n');
    const files = await getGitFiles(repoDir);
    expect(files).toContainEqual({ path: 'café.txt', status: 'untracked', area: 'untracked' });
    const diff = await getGitDiff(repoDir, 'café.txt', 'untracked');
    expect(diff).toContain('cafe content');
    expect(diff).not.toContain('(unable to read file)');
  });

  it('round-trips a staged rename from status to diff', async () => {
    fs.writeFileSync(path.join(repoDir, 'a b.txt'), 'hello\n');
    await git(repoDir, ['add', 'a b.txt']);
    await git(repoDir, ['commit', '-qm', 'init']);
    await git(repoDir, ['mv', 'a b.txt', 'c d.txt']);
    const files = await getGitFiles(repoDir);
    expect(files).toContainEqual({ path: 'c d.txt', status: 'renamed', area: 'staged' });
    const diff = await getGitDiff(repoDir, 'c d.txt', 'staged');
    expect(diff).toContain('c d.txt');
    expect(diff).not.toContain('(no diff available)');
  });
});

// Real git, because the gate delegates the ref rules to git itself: a mock
// proves the argv shape, only the real binary proves `check-ref-format
// --branch` accepts the names the panel offers and rejects the rest.
describe('branch checkout (real repository)', () => {
  let repoDir: string;
  const head = () => git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim());

  beforeEach(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-real-'));
    await git(repoDir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'committed\n');
    await git(repoDir, ['add', 'a.txt']);
    await git(repoDir, ['commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
  });

  it('creates a real branch and checks it back out', async () => {
    await createGitBranch(repoDir, 'feature/x');
    expect(await head()).toBe('feature/x');

    await checkoutGitBranch(repoDir, 'main');
    expect(await head()).toBe('main');

    await checkoutGitBranch(repoDir, 'feature/x');
    expect(await head()).toBe('feature/x');
  });

  it('refuses a checkout flag and leaves the working tree alone', async () => {
    // The whole point of the gate: `git checkout -f` force-discards, so a
    // renderer-sent '-f' must never reach git - and must not touch the file.
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'uncommitted work\n');

    await expect(checkoutGitBranch(repoDir, '-f')).rejects.toThrow(/Invalid branch name/);
    expect(fs.readFileSync(path.join(repoDir, 'a.txt'), 'utf-8')).toBe('uncommitted work\n');
    expect(await head()).toBe('main');
  });

  it('refuses a ref git itself refuses', async () => {
    await expect(createGitBranch(repoDir, 'feature..x')).rejects.toThrow(/Invalid branch name/);
    expect(await head()).toBe('main');
  });
});
