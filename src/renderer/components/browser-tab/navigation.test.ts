import { describe, it, expect } from 'vitest';
import { normalizeUrl, navigateTo } from './navigation.js';
import type { BrowserTabInstance } from './types.js';

function makeInstance(): BrowserTabInstance {
  return {
    urlInput: { value: '' },
    webview: { src: '' },
    newTabPage: { style: { display: 'flex' } },
  } as unknown as BrowserTabInstance;
}

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

  it('wraps host:port with http://', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
  });

  it('wraps ip:port with http://', () => {
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('blocks javascript: URLs', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBe('');
  });

  it('blocks view-source: URLs', () => {
    expect(normalizeUrl('view-source:https://example.com')).toBe('');
  });

  it('blocks both schemes case-insensitively and after trimming', () => {
    expect(normalizeUrl('JavaScript:alert(1)')).toBe('');
    expect(normalizeUrl('  VIEW-SOURCE:https://example.com  ')).toBe('');
  });
});

describe('navigateTo', () => {
  it('does not navigate to javascript: URLs', () => {
    const instance = makeInstance();
    navigateTo(instance, 'javascript:alert(document.cookie)');
    expect(instance.webview.src).toBe('');
    expect(instance.urlInput.value).toBe('');
  });

  it('does not navigate on empty input', () => {
    const instance = makeInstance();
    navigateTo(instance, '   ');
    expect(instance.webview.src).toBe('');
  });

  it('navigates to https URLs and hides the new-tab page', () => {
    const instance = makeInstance();
    navigateTo(instance, 'https://example.com');
    expect(instance.webview.src).toBe('https://example.com');
    expect(instance.urlInput.value).toBe('https://example.com');
    expect(instance.newTabPage.style.display).toBe('none');
  });

  it('navigates to bare hostnames with http://', () => {
    const instance = makeInstance();
    navigateTo(instance, 'example.com');
    expect(instance.webview.src).toBe('http://example.com');
  });
});
