import type { Preferences } from './types';

/**
 * SA-P2-6: the single reconciled defaults object shared by main's `store.ts`
 * and the renderer's `state.ts`. Before this, two near-duplicates drifted
 * (main-only vs renderer-only keys), so the same preference could read a
 * different default on each side of the IPC boundary whenever a state file
 * omitted `preferences`.
 *
 * SA-P2-3: `locale` is deliberately ABSENT. Both old defaults hardcoded
 * `locale: 'en'`, which made the `saved ?? resolveSystemLocale(...)` fallback
 * (renderer/index.ts) dead code — a zh-CN system booted English. The locale
 * is resolved from the system on first launch and persisted then (index.ts
 * initI18n), never defaulted here.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  soundOnSessionWaiting: true,
  notificationsDesktop: true,
  debugMode: false,
  sessionHistoryEnabled: true,
  insightsEnabled: true,
  autoTitleEnabled: true,
  confirmCloseWorkingSession: true,
  copyOnSelect: false,
  zoomFactor: 1.0,
  readinessExcludedProviders: [],
  sidebarViews: { gitPanel: true, sessionHistory: true, discussions: true, fileTree: true, activeSessions: true },
  boardCardMetrics: true,
  defaultProjectsFolder: '',
};
