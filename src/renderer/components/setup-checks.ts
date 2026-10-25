import type { CliProviderMeta, SettingsValidationResult } from '../../shared/types.js';

export interface ProviderStatus {
  meta: CliProviderMeta;
  validation: SettingsValidationResult;
  binaryOk: boolean;
}

export function hasProviderIssue({ meta, validation, binaryOk }: ProviderStatus): boolean {
  if (!binaryOk) return false;
  // SA-P2-1: a foreign statusLine the user deliberately Kept (declined
  // consent covering this command) is a choice, not an issue.
  if ((meta.capabilities.costTracking || meta.capabilities.contextWindow) && validation.statusLine !== 'finevibe' && !validation.userKeptStatusLine) return true;
  if (meta.capabilities.hookStatus && validation.hooks !== 'complete') return true;
  return false;
}
