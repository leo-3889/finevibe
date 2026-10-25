import { showAlertBanner, removeAlertBanner } from './alert-banner.js';
import { showStatusLineConflictModal } from './statusline-conflict-modal.js';
import { t } from '../i18n.js';
import { getProviderDisplayName } from '../provider-availability.js';
import type { SettingsWarningData } from '../../shared/types';

let initialized = false;

export function initSettingsGuard(): void {
  if (initialized) return;
  initialized = true;

  window.finevibe.settings.onConflictDialog((data) => {
    showStatusLineConflictModal(data.foreignCommand).then((choice) => {
      window.finevibe.settings.respondConflictDialog(choice);
    });
  });

  window.finevibe.settings.onWarning((data: SettingsWarningData) => {
    const hasStatusLineIssue = data.statusLine !== 'finevibe';
    const hasHooksIssue = data.hooks !== 'complete';

    if (!hasStatusLineIssue && !hasHooksIssue) return;

    // SA-P1-2: the banner is per-provider (codex/gemini/copilot all fire
    // it) — the copy names the provider the validation came from.
    const providerName = getProviderDisplayName(data.providerId);
    let message: string;
    if (hasStatusLineIssue && hasHooksIssue) {
      message = t('settingsGuard.bothMissing', { provider: providerName });
    } else if (hasStatusLineIssue) {
      message = data.statusLine === 'foreign'
        ? t('settingsGuard.statusLineForeign')
        : t('settingsGuard.statusLineMissing', { provider: providerName });
    } else {
      message = t('settingsGuard.hooksMissing', { provider: providerName });
    }

    showAlertBanner({
      icon: '\u26A0',
      message,
      cta: {
        label: t('settingsGuard.fixButton'),
        onClick: async (btn) => {
          btn.disabled = true;
          btn.textContent = t('settingsGuard.fixingButton');
          // SA-P1-2: repair the provider the banner was computed from —
          // a codex/gemini/copilot banner must not run Claude's reinstall.
          // P2-127: repair the config dir the banner was computed from —
          // for a profile session that is the profile dir, not ~/.claude.
          // P2-55: and the project the banner was computed from — Copilot
          // hooks are project-scoped, the user scope is not the broken file.
          const result = await window.finevibe.settings.reinstall(data.providerId, data.configDir, data.projectPath);
          if (result.success) {
            removeAlertBanner();
          } else {
            btn.disabled = false;
            btn.textContent = t('settingsGuard.fixButton');
          }
        },
      },
      // P1-14: for a profile session this banner is the single consent
      // surface (spawn never shows the modal): dismissing a foreign
      // statusLine warning records a Keep for that dir, which the
      // per-spawn install then honors. The default dir's consent stays
      // bound to the boot-time conflict modal, so no dismiss action there.
      onDismiss: hasStatusLineIssue && data.statusLine === 'foreign' && data.configDir
        ? () => window.finevibe.settings.declineConflict(data.configDir, data.foreignStatusLineCommand ?? null)
        : undefined,
    });
  });
}
