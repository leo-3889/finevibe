import { t } from '../../i18n.js';
import { createModalShell, createModalButton } from '../modal-shell.js';
import { pushModal } from '../modal-manager.js';
import type { AgentmemoryLog } from '../../../shared/types.js';

/**
 * Console (Viewer) URL. Single source for the section's "Open console" link
 * and this modal's "Web UI" button; the status probe also carries it, this is
 * the pre-probe fallback. Same IPv4 literal as the main-process probe URL, so
 * probe and console can never disagree over localhost/::1 resolution.
 */
export const CONSOLE_URL = 'http://127.0.0.1:3113';

const OVERLAY_ID = 'agentmemory-console-overlay';
const POLL_INTERVAL_MS = 1000;
/** How far from the bottom (px) still counts as "at bottom" for auto-scroll. */
const BOTTOM_SLACK_PX = 4;

let cleanupFn: (() => void) | null = null;

/**
 * Tails the agentmemory daemon's console log file (`agentmemory.log` in
 * userData, captured by the main-process spawn) in a modal. The file only
 * fills for daemons FineVibe spawns, so an empty tail is expected — the hint
 * explains that. Polls every second, auto-scrolls only while pinned to the
 * bottom, and tears the interval down on close/ESC/re-open.
 */
export function openAgentmemoryConsoleModal(): void {
  cleanupFn?.();
  cleanupFn = null;

  const { overlay, titleEl, body, actions } = createModalShell({
    id: OVERLAY_ID,
    title: '',
    wide: true,
  });
  titleEl.textContent = t('agentmemory.consoleTitle');
  body.innerHTML = '';
  actions.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'agentmemory-console-header';
  const pathEl = document.createElement('span');
  pathEl.className = 'agentmemory-console-path';
  header.appendChild(pathEl);
  body.appendChild(header);

  const hint = document.createElement('div');
  hint.className = 'agentmemory-console-hint';
  hint.textContent = t('agentmemory.consoleEmpty');
  body.appendChild(hint);

  const pre = document.createElement('pre');
  pre.className = 'agentmemory-console-output';
  body.appendChild(pre);

  const webBtn = createModalButton(t('agentmemory.consoleWebUi'), false);
  const closeBtn = createModalButton(t('agentmemory.consoleClose'), true);
  actions.append(webBtn, closeBtn);

  let lastContent: string | null = null;

  async function poll(): Promise<void> {
    let log: AgentmemoryLog;
    try {
      log = await window.finevibe.agentmemory.log();
    } catch {
      return; // transient IPC failure; the next tick retries
    }
    if (log.content === lastContent) return; // identical tail: leave the DOM untouched
    if (log.path) pathEl.textContent = log.path;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= BOTTOM_SLACK_PX;
    pre.textContent = log.content;
    hint.style.display = log.content ? 'none' : '';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    lastContent = log.content;
  }

  const close = () => {
    overlay.style.display = 'none';
    cleanupFn?.();
    cleanupFn = null;
  };

  const handleWeb = () => {
    // openExternal rejects when no default handler answers; warn like the
    // other openExternal call sites (file-reader.ts) instead of leaking an
    // unhandled rejection.
    window.finevibe.app
      .openExternal(CONSOLE_URL)
      .catch((err: unknown) => console.warn(`[agentmemory] could not open ${CONSOLE_URL}`, err));
  };

  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  const unregisterEsc = pushModal({ onEscape: close });
  webBtn.addEventListener('click', handleWeb);
  closeBtn.addEventListener('click', close);

  cleanupFn = () => {
    clearInterval(timer);
    unregisterEsc();
    webBtn.removeEventListener('click', handleWeb);
    closeBtn.removeEventListener('click', close);
  };

  void poll();
  overlay.style.display = '';
}
