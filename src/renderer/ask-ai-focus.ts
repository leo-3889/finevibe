// Focus decision for Ask AI sends, kept DOM-free so it can be unit-tested
// (same shape as the pane-focus.ts / pane-order.ts decision units).
import type { Preferences } from '../shared/types.js';

/**
 * Whether an Ask AI / new-session send from a file pane or browser tab makes
 * the new session the active tab.
 *
 * `Preferences.askAiFocus` is opt-out: absent (every pre-setting install) and
 * `'switch'` keep the shipped behavior — activate and focus the new tab. Only
 * `'stay'` runs the session in the background: the tab is appended, spawns,
 * and receives its prompt while `activeSessionId` and DOM focus stay put.
 */
export function shouldActivateAskAiSession(
  prefs: Pick<Preferences, 'askAiFocus'> | null | undefined,
): boolean {
  return prefs?.askAiFocus !== 'stay';
}
