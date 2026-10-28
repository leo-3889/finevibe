import type { OverviewWidget } from '../../../../shared/types.js';
import {
  DEFAULT_SESSIONS_CONFIG,
  SESSIONS_RECENT_LIMIT_MAX,
  SESSIONS_RECENT_LIMIT_MIN,
  type SessionsConfig,
} from './sessions-types.js';
import { showLimitSettingsModal } from './limit-settings-modal.js';
import { t } from '../../../i18n.js';

export function showSessionsSettings(
  widget: OverviewWidget,
  onSave: (patch: Partial<SessionsConfig>) => void,
): void {
  const cfg = (widget.config ?? {}) as Partial<SessionsConfig>;
  const current: SessionsConfig = {
    recentLimit:
      typeof cfg.recentLimit === 'number' ? cfg.recentLimit : DEFAULT_SESSIONS_CONFIG.recentLimit,
  };

  // Row 28: the modal shell/form/clamp is the shared widget limit modal.
  showLimitSettingsModal({
    id: 'sessions-settings-modal',
    title: t('projectTab.sessionsSettings.title'),
    label: t('projectTab.sessionsSettings.limitLabel'),
    help: t('projectTab.sessionsSettings.limitHelp', { min: SESSIONS_RECENT_LIMIT_MIN, max: SESSIONS_RECENT_LIMIT_MAX }),
    min: SESSIONS_RECENT_LIMIT_MIN,
    max: SESSIONS_RECENT_LIMIT_MAX,
    fallback: DEFAULT_SESSIONS_CONFIG.recentLimit,
    currentValue: current.recentLimit,
    cancelLabel: t('projectTab.sessionsSettings.cancelButton'),
    saveLabel: t('projectTab.sessionsSettings.saveButton'),
    onSave: (clamped) => onSave({ recentLimit: clamped }),
  });
}
