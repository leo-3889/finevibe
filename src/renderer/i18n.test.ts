import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting, getLocale, onLocaleChange, setLocale, t } from './i18n.js';

// P2-112: the `t()` fallback branch (active locale miss → English lookup) was
// unreachable while en/zh are at key parity — the branch fires only for keys
// missing from the active locale. The zh-CN resource is therefore mocked as a
// clone of the real file with `board.title` (en: 'Board', zh: '看板') deleted,
// making it a genuine en-only key for this suite. The locale-parity test below
// reads the REAL files via vi.importActual, so the mock cannot mask drift.
vi.mock('./locales/zh-CN.json', async (importOriginal) => {
  const actual = await importOriginal<{ default: { board: { title: string }; sidebar: { removeConfirm: Record<string, string> } } }>();
  const zh = structuredClone(actual.default);
  delete zh.board.title;
  delete zh.sidebar.removeConfirm.withDataMessage;
  return { ...actual, default: zh };
});

describe('i18n', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
  });

  describe('t() interpolation', () => {
    it('substitutes named placeholders', () => {
      setLocale('en');
      expect(t('preferences.title')).toBe('Preferences');
    });

    it('substitutes {name} with the value from vars', () => {
      setLocale('en');
      // Force-look at a key with a {name}-style placeholder.
      // The "withDataMessage" template uses {name} and {parts}.
      const out = t('sidebar.removeConfirm.withDataMessage', {
        name: 'demo',
        parts: 'x and y',
      });
      expect(out).toBe('Remove project "demo"? This will delete x and y from FineVibe. No files on disk will be affected.');
    });

    it('leaves placeholders intact when the variable is missing', () => {
      setLocale('en');
      const out = t('sidebar.removeConfirm.withDataMessage', { name: 'demo' });
      expect(out).toContain('{parts}');
      expect(out).toContain('demo');
    });

    it('coerces numeric vars to strings', () => {
      setLocale('en');
      const out = t('sidebar.removeConfirm.sessionsHistory', { count: 3, noun: 'entries' });
      expect(out).toBe('all sessions and history (3 entries)');
    });
  });

  describe('t() fallback', () => {
    it('returns the active-locale string when present', () => {
      setLocale('zh-CN');
      expect(t('preferences.title')).toBe('偏好设置');
    });

    it('falls back to English when the active locale is missing the key', () => {
      // Drives the real fallback branch: `board.title` exists in en.json and
      // is deleted from the zh-CN mock above, so a zh-CN lookup must resolve
      // through the English resource — not return the raw key, not warn.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setLocale('zh-CN');
      expect(t('board.title')).toBe('Board');
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('interpolates vars into the English fallback template', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setLocale('zh-CN');
      // `sidebar.removeConfirm.withDataMessage` is deleted from the zh mock
      // and its English template carries {name}/{parts} — the fallback branch
      // must interpolate the vars into the ENGLISH string, not just return it.
      expect(t('sidebar.removeConfirm.withDataMessage', { name: 'demo', parts: 'x and y' }))
        .toBe('Remove project "demo"? This will delete x and y from FineVibe. No files on disk will be affected.');
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('t() missing key', () => {
    it('warns once and returns the key', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setLocale('en');
      const key = 'this.key.does.not.exist';
      expect(t(key)).toBe(key);
      expect(warn).toHaveBeenCalledTimes(1);
      // Subsequent calls don't re-warn.
      t(key);
      t(key);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });

  describe('setLocale()', () => {
    it('is a no-op for the current locale (no listener fires)', () => {
      setLocale('en');
      const listener = vi.fn();
      onLocaleChange(listener);
      setLocale('en');
      expect(listener).not.toHaveBeenCalled();
      expect(getLocale()).toBe('en');
    });

    it('rejects unknown locales with a warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setLocale('en');
      // @ts-expect-error - intentionally bogus locale to test runtime guard.
      setLocale('fr-FR');
      expect(warn).toHaveBeenCalledWith('[i18n] unknown locale:', 'fr-FR');
      expect(getLocale()).toBe('en');
      warn.mockRestore();
    });

    it('fires listeners on a real change', () => {
      const listener = vi.fn();
      onLocaleChange(listener);
      setLocale('zh-CN');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getLocale()).toBe('zh-CN');
    });
  });
});

// P2-112: en.json and zh-CN.json are statically bundled and consumed
// key-for-key; a leaf present in one and absent in the other ships silently
// as raw keys (en) or un-interpolated fallback (zh). The audit measured
// 539/539 with a zero gap — this test is the guard that keeps it that way.
function leafKeys(obj: unknown, prefix = ''): string[] {
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? leafKeys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('locale parity (locales/*.json)', () => {
  it('en.json and zh-CN.json expose identical leaf-key sets', async () => {
    // importActual bypasses the zh-CN mock above — parity is checked against
    // the shipped files, not the test fixture.
    const en = (await vi.importActual<{ default: unknown }>('./locales/en.json')).default;
    const zh = (await vi.importActual<{ default: unknown }>('./locales/zh-CN.json')).default;
    const enKeys = new Set(leafKeys(en));
    const zhKeys = new Set(leafKeys(zh));
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([]);
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([]);
  });
});
