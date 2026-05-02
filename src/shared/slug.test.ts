import { describe, expect, it } from 'vitest';
import { ensureUniqueSlug, nameToSlug } from './slug';

describe('nameToSlug', () => {
  it('lowercases and replaces whitespace with dashes', () => {
    expect(nameToSlug('Sarah Marketing')).toBe('sarah-marketing');
  });

  it('strips diacritics', () => {
    expect(nameToSlug('Renée Côté')).toBe('renee-cote');
  });

  it('collapses runs of punctuation/whitespace into a single dash', () => {
    expect(nameToSlug('  Foo   --   Bar!! ')).toBe('foo-bar');
  });

  it('drops leading/trailing dashes', () => {
    expect(nameToSlug('--hi--')).toBe('hi');
  });

  it('falls back to "agent" when nothing remains', () => {
    expect(nameToSlug('!!!')).toBe('agent');
    expect(nameToSlug('')).toBe('agent');
  });
});

describe('ensureUniqueSlug', () => {
  it('returns the base slug when not taken', () => {
    expect(ensureUniqueSlug('cmo', new Set())).toBe('cmo');
    expect(ensureUniqueSlug('cmo', new Set(['cto']))).toBe('cmo');
  });

  it('suffixes when the base slug is taken', () => {
    const out = ensureUniqueSlug('cmo', new Set(['cmo']));
    expect(out).not.toBe('cmo');
    expect(out.startsWith('cmo-')).toBe(true);
    expect(out).toMatch(/^cmo-[0-9a-f]+$/);
  });

  it('keeps suffixing until unique', () => {
    const taken = new Set(['cmo']);
    const a = ensureUniqueSlug('cmo', taken);
    taken.add(a);
    const b = ensureUniqueSlug('cmo', taken);
    expect(a).not.toBe(b);
  });
});
