import type { BrowserTabInstance } from './types.js';

export const instances = new Map<string, BrowserTabInstance>();

let preloadPathPromise: Promise<string> | null = null;

export function getPreloadPath(): Promise<string> {
  if (!preloadPathPromise) {
    preloadPathPromise = window.vibeyard.app.getBrowserPreloadPath();
  }
  return preloadPathPromise;
}

export function getBrowserTabInstance(sessionId: string): BrowserTabInstance | undefined {
  return instances.get(sessionId);
}
