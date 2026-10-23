import { appState } from '../../state.js';
import { t } from '../../i18n.js';
import type { SectionController } from './section.js';
import { toggleRow } from './shared.js';
import { openExternal } from '../../open-external.js';

// C4S-10: the fork's public repo is leo-3889/finevibe (git remote `fork`).
const GITHUB_URL = 'https://github.com/leo-3889/finevibe';
const ISSUES_URL = 'https://github.com/leo-3889/finevibe/issues';

export function createAboutSection(): SectionController {
  let debugModeCheckbox: HTMLInputElement | null = null;
  // C4S-04: the check-Now listener pair + its 5 s timeout live on the
  // controller so closing the modal (or switching sections) mid-check
  // unregisters them — pairs left behind run stale callbacks on the next
  // background `update:available`.
  let pendingUpdateCleanup: (() => void) | null = null;
  const clearUpdateCheck = () => {
    pendingUpdateCleanup?.();
    pendingUpdateCleanup = null;
  };
  return {
    render(container) {
      const aboutDiv = document.createElement('div');
      aboutDiv.className = 'about-section';

      const appName = document.createElement('div');
      appName.className = 'about-app-name';
      appName.textContent = t('about.appName');

      const versionLine = document.createElement('div');
      versionLine.className = 'about-version';
      versionLine.textContent = t('about.versionLoading');

      const updateRow = document.createElement('div');
      updateRow.className = 'about-update-row';

      const updateBtn = document.createElement('button');
      updateBtn.className = 'about-update-btn';
      updateBtn.textContent = t('about.updateButton');

      const updateStatus = document.createElement('span');
      updateStatus.className = 'about-update-status';

      updateBtn.addEventListener('click', () => {
        updateBtn.disabled = true;
        updateStatus.textContent = t('about.updateChecking');
        window.finevibe.update.checkNow().then(() => {
          // Every terminal branch unregisters the whole listener pair — a
          // pair left behind makes the next `update:available` event run
          // stale callbacks from this, already-finished check.
          clearUpdateCheck();
          const cleanup = () => {
            clearTimeout(timeout);
            unsub();
            unsubErr();
            pendingUpdateCleanup = null;
          };
          pendingUpdateCleanup = cleanup;
          const timeout = setTimeout(() => {
            updateStatus.textContent = t('about.upToDate');
            updateBtn.disabled = false;
            cleanup();
          }, 5000);
          const unsub = window.finevibe.update.onAvailable((info) => {
            updateStatus.textContent = t('about.updateAvailable', { version: info.version });
            cleanup();
          });
          const unsubErr = window.finevibe.update.onError(() => {
            updateStatus.textContent = t('about.updateFailed');
            updateBtn.disabled = false;
            cleanup();
          });
        }).catch(() => {
          updateStatus.textContent = t('about.updateFailed');
          updateBtn.disabled = false;
        });
      });

      updateRow.appendChild(updateBtn);
      updateRow.appendChild(updateStatus);

      const linksDiv = document.createElement('div');
      linksDiv.className = 'about-links';

      const ghLink = document.createElement('a');
      ghLink.className = 'about-link';
      ghLink.textContent = t('about.githubLink');
      ghLink.href = '#';
      ghLink.addEventListener('click', (e) => { e.preventDefault(); void openExternal(GITHUB_URL); });

      const bugLink = document.createElement('a');
      bugLink.className = 'about-link';
      bugLink.textContent = t('about.bugLink');
      bugLink.href = '#';
      bugLink.addEventListener('click', (e) => { e.preventDefault(); void openExternal(ISSUES_URL); });

      linksDiv.appendChild(ghLink);
      linksDiv.appendChild(bugLink);

      const communityDiv = document.createElement('div');
      communityDiv.className = 'about-community';
      const contributeLink = document.createElement('a');
      contributeLink.className = 'about-link';
      contributeLink.href = '#';
      contributeLink.textContent = t('about.contributeLink');
      contributeLink.addEventListener('click', (e) => { e.preventDefault(); void openExternal(GITHUB_URL); });
      communityDiv.append(
        t('about.communityPrefix'),
        contributeLink,
        t('about.communitySuffix'),
      );

      const debug = toggleRow('pref-debug-mode', t('about.debugModeLabel'), appState.preferences.debugMode);
      const debugRow = debug.row;
      debugModeCheckbox = debug.checkbox;

      aboutDiv.appendChild(appName);
      aboutDiv.appendChild(versionLine);
      aboutDiv.appendChild(updateRow);
      aboutDiv.appendChild(linksDiv);
      aboutDiv.appendChild(communityDiv);
      aboutDiv.appendChild(debugRow);
      container.appendChild(aboutDiv);

      window.finevibe.app.getVersion().then((ver) => {
        versionLine.textContent = t('about.versionLoaded', { ver });
      });
    },

    save() {
      if (debugModeCheckbox && debugModeCheckbox.checked !== appState.preferences.debugMode) {
        appState.setPreference('debugMode', debugModeCheckbox.checked);
        window.finevibe.menu.rebuild(debugModeCheckbox.checked);
      }
    },

    onLeave() {
      clearUpdateCheck();
    },

    destroy() {
      clearUpdateCheck();
    },
  };
}
