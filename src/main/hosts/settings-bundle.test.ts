// Settings-bundle builder table (per-host providers T3, §4): the file-set
// contract per provider, R-4 path dedupe, O-1 hook-strip, R3 LF-normalization,
// and the never-synced exclusions. Pure function against a fixture source —
// no fs, no ssh.

import { describe, expect, it } from 'vitest';
import { buildSettingsBundle, neverSyncPath, type BundleSourceFs } from './settings-bundle';
import { HOST_HOOK_MARKER, hostHookEntries, mergeHookBlock } from './host-hooks';

/** Fixture view: files keyed by `~/`-anchored path; dirs with a trailing /. */
function fixture(files: Record<string, string>, dirs: string[] = []): BundleSourceFs {
  const dirSet = new Set(dirs);
  return {
    readText: async (p) => files[p] ?? null,
    listDir: async (d) => {
      if (!dirSet.has(d)) return null;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(d)) continue;
        const rest = p.slice(d.length);
        if (rest && !rest.includes('/')) names.add(rest);
      }
      for (const x of dirSet) {
        if (x === d || !x.startsWith(d)) continue;
        const rest = x.slice(d.length).replace(/\/$/, '');
        if (rest && !rest.includes('/')) names.add(rest);
      }
      return [...names];
    },
  };
}

const PI_FILES = {
  '~/.pi/agent/settings.json': '{"model":"opus"}\n',
  '~/.pi/agent/AGENTS.md': '# rules\r\n',
  '~/.pi/agent/mcp.json': '{"mcpServers":{}}\n',
  '~/.pi/agent/npm/package.json': '{"dependencies":{"x":"1"}}\n',
  '~/.pi/agent/npm/package-lock.json': '{"lockfileVersion":3}\n',
  '~/.pi/agent/npm/node_modules/dep/index.js': 'module.exports=1',
  '~/.pi/agent/skills/a/SKILL.md': 'skill a',
  '~/.pi/agent/skills/a/nested/b.md': 'deep b',
  '~/.pi/agent/skills/a/node_modules/x/index.js': 'nope',
  '~/.pi/agent/skills/a/sessions/s1.json': '{}',
  '~/.pi/agent/skills/a/cache/c.json': '{}',
  '~/.pi/agent/skills/a/ssh-remote-config.json': '{}',
  '~/.pi/agent/sessions/old.json': '{}',
  '~/.pi/agent/cache/big.json': '{}',
};
const PI_DIRS = [
  '~/.pi/agent/skills/',
  '~/.pi/agent/skills/a/',
  '~/.pi/agent/skills/a/nested/',
  '~/.pi/agent/skills/a/node_modules/',
  '~/.pi/agent/skills/a/sessions/',
  '~/.pi/agent/skills/a/cache/',
  '~/.pi/agent/npm/',
  '~/.pi/agent/npm/node_modules/',
  '~/.pi/agent/sessions/',
  '~/.pi/agent/cache/',
];

const OMP_FILES = {
  '~/.omp/agent/settings.json': '{"theme":"dark"}\n',
  '~/.omp/agent/keybindings.yml': 'keys:\r\n  quit: ctrl-q\n',
  '~/.omp/agent/config.yml': 'model: opus',
  '~/.omp/agent/ssh-remote-config.json': '{"host":"laptop"}',
  '~/.omp/agent/sessions/s.json': '{}',
  '~/.omp/plugins/package.json': '{"dependencies":{"p":"1"}}\n',
  '~/.omp/plugins/omp-plugins.lock.json': '{"lock":1}\n',
  '~/.omp/plugins/node_modules/p/index.js': 'nope',
};
const OMP_DIRS = ['~/.omp/agent/', '~/.omp/agent/sessions/', '~/.omp/plugins/', '~/.omp/plugins/node_modules/'];

const ALL = fixture({ ...PI_FILES, ...OMP_FILES }, [...PI_DIRS, ...OMP_DIRS]);

const paths = (entries: { relPath: string }[]): string[] => entries.map((e) => e.relPath).sort();

describe('buildSettingsBundle — file-set table (§4)', () => {
  it('pi: settings/AGENTS/mcp + skills tree, nothing else', async () => {
    expect(paths(await buildSettingsBundle(['pi'], ALL))).toEqual([
      '~/.pi/agent/AGENTS.md',
      '~/.pi/agent/mcp.json',
      '~/.pi/agent/settings.json',
      '~/.pi/agent/skills/a/SKILL.md',
      '~/.pi/agent/skills/a/nested/b.md',
    ]);
  });

  it('pi-bolt: the pi tree plus npm manifests, never node_modules', async () => {
    const got = paths(await buildSettingsBundle(['pi-bolt'], ALL));
    expect(got).toEqual([...paths(await buildSettingsBundle(['pi'], ALL)), '~/.pi/agent/npm/package-lock.json', '~/.pi/agent/npm/package.json'].sort());
    expect(got.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('omp: agent settings/keybindings + plugin manifests only', async () => {
    expect(paths(await buildSettingsBundle(['omp'], ALL))).toEqual([
      '~/.omp/agent/keybindings.yml',
      '~/.omp/agent/settings.json',
      '~/.omp/plugins/omp-plugins.lock.json',
      '~/.omp/plugins/package.json',
    ]);
  });

  it('R-4 dedupe: pi + pi-bolt builds each shared path exactly once', async () => {
    const got = await buildSettingsBundle(['pi', 'pi-bolt'], ALL);
    const set = paths(got);
    expect(set).toHaveLength(got.length); // no duplicate relPath
    expect(set.filter((p) => p === '~/.pi/agent/settings.json')).toEqual(['~/.pi/agent/settings.json']);
  });

  it('missing source files are absent, not empty', async () => {
    const sparse = fixture({ '~/.pi/agent/AGENTS.md': 'only this' });
    expect(paths(await buildSettingsBundle(['pi', 'pi-bolt', 'omp'], sparse))).toEqual(['~/.pi/agent/AGENTS.md']);
  });

  it('non-syncable providers contribute nothing', async () => {
    expect(await buildSettingsBundle(['claude', 'codex'] as never, ALL)).toEqual([]);
  });

  it('empty source builds an empty bundle', async () => {
    expect(await buildSettingsBundle(['pi', 'omp'], fixture({}, []))).toEqual([]);
  });
});

describe('buildSettingsBundle — exclusions (§4 never-synced)', () => {
  it('sessions/cache/node_modules/ssh-remote-config.json never enter a walk', async () => {
    const got = paths(await buildSettingsBundle(['pi', 'pi-bolt', 'omp'], ALL));
    for (const p of got) {
      expect(p).not.toMatch(/(^|\/)(sessions|cache|node_modules)(\/|$)/);
      expect(p).not.toContain('ssh-remote-config.json');
    }
  });

  it('neverSyncPath matches the four names', () => {
    for (const n of ['a/sessions', 'a/cache/', 'x/node_modules', 'a/ssh-remote-config.json']) expect(neverSyncPath(n)).toBe(true);
    for (const n of ['a/sessions.md', 'cache.json', 'a/skills']) expect(neverSyncPath(n)).toBe(false);
  });
});

describe('buildSettingsBundle — transforms', () => {
  it('O-1: the settings.json push strips exactly the FineVibe hook block', async () => {
    const withHooks = mergeHookBlock(JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foreign.sh' }] }] } }), hostHookEntries('pi')).json;
    const src = fixture({ ...PI_FILES, '~/.pi/agent/settings.json': withHooks });
    const bundle = await buildSettingsBundle(['pi'], src);
    const settings = bundle.find((e) => e.relPath === '~/.pi/agent/settings.json')!;
    const parsed = JSON.parse(settings.content);
    expect(JSON.stringify(parsed).includes(HOST_HOOK_MARKER)).toBe(false);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('foreign.sh'); // foreign hooks survive
    expect(parsed.model).toBe('opus');
  });

  it('O-1: an already-stripped settings.json pushes verbatim', async () => {
    const bundle = await buildSettingsBundle(['pi'], ALL);
    expect(bundle.find((e) => e.relPath === '~/.pi/agent/settings.json')!.content).toBe('{"model":"opus"}\n');
  });

  it('O-1: a corrupt settings.json throws — nothing builds from an unparseable config', async () => {
    const src = fixture({ ...PI_FILES, '~/.pi/agent/settings.json': '{corrupt' });
    await expect(buildSettingsBundle(['pi'], src)).rejects.toThrow(/not valid JSON/);
  });

  it('R3: CRLF sources land LF-normalized', async () => {
    const bundle = await buildSettingsBundle(['pi', 'omp'], ALL);
    expect(bundle.find((e) => e.relPath === '~/.pi/agent/AGENTS.md')!.content).toBe('# rules\n');
    expect(bundle.find((e) => e.relPath === '~/.omp/agent/keybindings.yml')!.content).toBe('keys:\n  quit: ctrl-q\n');
    for (const e of bundle) expect(e.content).not.toContain('\r\n');
  });
});
