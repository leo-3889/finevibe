import type { CliProviderMeta, SettingsValidationResult } from '../../shared/types.js';

export interface ProviderStatus {
  meta: CliProviderMeta;
  validation: SettingsValidationResult;
  binaryOk: boolean;
  /**
   * True for a project-scope provider (Copilot) with no project open: the
   * validation is meaningless (hooks live per-project), so the row renders
   * neutral and never counts as an issue.
   */
  hooksNeutral?: boolean;
}

export function hasProviderIssue({ meta, validation, binaryOk, hooksNeutral }: ProviderStatus): boolean {
  if (!binaryOk) return false;
  // SA-P2-1: a foreign statusLine the user deliberately Kept (declined
  // consent covering this command) is a choice, not an issue.
  if ((meta.capabilities.costTracking || meta.capabilities.contextWindow) && validation.statusLine !== 'finevibe' && !validation.userKeptStatusLine) return true;
  if (meta.capabilities.hookStatus && !hooksNeutral && validation.hooks !== 'complete') return true;
  return false;
}
