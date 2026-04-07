import type { BrowserTabInstance } from './types.js';

export function navigateTo(instance: BrowserTabInstance, url: string): void {
  let normalizedUrl = url.trim();
  if (normalizedUrl && !/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'http://' + normalizedUrl;
  }
  if (!normalizedUrl) return;
  instance.urlInput.value = normalizedUrl;
  instance.webview.src = normalizedUrl;
  instance.newTabPage.style.display = 'none';
}
