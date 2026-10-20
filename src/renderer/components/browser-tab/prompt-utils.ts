import type { WebviewElement } from './types.js';
import { isWin } from '../../platform.js';

/**
 * Browser→AI prompts are spawned as CLI arguments (`claude "<prompt>"`), so
 * on Windows they ride a cmd.exe command line through the `.cmd` shims:
 * cmd has no escape for a literal `"` — pty-manager rejects such arguments
 * (quoteArgForCmdExe) and the spawn dies with a raw spawn error — and `/c`
 * truncates arguments at newlines. Element selectors (`[data-x="v"]`), page
 * text and user instructions all carry quotes into the prompt, so every
 * builder that can reach argv must pass through here. Injected prompts
 * (running sessions) go through bracketed paste and are unaffected;
 * sanitizing them identically is harmless.
 */
export function sanitizeArgPrompt(text: string): string {
  return isWin ? text.replace(/"/g, "'").replace(/\r?\n/g, ' | ') : text;
}

/** A <webview> that is not attached + dom-ready yet throws on send(); the
 * caller's mode flag would flip while the guest never enters the mode. */
export function safeSend(webview: WebviewElement, channel: string): void {
  try { webview.send(channel); } catch { /* guest not ready */ }
}
