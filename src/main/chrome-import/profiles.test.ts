import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  homedir: () => '/mock/home',
}));

vi.mock('../platform', () => ({
  isMac: true,
  isWin: false,
  isLinux: false,
}));

import * as fs from 'fs';
import { listProfiles } from './profiles';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listProfiles', () => {
  it('returns empty when Chrome dir does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(listProfiles()).toEqual([]);
  });

  it('parses profiles from Local State info_cache', () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('Chrome') || path.endsWith('Default') || path.endsWith('Profile 1');
    });
    mockReadFileSync.mockReturnValue(JSON.stringify({
      profile: {
        info_cache: {
          'Default': { name: 'Personal' },
          'Profile 1': { name: 'Work', gaia_name: 'Work GAIA' },
        },
      },
    }));
    mockReaddirSync.mockReturnValue([] as unknown as fs.Dirent[]);

    const profiles = listProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({ id: 'Default', displayName: 'Personal' });
    expect(profiles[1]).toEqual({ id: 'Profile 1', displayName: 'Work' });
  });

  it('falls back to directory scan when Local State is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mockReaddirSync.mockReturnValue([
      { name: 'Default', isDirectory: () => true } as fs.Dirent,
      { name: 'Profile 1', isDirectory: () => true } as fs.Dirent,
      { name: 'Cache', isDirectory: () => true } as fs.Dirent,
    ]);

    const profiles = listProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.id).sort()).toEqual(['Default', 'Profile 1']);
  });
});
