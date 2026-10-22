import { t } from '../i18n.js';

export function initUpdateBanner(): void {
  const mainArea = document.getElementById('main-area');
  if (!mainArea) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'hidden';
  mainArea.prepend(banner);

  const messageSpan = document.createElement('span');
  messageSpan.className = 'update-banner-message';
  banner.appendChild(messageSpan);

  const actionBtn = document.createElement('button');
  actionBtn.className = 'update-banner-btn hidden';
  banner.appendChild(actionBtn);

  function show(msg: string, btn?: { label: string; action: () => void }, autoHideMs?: number): void {
    messageSpan.textContent = msg;
    banner.classList.remove('hidden');

    if (btn) {
      actionBtn.textContent = btn.label;
      actionBtn.onclick = btn.action;
      actionBtn.classList.remove('hidden');
    } else {
      actionBtn.classList.add('hidden');
    }

    if (autoHideMs) {
      setTimeout(() => banner.classList.add('hidden'), autoHideMs);
    }
  }

  let latestVersion = '';
  // C4S-05: a mid-download `update:error` must surface — without this the
  // banner sits on the last "Downloading… 42%" forever.
  let downloading = false;

  window.finevibe.update.onAvailable((info) => {
    latestVersion = info.version;
    downloading = true;
    show(`Downloading update v${info.version}...`);
  });

  window.finevibe.update.onDownloadProgress((info) => {
    const label = latestVersion ? `v${latestVersion}` : 'update';
    show(`Downloading ${label}... ${info.percent}%`);
  });

  window.finevibe.update.onDownloaded((info) => {
    downloading = false;
    show(`Update v${info.version} ready.`, {
      label: 'Restart',
      action: () => window.finevibe.update.install(),
    });
  });

  window.finevibe.update.onError(() => {
    // Check failures stay silent (the About pane reports them); a failure
    // DURING a download replaces the stalled progress banner, then clears.
    if (!downloading) return;
    downloading = false;
    latestVersion = '';
    show(t('update.downloadFailed'), undefined, 5000);
  });
}
