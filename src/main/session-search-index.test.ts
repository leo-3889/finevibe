import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
const location = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => location.dir } }));
import { readSearchIndex, writeSearchIndex, pruneSearchIndex } from './session-search-index';

beforeEach(async () => { location.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finevibe-index-')); });
afterEach(async () => { await fs.rm(location.dir, { recursive: true, force: true }); });

it('reuses a persisted index only for the matching source version', async () => {
  const record = { text: 'saved body', cwd: '/repo', mtime: 1, size: 5, ctime: 2 };
  await writeSearchIndex('claude', '/transcript', record);
  expect(await readSearchIndex('claude', '/transcript', record)).toEqual(record);
  expect(await readSearchIndex('claude', '/transcript', { ...record, size: 6 })).toBeNull();
  expect(await readSearchIndex('claude', '/transcript', { ...record, ctime: 3 })).toBeNull();
  expect(await readSearchIndex('pi', '/transcript', record)).toBeNull();
});

it('removes deleted sources without touching live indexes or unrelated files', async () => {
  const data = { text: 'body', cwd: '', mtime: 1 };
  await writeSearchIndex('claude', '/live', data);
  await writeSearchIndex('claude', '/deleted', data);
  const extra = path.join(location.dir, 'search-index-v3', 'claude', 'unrelated');
  await fs.writeFile(extra, 'keep');
  await pruneSearchIndex('claude', ['/live']);
  expect(await readSearchIndex('claude', '/live', data)).toEqual(data);
  expect(await readSearchIndex('claude', '/deleted', data)).toBeNull();
  expect(await fs.readFile(extra, 'utf8')).toBe('keep');
});

// P2-69: the Codex cwd extraction fix (f1dc98b) changed the semantics of the
// persisted `cwd`, the only project path a Codex search result carries. The
// producer fix shipped with no index-directory bump, so pre-fix records — whose
// (mtime,size,ctime) tuple never changes because rollouts are immutable — kept
// serving the stale cwd forever and the palette spawned Codex in the wrong repo.
// The versioned directory IS the cache schema; v2 records must read as a miss.
it('treats records persisted under the pre-v3 directory as a miss and rebuilds', async () => {
  const source = '/repo/.codex/sessions/2026-10-10/rollout-x.jsonl';
  const version = { mtime: 1, size: 5, ctime: 2 };
  const stale = { text: 'body', cwd: '/wrong/repo', ...version };
  const oldDir = path.join(location.dir, 'search-index-v2', 'codex');
  await fs.mkdir(oldDir, { recursive: true });
  await fs.writeFile(path.join(oldDir, createHash('sha256').update(source).digest('hex') + '.json'), JSON.stringify(stale));
  // Same version tuple: the ONLY reason this record misses is the schema bump.
  expect(await readSearchIndex('codex', source, version)).toBeNull();
  const fresh = { text: 'body', cwd: '/right/repo', ...version };
  await writeSearchIndex('codex', source, fresh);
  expect(await readSearchIndex('codex', source, version)).toEqual(fresh);
  const key = createHash('sha256').update(source).digest('hex') + '.json';
  expect(JSON.parse(await fs.readFile(path.join(location.dir, 'search-index-v3', 'codex', key), 'utf8')).cwd).toBe('/right/repo');
});
