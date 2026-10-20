import { appState } from './state.js';
import { isSpawnRejectedExitReason } from '../shared/constants.js';
import { initSidebar, promptNewProject } from './components/sidebar.js';
import { initTabBar } from './components/tab-bar/index.js';
import { initSplitLayout } from './components/split-layout.js';
import { initKeybindings } from './keybindings.js';
import { handlePtyData, destroyTerminal, updateCostDisplay, updateContextDisplay, applyThemeToAllTerminals, refreshProfileLabels } from './components/terminal-pane.js';
import { setHookStatus, notifyInterrupt } from './session-activity.js';
import { parseCost, setCostData, onChange as onCostChange } from './session-cost.js';
import { applyCliSessionName } from './session-title.js';
import { setContextData, onChange as onContextChange } from './session-context.js';
import { initNotificationSound } from './notification-sound.js';
import { initNotificationDesktop } from './notification-desktop.js';
import { init as initSessionUnread } from './session-unread.js';
import { init as initGithubUnread } from './github-unread.js';
import { initProjectTerminal, handleShellPtyData, handleShellPtyExit, isShellSessionId, applyThemeToAllShells } from './components/project-terminal.js';
import { startPolling as startGitPolling } from './git-status.js';
import { initDebugPanel, logDebugEvent } from './components/debug-panel.js';
import { initGitPanel } from './components/git-panel.js';
import { initActiveSessions } from './components/active-sessions-panel.js';
import { initUpdateBanner } from './components/update-banner.js';
import { initSessionHistory } from './components/session-history.js';
import { captureInitialContext } from './session-insights.js';
import { initInsightAlert } from './components/insight-alert.js';
import { initToolDetector } from './tools/missing-tool-detector.js';
import { initToolAlert } from './components/tool-alert.js';
import { initLargeFileDetector } from './tools/large-file-detector.js';
import { initLargeFileAlert } from './components/large-file-alert.js';
import { initSettingsGuard } from './components/settings-guard-ui.js';
import { checkWhatsNew } from './components/whats-new-dialog.js';
import { initShareManager, forwardPtyData, endShare, cleanupAllShares } from './sharing/share-manager.js';
import { isSharing } from './sharing/peer-host.js';
import { checkStarPrompt } from './components/star-prompt-dialog.js';
import { addEvents as addInspectorEvents } from './session-inspector-state.js';
import type { InspectorEvent } from '../shared/types.js';
import { getContext } from './session-context.js';
import { initSessionInspector } from './components/session-inspector.js';
import { initFilePrompt } from './components/file-prompt.js';
import { applyThemeToAllRemoteTerminals } from './components/remote-terminal-pane.js';
import { loadProviderMetas, getProviderCapabilities } from './provider-availability.js';
import { setLocale as setI18nLocale, getLocale, t } from './i18n.js';
import { resolveSystemLocale } from './system-locale.js';
import { rerenderOpenPreferencesModal } from './components/preferences-modal.js';
import type { Locale, ProviderId } from '../shared/types.js';

function initI18n(): void {
  const saved = appState.preferences.locale;
  const initial: Locale = saved ?? resolveSystemLocale(navigator.language);
  setI18nLocale(initial);
  document.documentElement.lang = initial;
  // Always persist the resolved locale: on first launch it seeds the choice,
  // and on every launch the resulting `preferences-changed` emit re-renders
  // components that already rendered during bootstrap — before load() and
  // initI18n() ran — so they pick up the effective locale immediately.
  appState.setPreference('locale', initial);
}
import { initBoard } from './components/board/board-view.js';
import { initBoardSessionSync } from './board-session-sync.js';
import { initTeamView } from './components/team/team-view.js';
import { getZoomFactor } from './zoom.js';
import { confirmAppClose } from './session-close.js';

// Theme and zoom live in persisted preferences, but `appState.load()` is an
// async IPC round-trip: waiting on it painted the default dark theme at 1.0
// zoom for the first frames before the saved values landed. Read the small
// theme/zoom slice over a synchronous channel so the very first paint already
// matches the saved preferences. `loadState()` never throws (corrupt or missing
// state falls back to defaults in main), so this cannot break bootstrap.
function applyStartupPrefs(): void {
  const prefs = window.vibeyard.store.startupPrefs();
  document.documentElement.dataset.theme = prefs.theme ?? 'dark';
  if (prefs.zoomFactor && prefs.zoomFactor !== 1.0) window.vibeyard.zoom.set(prefs.zoomFactor);
}
applyStartupPrefs();

let isQuitting = false;
window.vibeyard.app.onQuitting(() => {
  isQuitting = true;
  cleanupAllShares();
});

window.vibeyard.app.onConfirmClose(() => {
  confirmAppClose(() => window.vibeyard.app.closeConfirmed());
});

/**
 * Restored sessions whose provider mirrors its own title from a transcript poll
 * (Pi/OMP). Claude self-titles too but pushes via its statusLine hook, so it
 * needs no re-derivation and is excluded. Sent to `session:syncRestored` at
 * startup so a reopened tab whose `cliSessionId` is already known catches up to
 * a title the CLI set while Vibeyard was closed. A tab whose id was never
 * persisted stays unresolved — its title is not re-derived from a guessed
 * conversation.
 */
type RestoredSyncSession = {
  sessionId: string;
  providerId: ProviderId;
  cliSessionId: string | null;
  cwd: string;
  configDir?: string;
  createdAt: string;
};

function collectRestoredSelfTitlingSessions(): RestoredSyncSession[] {
  const out: RestoredSyncSession[] = [];
  for (const project of appState.projects) {
    for (const session of project.sessions) {
      const providerId = session.providerId;
      if (!providerId || getProviderCapabilities(providerId)?.selfTitles !== true) continue;
      const configDir = session.profileId
        ? appState.profiles.find((p) => p.id === session.profileId && p.providerId === providerId)?.configDir
        : undefined;
      out.push({
        sessionId: session.id,
        providerId,
        cliSessionId: session.cliSessionId ?? null,
        cwd: project.path,
        configDir,
        createdAt: session.createdAt,
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  // Wire PTY data/exit events from main process
  window.vibeyard.pty.onData((sessionId, data) => {
    if (isShellSessionId(sessionId)) {
      handleShellPtyData(sessionId, data);
    } else if (!isMcpSession(sessionId)) {
      handlePtyData(sessionId, data);
      parseCost(sessionId, data);
      if (data.includes('Interrupted')) {
        notifyInterrupt(sessionId);
      }
      // Forward to P2P share if active
      if (isSharing(sessionId)) {
        forwardPtyData(sessionId, data);
      }
    }
  });

  window.vibeyard.session.onSessionName((sessionId, name, cliSessionId) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('sessionName', sessionId, name);
    applyCliSessionName(sessionId, name, cliSessionId);
  });

  window.vibeyard.session.onCostData((sessionId, costData) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('costData', sessionId, costData);
    setCostData(sessionId, costData);
    const contextBefore = getContext(sessionId);
    setContextData(sessionId, costData.context_window);
    captureInitialContext(sessionId, costData.context_window);

    // Bridge cost/context into inspector events so Costs & Context tabs work.
    // Only emit when context actually changed (avoids filling the event buffer with duplicates).
    const contextAfter = getContext(sessionId);
    if (contextAfter && contextAfter !== contextBefore) {
      const syntheticEvent: InspectorEvent = {
        type: 'status_update',
        timestamp: Date.now(),
        hookEvent: 'StatusLine',
        cost_snapshot: {
          total_cost_usd: costData.cost.total_cost_usd ?? 0,
          total_duration_ms: costData.cost.total_duration_ms ?? 0,
        },
        context_snapshot: {
          total_tokens: contextAfter.totalTokens,
          context_window_size: contextAfter.contextWindowSize,
          used_percentage: contextAfter.usedPercentage,
        },
      };
      addInspectorEvents(sessionId, [syntheticEvent]);
    }
  });

  onCostChange((sessionId, cost) => {
    updateCostDisplay(sessionId, cost);
    appState.updateSessionCost(sessionId, cost);
  });

  onContextChange((sessionId, info) => {
    updateContextDisplay(sessionId, info);
    appState.updateSessionContext(sessionId, info);
  });

  window.vibeyard.session.onHookStatus((sessionId, status, hookName) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('hookStatus', sessionId, hookName ? `${hookName}: ${status}` : status);
    setHookStatus(sessionId, status, hookName);
  });

  window.vibeyard.session.onInspectorEvents((sessionId, events) => {
    if (!appState.hasSession(sessionId)) return;
    logDebugEvent('inspectorEvents', sessionId, { count: events.length });
    addInspectorEvents(sessionId, events);
  });

  window.vibeyard.session.onCliSessionId((sessionId, cliSessionId) => {
    logDebugEvent('cliSessionId', sessionId, cliSessionId);
    // Find the project containing this session and persist the CLI session ID
    const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
    if (project) {
      appState.updateSessionCliId(project.id, sessionId, cliSessionId);
    }
  });

  window.vibeyard.pty.onExit((sessionId, exitCode, signal, exitReason, pid) => {
    logDebugEvent('ptyExit', sessionId, { exitCode, signal, exitReason, pid });
    if (isShellSessionId(sessionId)) {
      handleShellPtyExit(sessionId, exitCode);
    } else if (!isMcpSession(sessionId) && !isQuitting) {
      // A rejected launch never produced a PTY: the pane already shows the
      // actionable reason (pty:data wrote it just before this exit), so
      // tearing the terminal down in this same turn hides the message and
      // archives a crash badge + crash notification for a process that never
      // ran. Keep the pane and the tab — the operator reads why, then closes
      // it (closing archives without an exitReason, i.e. no crash badge).
      if (isSpawnRejectedExitReason(exitReason)) return;
      // End any active P2P share for this session
      if (isSharing(sessionId)) {
        endShare(sessionId);
      }
      // Auto-close the session when CLI exits (skip during app quit to preserve session state)
      const project = appState.projects.find(p => p.sessions.some(s => s.id === sessionId));
      if (project) {
        destroyTerminal(sessionId);
        appState.removeSession(project.id, sessionId, { exitReason, exitCode, exitSignal: signal, processId: pid });
        if (exitReason) notifySessionCrash(exitReason);
      }
    }
  });

  // Load provider metadata before components so capabilities are available synchronously
  await loadProviderMetas();

  // Initialize components
  initSessionUnread();
  initGithubUnread();
  initSidebar();
  initTabBar();
  initSplitLayout();
  initKeybindings();
  initNotificationSound();
  initNotificationDesktop();
  initProjectTerminal();
  initDebugPanel();
  initGitPanel();
  initActiveSessions();
  initSessionHistory();
  initUpdateBanner();
  initInsightAlert();
  initToolDetector();
  initToolAlert();
  initLargeFileDetector();
  initLargeFileAlert();
  initSettingsGuard();
  initShareManager();
  initSessionInspector();
  initBoard();
  initBoardSessionSync();
  initTeamView();
  initFilePrompt();
  startGitPolling();

  function isMcpSession(sessionId: string): boolean {
    for (const project of appState.projects) {
      const session = project.sessions.find(s => s.id === sessionId);
      if (session) return session.type === 'mcp-inspector';
    }
    return false;
  }

  /** Desktop notification for an abnormal CLI exit, reusing the standard notification gate. */
  function notifySessionCrash(reason: string): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!appState.preferences.notificationsDesktop) return;
    new Notification(t('session.crashedTitle'), {
      body: t('session.crashedBody', { reason }),
      silent: true,
    });
  }

  // Log AppState events to debug panel
  const stateEvents = [
    'project-added', 'project-removed', 'project-changed',
    'session-added', 'session-removed', 'session-changed',
    'layout-changed', 'history-changed', 'insights-changed', 'state-loaded',
  ] as const;
  for (const evt of stateEvents) {
    appState.on(evt as Parameters<typeof appState.on>[0], (data) => {
      logDebugEvent('stateEvent', evt, data);
    });
  }

  // Load persisted state
  await appState.load();

// A trailing throttled persist (state.ts) may be armed at renderer unload;
// write it out before the renderer dies. This is the guarantee for
// renderer-only unloads (reload): on the app.quit() path this listener runs
// AFTER main's before-quit flushState(), and the quit-path guarantee is
// main writing the last state payload it received — not this IPC.
window.addEventListener('beforeunload', () => appState.flushPersist());

  // Re-derive titles for sessions restored from a previous run (see
  // collectRestoredSelfTitlingSessions). Main mirrors each tab's title from
  // its transcript only when the conversation id is already known; an unknown
  // id stays unresolved (ownership is not inferred from cwd + creation time).
  const restored = collectRestoredSelfTitlingSessions();
  if (restored.length) {
    await window.vibeyard.session.syncRestored(restored);
  }

  // A restored tab that is closed without ever being resumed has no PTY exit to
  // tear down its transcript-sync entry; release it here. A live session's exit
  // already cleaned up in main, so this is an idempotent no-op for it.
  appState.on('session-removed', (data) => {
    const { sessionId } = data as { sessionId: string };
    window.vibeyard.session.release(sessionId);
  });

  // Apply the persisted locale (OS fallback on first launch). The always-on
  // persist inside initI18n emits `preferences-changed`, re-rendering the
  // components that already painted during bootstrap in the default locale.
  initI18n();

  // Apply theme from loaded preferences
  const initialTheme = appState.preferences.theme ?? 'dark';
  document.documentElement.dataset.theme = initialTheme;

  // Re-apply theme (and re-theme terminals) whenever preferences change.
  // Also handles locale change: re-translate the open preferences modal in
  // place; components that render on `preferences-changed` (sidebar, active
  // sessions, board) and `onLocaleChange` subscribers re-translate themselves.
  let lastLocale = getLocale();
  let lastAutoTitle = appState.preferences.autoTitleEnabled;
  appState.on('preferences-changed', () => {
    const theme = appState.preferences.theme ?? 'dark';
    document.documentElement.dataset.theme = theme;
    applyThemeToAllTerminals(theme);
    applyThemeToAllShells(theme);
    applyThemeToAllRemoteTerminals(theme);

    // Titles already on disk produce no new fs event (the hook writes only on
    // change), so re-enabling auto-naming needs an explicit replay.
    const autoTitle = appState.preferences.autoTitleEnabled;
    if (autoTitle && !lastAutoTitle) window.vibeyard.session.resyncStatus();
    lastAutoTitle = autoTitle;

    const newLocale = appState.preferences.locale;
    if (newLocale && newLocale !== lastLocale) {
      lastLocale = newLocale;
      setI18nLocale(newLocale);
      document.documentElement.lang = newLocale;
      rerenderOpenPreferencesModal();
    }
  });
  // Adding/removing a profile changes whether the status-line profile label is shown.
  appState.on('profiles-changed', () => refreshProfileLabels());

  const savedZoom = getZoomFactor();
  if (savedZoom !== 1.0) window.vibeyard.zoom.set(savedZoom);

  // Auto-open new project modal when no projects exist
  if (appState.projects.length === 0) {
    promptNewProject();
  }

  checkWhatsNew();
  checkStarPrompt();
}

main().catch(console.error);
