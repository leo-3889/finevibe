import type { OverviewWidget } from '../../../../shared/types.js';
import {
  DEFAULT_TOP_FILES_CONFIG,
  TOP_FILES_LIMIT_MAX,
  TOP_FILES_LIMIT_MIN,
  resolveTopFilesConfig,
  type TopFilesConfig,
} from './top-files-types.js';
import { showLimitSettingsModal } from './limit-settings-modal.js';

export function showTopFilesSettings(
  widget: OverviewWidget,
  onSave: (patch: Partial<TopFilesConfig>) => void,
): void {
  const { limit: currentLimit } = resolveTopFilesConfig(widget.config as Partial<TopFilesConfig> | undefined);

  // Row 28: the modal shell/form/clamp is the shared widget limit modal.
  showLimitSettingsModal({
    id: 'top-files-settings-modal',
    title: 'Top Files Settings',
    label: 'How many files to show',
    help: `Top K files by estimated token count (${TOP_FILES_LIMIT_MIN}–${TOP_FILES_LIMIT_MAX}).`,
    min: TOP_FILES_LIMIT_MIN,
    max: TOP_FILES_LIMIT_MAX,
    fallback: DEFAULT_TOP_FILES_CONFIG.limit,
    currentValue: currentLimit,
    cancelLabel: 'Cancel',
    saveLabel: 'Save',
    onSave: (clamped) => onSave({ limit: clamped }),
  });
}
