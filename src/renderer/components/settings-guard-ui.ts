import { showAlertBanner, removeAlertBanner } from './alert-banner.js';
import { showStatusLineConflictModal } from './statusline-conflict-modal.js';
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

    let message: string;
    if (hasStatusLineIssue && hasHooksIssue) {
      message = 'FineVibe settings are missing from Claude Code. Cost tracking and session activity may not work.';
    } else if (hasStatusLineIssue) {
      message = data.statusLine === 'foreign'
        ? 'Another tool has overwritten FineVibe\'s statusLine setting. Cost tracking is unavailable.'
        : 'Cost tracking is unavailable \u2014 FineVibe\'s statusLine setting is not configured in Claude Code.';
    } else {
      message = 'Some session tracking hooks are missing from Claude Code settings. Activity tracking may not work.';
    }

    showAlertBanner({
      icon: '\u26A0',
      message,
      cta: {
        label: 'Fix Settings',
        onClick: async (btn) => {
          btn.disabled = true;
          btn.textContent = 'Fixing\u2026';
          // P2-127: repair the config dir the banner was computed from —
          // for a profile session that is the profile dir, not ~/.claude.
          const result = await window.finevibe.settings.reinstall(undefined, data.configDir);
          if (result.success) {
            removeAlertBanner();
          } else {
            btn.disabled = false;
            btn.textContent = 'Fix Settings';
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
