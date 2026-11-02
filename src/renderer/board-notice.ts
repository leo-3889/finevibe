/**
 * Transient board notice — how the board tells the user a write was REFUSED.
 * The app's refusal idiom is the self-removing bottom toast
 * (`showHistoryToast` in `components/session-history.ts`); this is the board's
 * copy of it, in its own module so `board-state.ts` can refuse out loud on
 * every card-move path (drag, modal column picker, run-completion auto-move)
 * without importing a component tree.
 */
export function showBoardNotice(message: string): void {
  const el = document.createElement('div');
  el.className = 'board-notice';
  // The refusal has no other visible effect — announce it (a11y basics).
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.textContent = message;
  el.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;' +
    'padding:8px 14px;border-radius:6px;background:var(--bg-secondary,#222);color:var(--fg-primary,#eee);' +
    'border:1px solid var(--border-color,#444);font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.4);';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
