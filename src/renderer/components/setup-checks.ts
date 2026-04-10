import type { CliProviderMeta, SettingsValidationResult } from '../../shared/types.js';

export interface ProviderStatus {
  meta: CliProviderMeta;
  validation: SettingsValidationResult;
  binary: { ok: boolean; message: string };
}

export function hasProviderIssue({ meta, validation, binary }: ProviderStatus): boolean {
  if (!binary.ok) return false;
  if ((meta.capabilities.costTracking || meta.capabilities.contextWindow) && validation.statusLine !== 'vibeyard') return true;
  if (meta.capabilities.hookStatus && validation.hooks !== 'complete') return true;
  return false;
}
