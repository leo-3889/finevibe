// Sidebar host tab row (multi-host Phase 2 T4, parent §11 UR-1): a strip
// between the sidebar header and the project list. `Local` is pinned first
// (implicit host HOST_LOCAL='local', never a HostRecord), then one tab per
// ENROLLED host in registry order. The tab name carries the host's identity
// color; the status dot reuses the Settings→Hosts status colors, fed by
// `hosts:status` reloads (host-registry). Clicking a tab scopes the project
// list (Preferences.activeHostId, persisted); a removed host falls back to
// Local. A non-local active host whose freshest reachability answer is "no"
// gets an offline banner + Reconnect above the project list. Overflow scrolls
// with chevrons; the trailing `+` opens the add-host entry (Settings → Hosts,
// where the wizard lives). All DOM is createElement/textContent (ui-dev).

import { appState } from '../state.js';
import { LOCAL_HOST_ID } from '../../shared/types.js';
import { t, onLocaleChange } from '../i18n.js';
import {
  getEnrolledHosts, getHost, getHostColor, hostsLoaded, isHostOffline,
  initHostRegistry, loadHosts, onHostsChange, reconnectHost,
} from '../host-registry.js';
import { showPreferencesModal } from './preferences-modal.js';
import { showConfirmDialog, closeModal } from './modal.js';
import { hideTabContextMenu, setActiveContextMenu, positionMenu } from './tab-bar/menu.js';

let containerEl: HTMLElement | null = null;
let stripEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let reconnecting = false;

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildTab(hostId: string): HTMLElement {
  const isLocal = hostId === LOCAL_HOST_ID;
  const host = isLocal ? undefined : getHost(hostId);
  const tab = el('button', 'host-tab') as HTMLButtonElement;
  tab.type = 'button';
  tab.dataset.hostId = hostId;
  tab.classList.toggle('active', appState.activeHostId === hostId);
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', appState.activeHostId === hostId ? 'true' : 'false');

  // Local has no record and no dot (always reachable, neutral identity —
  // plan §5); enrolled hosts reuse the Settings→Hosts dot colors, with the
  // failed color as the offline override (parent §11).
  if (host) {
    const offline = isHostOffline(host.id);
    const dot = el('span', `hosts-dot ${offline ? 'failed' : host.enrollmentStatus}`);
    dot.title = t(offline ? 'hosts.hostUnreachable' : `hosts.status.${host.enrollmentStatus}`);
    tab.appendChild(dot);
  }

  const name = el('span', 'host-tab-name');
  name.textContent = isLocal ? t('sidebar.hostTabs.local') : (host?.name ?? hostId);
  if (!isLocal) {
    const color = getHostColor(hostId);
    // Style-attribute gate (plan §7): getHostColor returns only validated
    // #rrggbb; '' leaves the CSS default text color.
    if (color) name.style.color = color;
    tab.title = `${host?.user ?? ''}@${host?.host ?? ''}`;
  }
  tab.appendChild(name);

  tab.addEventListener('click', () => appState.setActiveHost(hostId));
  if (!isLocal && host) tab.addEventListener('contextmenu', (e) => showHostTabMenu(e, host.id));
  return tab;
}

function showHostTabMenu(e: MouseEvent, hostId: string): void {
  e.preventDefault();
  hideTabContextMenu();
  const host = getHost(hostId);
  if (!host) return;

  const menu = el('div', 'tab-context-menu');
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  const item = (label: string, onPick: () => void): void => {
    const mi = el('div', 'tab-context-menu-item', label);
    mi.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideTabContextMenu();
      onPick();
    });
    menu.appendChild(mi);
  };

  item(t('sidebar.hostTabs.menu.settings'), () => showPreferencesModal('hosts'));
  item(t('sidebar.hostTabs.menu.reenroll'), () => {
    void window.finevibe.hosts.enroll(hostId).then(() => loadHosts()).catch(() => {});
  });
  menu.appendChild(el('div', 'tab-context-menu-separator'));
  item(t('sidebar.hostTabs.menu.remove'), () => {
    const enrolled = host.enrollmentStatus === 'enrolled' || host.enrollmentStatus === 'partial';
    showConfirmDialog(t('hosts.remove'), t(enrolled ? 'hosts.confirmRemoveEnrolled' : 'hosts.confirmRemove', { name: host.name }), {
      confirmLabel: t('hosts.remove'),
      onConfirm: () => {
        closeModal();
        void (async () => {
          if (enrolled) await window.finevibe.hosts.unenroll(hostId).catch(() => {});
          await window.finevibe.hosts.delete(hostId).catch(() => {});
          if (appState.preferences.activeHostId === hostId) appState.setActiveHost(LOCAL_HOST_ID);
          await loadHosts().catch(() => {});
        })();
      },
    });
  });

  document.body.appendChild(menu);
  setActiveContextMenu(menu);
  positionMenu(menu);
}

function renderBanner(): void {
  if (!bannerEl) return;
  const activeId = appState.activeHostId;
  const offline = isHostOffline(activeId);
  bannerEl.classList.toggle('hidden', !offline);
  bannerEl.replaceChildren();
  if (!offline) return;
  const host = getHost(activeId);
  bannerEl.appendChild(el('span', 'host-offline-text', t('sidebar.hostTabs.offline', { name: host?.name ?? activeId })));
  const btn = el('button', 'btn-secondary btn-sm', t('sidebar.hostTabs.reconnect')) as HTMLButtonElement;
  btn.disabled = reconnecting;
  btn.addEventListener('click', () => {
    if (reconnecting) return;
    reconnecting = true;
    btn.disabled = true;
    void reconnectHost(activeId)
      .catch(() => false)
      .finally(() => {
        reconnecting = false;
        render();
      });
  });
  bannerEl.appendChild(btn);
}

function syncArrows(): void {
  if (!containerEl || !stripEl) return;
  const overflow = stripEl.scrollWidth > stripEl.clientWidth + 1;
  for (const arrow of containerEl.querySelectorAll<HTMLElement>('.host-tabs-arrow')) {
    arrow.classList.toggle('hidden', !overflow);
  }
}

function render(): void {
  if (!stripEl) return;
  hideTabContextMenu();
  // Locale-owned labels for the static index.html chrome (audit T4 #6);
  // render() re-runs on locale change via onLocaleChange.
  for (const [id, key] of [
    ['host-tabs-scroll-left', 'sidebar.hostTabs.scrollLeft'],
    ['host-tabs-scroll-right', 'sidebar.hostTabs.scrollRight'],
    ['host-tabs-add', 'sidebar.hostTabs.add'],
  ] as const) {
    containerEl?.querySelector(`#${id}`)?.setAttribute('aria-label', t(key));
  }
  hideTabContextMenu();
  // A removed host falls back to Local (parent §11 selection semantics). The
  // re-entrant render from `preferences-changed` sees activeHostId === 'local'
  // and skips, so this cannot loop. Two gates on the fallback (audit T4 #1/#4):
  // the registry must have LOADED (startup/fetch-failure empties are not
  // removals), and the predicate is the ENROLLED strip list — a host regressed
  // to draft/failed has no tab either, and would strand the filter.
  const activeId = appState.activeHostId;
  if (activeId !== LOCAL_HOST_ID && hostsLoaded() && !getEnrolledHosts().some((h) => h.id === activeId)) {
    appState.setActiveHost(LOCAL_HOST_ID);
    return;
  }

  const frag = document.createDocumentFragment();
  frag.appendChild(buildTab(LOCAL_HOST_ID));
  for (const host of getEnrolledHosts()) frag.appendChild(buildTab(host.id));
  stripEl.replaceChildren(frag);
  syncArrows();
  renderBanner();
}

export function initHostTabs(): void {
  containerEl = document.getElementById('sidebar-host-tabs');
  stripEl = document.getElementById('sidebar-host-tabs-strip');
  if (!containerEl || !stripEl) return;
  const contentEl = document.getElementById('sidebar-content');

  bannerEl = el('div', 'host-offline-banner hidden');
  contentEl?.insertBefore(bannerEl, contentEl.firstChild);

  initHostRegistry();
  onHostsChange(render);
  appState.on('preferences-changed', render);
  appState.on('state-loaded', render);
  onLocaleChange(render);

  // Overflow chevrons (parent §11): scroll the strip, shown only on overflow.
  const left = containerEl.querySelector<HTMLElement>('#host-tabs-scroll-left');
  const right = containerEl.querySelector<HTMLElement>('#host-tabs-scroll-right');
  left?.addEventListener('click', () => stripEl!.scrollBy({ left: -120 }));
  right?.addEventListener('click', () => stripEl!.scrollBy({ left: 120 }));
  stripEl.addEventListener('scroll', syncArrows, { passive: true });
  new ResizeObserver(syncArrows).observe(stripEl);

  // Trailing `+` (parent §11): the add-host wizard lives in Settings → Hosts,
  // so the button opens that section (the wizard's one-hop entry point).
  containerEl.querySelector<HTMLElement>('#host-tabs-add')
    ?.addEventListener('click', () => showPreferencesModal('hosts'));

  render();
}
