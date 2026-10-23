import { t } from '../i18n.js';
import type { DiskHealth } from '../../shared/types.js';

/**
 * Global low-disk banner. The main-process preflight
 * (src/main/disk-health.ts) emits on state transitions only, so this banner
 * appears once per outage and disappears on recovery — never per-write.
 * Dismissing it is session-scoped: a fresh launch re-shows a live outage.
 */

let dismissedForSession = false;
let currentBanner: HTMLElement | null = null;
let lastCheckedAt = '';

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function removeBanner(): void {
  if (currentBanner) {
    currentBanner.remove();
    currentBanner = null;
  }
}

function showBanner(status: DiskHealth): void {
  removeBanner();
  const mainArea = document.getElementById('main-area');
  if (!mainArea) return;

  // Same CSS component as the session-scoped alert banner (styles/alerts.css)
  // — appended to #main-area, this instance is app-global, not pane-bound.
  const banner = document.createElement('div');
  banner.className = 'insight-alert';
  banner.id = 'disk-health-banner';
  banner.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'insight-alert-icon';
  icon.textContent = '\u26A0';

  const message = document.createElement('span');
  message.className = 'insight-alert-message';
  message.textContent = status.availableBytes === undefined
    ? t('disk.lowSpaceUnknown')
    : t('disk.lowSpace', { available: formatBytes(status.availableBytes) });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'insight-alert-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', () => {
    dismissedForSession = true;
    removeBanner();
  });

  banner.appendChild(icon);
  banner.appendChild(message);
  banner.appendChild(closeBtn);
  mainArea.prepend(banner);
  currentBanner = banner;
}

function render(status: DiskHealth | null): void {
  if (!status) return;
  // The on-mount fetch and the push channel race; ISO checkedAt is
  // lexicographically ordered, so a stale fetch answer is dropped and an
  // equal one re-renders idempotently.
  if (status.checkedAt < lastCheckedAt) return;
  lastCheckedAt = status.checkedAt;
  if (status.state === 'low' && !dismissedForSession) {
    showBanner(status);
  } else {
    removeBanner();
  }
}

export function initDiskHealthBanner(): void {
  window.finevibe.disk.onStatus(render);
  window.finevibe.disk.get().then(render).catch(() => {
    // No last status (preflight not started / IPC unavailable): stay quiet
    // and rely on pushes.
  });
}
