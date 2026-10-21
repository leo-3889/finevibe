import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { provisionProfileDir, PROFILES_ROOT } from './profiles';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('provisionProfileDir isolation', () => {
  it('rejects two profiles of the same provider sharing a config directory', () => {
    // P2-39 gates custom profile dirs into the home tree (the CLI config
    // dirs users pick live under the user's tree); the fixture follows.
    const root = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-profiles-test-'));
    dirs.push(root);
    const configDir = path.join(root, 'shared');
    provisionProfileDir('first', configDir, 'claude');
    expect(() => provisionProfileDir('second', configDir, 'claude', [
      { id: 'first', providerId: 'claude', configDir },
    ])).toThrow(/already used/);
    expect(provisionProfileDir('first', configDir, 'claude', [
      { id: 'first', providerId: 'claude', configDir },
    ])).toBe(configDir);
  });
});

const OUTSIDE_HOME = process.platform === 'win32'
  ? 'C:\\Windows\\finevibe-evil'
  : '/finevibe-outside-home-evil';

describe('provisionProfileDir containment (P2-39)', () => {
  it('rejects a custom path outside the home tree before creating anything', () => {
    // customPath is renderer-supplied; provisionProfileDir mkdir -p's it, so
    // an ungated value is a filesystem-wide directory-creation sink the CLI
    // then reads config from. Same containment class as the MCP config gate.
    expect(() => provisionProfileDir('evil', OUTSIDE_HOME, 'claude')).toThrow(/outside your home/);
    expect(fs.existsSync(OUTSIDE_HOME)).toBe(false);
  });

  it('rejects a home-outside path reached through ~ expansion', () => {
    expect(() => provisionProfileDir('evil', '~/../../Windows/evil', 'claude')).toThrow(/outside your home/);
  });

  it('accepts a custom path inside the home tree', () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), '.finevibe-profiles-test-'));
    dirs.push(root);
    const configDir = path.join(root, 'cfg');
    expect(provisionProfileDir('ok', configDir, 'claude')).toBe(configDir);
    expect(fs.existsSync(configDir)).toBe(true);
  });

  it('accepts the auto-managed location under PROFILES_ROOT', () => {
    const dir = provisionProfileDir('wave-d-containment-test', undefined, 'claude');
    dirs.push(dir);
    expect(dir).toBe(path.join(PROFILES_ROOT, 'wave-d-containment-test'));
    expect(fs.existsSync(dir)).toBe(true);
  });
});
