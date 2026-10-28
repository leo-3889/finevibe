import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openExternal } from './open-external';

const bridgeOpenExternal = vi.hoisted(() => vi.fn());

beforeEach(() => {
  bridgeOpenExternal.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    finevibe: { app: { openExternal: bridgeOpenExternal } },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('openExternal', () => {
  it('forwards the url to the bridge and resolves true', async () => {
    bridgeOpenExternal.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(openExternal('https://example.com/a')).resolves.toBe(true);
      expect(bridgeOpenExternal).toHaveBeenCalledWith('https://example.com/a');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns with the url and resolves false when the bridge rejects', async () => {
    bridgeOpenExternal.mockRejectedValue(new Error('no default handler'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(openExternal('https://example.com/a')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://example.com/a'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resolves false when the bridge throws synchronously', async () => {
    bridgeOpenExternal.mockImplementation(() => {
      throw new Error('bridge gone');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(openExternal('https://example.com/b')).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://example.com/b'),
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
