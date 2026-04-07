import { describe, it, expect } from 'vitest';
import { normalizeUrl } from './navigation.js';

describe('normalizeUrl', () => {
  it('prepends http:// to bare hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('http://example.com');
  });

  it('preserves http URLs', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('preserves https URLs', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('preserves file:// URLs', () => {
    expect(normalizeUrl('file:///Users/foo/index.html')).toBe('file:///Users/foo/index.html');
  });

  it('preserves about: URLs', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('trims whitespace', () => {
    expect(normalizeUrl('  example.com  ')).toBe('http://example.com');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeUrl('   ')).toBe('');
  });
});
