import { appState } from './state.js';
import { onChange, type SessionStatus } from './session-activity.js';

// C4S-09: per-session minimum spacing. A flapping status edge (working →
// waiting → working …) used to stack a fresh OS banner every 2 s transition.
const MIN_NOTIFY_INTERVAL_MS = 30_000;
const lastNotifiedAt = new Map<string, number>();
const previousStatus = new Map<string, SessionStatus>();

// Retain live notifications so their onclick closures aren't garbage-collected
// before the user clicks, and so a stale banner can be dismissed explicitly.
const activeNotifications = new Map<string, Notification>();

function bodyForStatus(name: string, status: SessionStatus): string {
  if (status === 'input') return `${name} needs your input to continue`;
  if (status === 'completed') return `${name} has completed`;
  return `${name} is waiting for input`;
}

/** Dismiss this session's live banner, if any, and forget it. */
function dismiss(sessionId: string): void {
  activeNotifications.get(sessionId)?.close();
  activeNotifications.delete(sessionId);
}

function showNotification(sessionId: string, status: SessionStatus): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const found = appState.findSessionWithProject(sessionId);

  // Dismiss this session's previous banner ourselves — macOS gives every banner
  // its own identifier, so nothing replaces it automatically.
  dismiss(sessionId);

  // Deliberately no `tag`: Chromium uses the tag as a non-persistent
  // notification's id, and registering a second notification under an id it
  // already knows destroys the first one's click listener — while that banner
  // is still sitting in Notification Center. Clicking it then does nothing but
  // raise the app. Without a tag each notification gets its own id and listener.
  const notification = new Notification(found?.project.name ?? 'FineVibe', {
    body: bodyForStatus(found?.session.name ?? 'Session', status),
    silent: true,
  });
  activeNotifications.set(sessionId, notification);

  notification.onclick = () => {
    window.finevibe.app.focus();
    // Re-resolve rather than capturing `found`: the session may have been
    // renamed or moved, and capturing it would pin the whole ProjectRecord
    // alive for as long as this retained notification lives.
    const project = appState.findSessionWithProject(sessionId)?.project;
    if (project) {
      appState.setActiveProject(project.id);
      appState.setActiveSession(project.id, sessionId);
    }
    notification.close(); // `onclose` evicts the map entry.
  };

  notification.onclose = () => {
    // An OS-initiated close can arrive after a replacement was registered, so
    // only drop the entry if it still points at this instance.
    if (activeNotifications.get(sessionId) === notification) activeNotifications.delete(sessionId);
  };
}

export function initNotificationDesktop(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  onChange((sessionId: string, status: SessionStatus) => {
    const prev = previousStatus.get(sessionId);
    previousStatus.set(sessionId, status);

    if (!appState.preferences.notificationsDesktop) return;
    if (prev !== 'working') return;
    if (status !== 'waiting' && status !== 'completed' && status !== 'input') return;
    if (document.hasFocus() && sessionId === appState.activeProject?.activeSessionId) return;

    const now = Date.now();
    const last = lastNotifiedAt.get(sessionId);
    if (last !== undefined && now - last < MIN_NOTIFY_INTERVAL_MS) return;
    lastNotifiedAt.set(sessionId, now);
    showNotification(sessionId, status);
  });

  appState.on('session-removed', (data) => {
    const sessionId = (data as { sessionId: string })?.sessionId;
    if (sessionId) {
      previousStatus.delete(sessionId);
      lastNotifiedAt.delete(sessionId);
      dismiss(sessionId);
    }
  });
}

export function _resetForTesting(): void {
  previousStatus.clear();
  activeNotifications.clear();
  lastNotifiedAt.clear();
}
