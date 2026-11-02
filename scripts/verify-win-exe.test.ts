import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

// Row 74 guard coverage. scripts/verify-win-exe.mjs takes an unpacked app dir
// and asserts (1) the packed better_sqlite3.node carries the NODE_MODULE_VERSION
// that @electron/rebuild recorded in node_modules/.../build/Release/.forge-meta,
// and (2) node-pty's win32 prebuilds (winpty/conpty dlls + agents) survived
// packing. The fixtures are synthetic because the real Windows bundle does not
// exist on a linux/mac host.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'verify-win-exe.mjs');
const metaFile = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', '.forge-meta');
const rebuildAbi = /--(\d+)$/.exec(fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '')?.[1];
// The marker only exists after `electron-builder install-app-deps` succeeded;
// the postinstall hook swallows that failure, so the suite skips instead of
// blaming the guard for an un-rebuilt tree (same idiom as the chrome-import
// suites, which skip on a Node-ABI binding).
const skip = rebuildAbi === undefined;

const PTY_FILES = ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe',
  path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')];

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function unpackedFixture(packedAbi: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-win-unpacked-'));
  dirs.push(dir);
  const modules = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules');
  const binding = path.join(modules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  // The register symbol is what the guard greps for in the real 2 MB binary.
  fs.writeFileSync(binding, Buffer.from(`MZ dummy ${packedAbi ? `node_register_module_v${packedAbi}` : 'napi_register_module_v1'}`, 'latin1'));
  for (const rel of PTY_FILES) {
    const file = path.join(modules, 'node-pty', 'prebuilds', 'win32-x64', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  return dir;
}

function verify(dir: string): string {
  try {
    return execFileSync(process.execPath, [script, dir], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    throw new Error((err as { stderr?: string }).stderr ?? String(err));
  }
}

describe('verify-win-exe.mjs packed-native mode', () => {
  it.skipIf(skip)('passes when the packed binding matches .forge-meta and every win32 prebuild is present', () => {
    expect(verify(unpackedFixture(rebuildAbi!))).toContain('OK: packed native modules');
  });

  it.skipIf(skip)('fails when the packed binding is a Node-ABI build', () => {
    expect(() => verify(unpackedFixture(String(Number(rebuildAbi) + 1)))).toThrow(/targets ABI/);
  });

  it.skipIf(skip)('fails when the packed binding has no ABI marker at all (N-API build)', () => {
    expect(() => verify(unpackedFixture(null))).toThrow(/targets ABI \?, the Electron rebuild recorded/);
  });

  it('fails when a win32 conpty.dll is missing from the bundle', () => {
    const dir = unpackedFixture(rebuildAbi ?? '145');
    fs.rmSync(path.join(dir, 'resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll'));
    expect(() => verify(dir)).toThrow(/conpty\.dll missing or empty/);
  });

  it('fails when the argument is not an unpacked app dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finevibe-not-unpacked-'));
    dirs.push(dir);
    expect(() => verify(dir)).toThrow(/not found - pass the unpacked app dir/);
  });
});
