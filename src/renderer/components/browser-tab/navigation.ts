import type { BrowserTabInstance } from './types.js';

const KNOWN_SCHEMES = /^(https?|file|ftp|ftps|about|chrome|data|blob|mailto):/i;
// javascript: is self-XSS bait and view-source: serves no feature; normalizing
// either to '' makes navigateTo (which no-ops on empty) refuse them.
const BLOCKED_SCHEMES = /^(javascript|view-source):/i;

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || BLOCKED_SCHEMES.test(trimmed)) return '';
  if (!KNOWN_SCHEMES.test(trimmed)) return 'http://' + trimmed;
  return trimmed;
}

export function navigateTo(instance: BrowserTabInstance, url: string): void {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return;
  instance.urlInput.value = normalizedUrl;
  instance.webview.src = normalizedUrl;
  instance.newTabPage.style.display = 'none';
}
