// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../shared/types.js';
import { initHostTabs } from './host-tabs.js';
import { appState } from '../state.js';

// Sidebar host tab row (Phase 2 T4, parent §11 UR-1). Model: hosts-section
// .test.ts — the registry + modal + preferences edges are mocked, the
// component's DOM, i18n (real en) and appState interactions are exercised.

const registry = vi.hoisted(() => ({
  hosts: [] as HostRecord[],
  loaded: true,
  offline: new Set<string>(),
  loadHosts: vi.fn(async () => {}),
  reconnectHost: vi.fn(async (id: string) => { registry.offline.delete(id); }),
  listeners: [] as Array<() => void>,
}));

const confirmCalls: Array<{ title: string; message: string; onConfirm: () => void }> = [];

vi.mock('../host-registry.js', () => ({
  getEnrolledHosts: () => registry.hosts.filter((h) => h.enrollmentStatus === 'enrolled' || h.enrollmentStatus === 'partial'),
  getHost: (id: string) => registry.hosts.find((h) => h.id === id),
  getHostColor: (id: string) => registry.hosts.find((h) => h.id === id)?.color ?? '',
  hostsLoaded: () => registry.loaded,
  isHostOffline: (id: string) => registry.offline.has(id),
  initHostRegistry: vi.fn(),
  loadHosts: registry.loadHosts,
  onHostsChange: (cb: () => void) => { registry.listeners.push(cb); return () => {}; },
  reconnectHost: registry.reconnectHost,
}));

const showPreferencesModal = vi.hoisted(() => vi.fn());
vi.mock('./preferences-modal.js', () => ({ showPreferencesModal }));
const closeModal = vi.hoisted(() => vi.fn());
vi.mock('./modal.js', () => ({
  closeModal,
  showConfirmDialog: (title: string, message: string, opts: { onConfirm: () => void }) => {
    confirmCalls.push({ title, message, onConfirm: opts.onConfirm });
  },
}));

const ipc = vi.hoisted(() => ({
  enroll: vi.fn(async () => ({ ok: true, steps: [] })),
  unenroll: vi.fn(async () => ({ ok: true })),
  del: vi.fn(async () => {}),
}));

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'h1', name: 'zen', user: 'dev', host: '10.0.0.5', port: 22,
    authKind: 'key', managedKey: false, enrollmentStatus: 'enrolled', color: '#4c9aff',
    ...overrides,
  } as HostRecord;
}

function init(): void {
  initHostTabs();
}

function strip(): HTMLElement {
  return document.getElementById('sidebar-host-tabs-strip')!;
}

function tabs(): HTMLElement[] {
  return Array.from(strip().querySelectorAll<HTMLElement>('.host-tab'));
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmCalls.length = 0;
  registry.hosts = [];
  registry.loaded = true;
  registry.offline = new Set();
  registry.listeners.length = 0;
  appState.setPreference('activeHostId', undefined);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  Object.defineProperty(window, 'finevibe', {
    configurable: true,
    value: { hosts: { enroll: ipc.enroll, unenroll: ipc.unenroll, delete: ipc.del } },
  });
  document.body.innerHTML = `
    <div id="sidebar-host-tabs">
      <button id="host-tabs-scroll-left" class="icon-btn host-tabs-arrow hidden"></button>
      <div id="sidebar-host-tabs-strip"></div>
      <button id="host-tabs-scroll-right" class="icon-btn host-tabs-arrow hidden"></button>
      <button id="host-tabs-add" class="icon-btn"></button>
    </div>
    <div id="sidebar-content"></div>`;
});

describe('host tab row (parent §11 UR-1)', () => {
  it('pins Local first, then one tab per enrolled host in registry order', async () => {
    registry.hosts = [
      host({ id: 'h1', name: 'zen' }),
      host({ id: 'h2', name: 'box', enrollmentStatus: 'draft' }),
      host({ id: 'h3', name: 'pix', enrollmentStatus: 'partial' }),
    ];
    await init();

    expect(tabs().map((t) => t.dataset.hostId)).toEqual(['local', 'h1', 'h3']);
    expect(tabs()[0].textContent).toBe('Local');
    // Local is the neutral identity: no dot, palette colors on the rest.
    expect(tabs()[0].querySelector('.hosts-dot')).toBeNull();
    expect(tabs()[1].querySelector('.hosts-dot')).not.toBeNull();
  });

  it('renders the host name in the host color; Local stays neutral', async () => {
    registry.hosts = [host()];
    await init();

    const [local, zen] = tabs();
    expect(zen.querySelector('.host-tab-name')!.style.color).toBe('rgb(76, 154, 255)');
    expect(local.querySelector('.host-tab-name')!.style.color).toBe('');
  });

  it('clicking a tab persists the selection through appState.setActiveHost', async () => {
    registry.hosts = [host()];
    init();

    tabs()[1].click();
    expect(appState.preferences.activeHostId).toBe('h1');
    tabs()[0].click();
    expect(appState.preferences.activeHostId).toBeUndefined();
  });

  it('falls back to Local when the active host is removed from the registry', async () => {
    appState.setPreference('activeHostId', 'gone');
    registry.hosts = [];
    registry.loaded = true;
    init();

    expect(appState.preferences.activeHostId).toBeUndefined();
  });

  it('an UNLOADED registry never wipes the persisted active host (audit T4 #1)', async () => {
    registry.loaded = false; // startup: hosts:list not resolved yet
    appState.setPreference('activeHostId', 'h1');
    registry.hosts = [host()];
    init();

    expect(appState.preferences.activeHostId).toBe('h1');
    registry.loaded = true;
    registry.hosts = [];
    registry.listeners.forEach((cb) => cb());
    expect(appState.preferences.activeHostId).toBeUndefined();
  });

  it('offline active host shows the banner; Reconnect probes and repaints', async () => {
    registry.hosts = [host()];
    registry.offline.add('h1');
    appState.setPreference('activeHostId', 'h1');
    init();

    const banner = document.querySelector<HTMLElement>('.host-offline-banner')!;
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toContain('zen is unreachable');

    banner.querySelector('button')!.click();
    expect(registry.reconnectHost).toHaveBeenCalledWith('h1');
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.host-offline-banner')!.classList.contains('hidden')).toBe(true);
  });

  it('local never shows the offline banner', async () => {
    registry.hosts = [host()];
    registry.offline.add('h1');
    init();
    expect(document.querySelector('.host-offline-banner')!.classList.contains('hidden')).toBe(true);
  });

  it('tab context menu offers Settings→Hosts / Re-enroll / Remove', async () => {
    registry.hosts = [host()];
    init();

    tabs()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    const items = Array.from(document.querySelectorAll('.tab-context-menu .tab-context-menu-item'));
    expect(items.map((i) => i.textContent)).toEqual(['Settings → Hosts', 'Re-enroll', 'Remove']);

    items[1].click(); // Re-enroll
    expect(ipc.enroll).toHaveBeenCalledWith('h1');
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.loadHosts).toHaveBeenCalled();
  });

  it('Remove asks for confirmation, then unenrolls + deletes and clears the selection', async () => {
    registry.hosts = [host()];
    appState.setPreference('activeHostId', 'h1');
    init();

    tabs()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 }));
    const remove = Array.from(document.querySelectorAll('.tab-context-menu-item')).find((i) => i.textContent === 'Remove')!;
    remove.click();
    expect(confirmCalls).toHaveLength(1);
    confirmCalls[0].onConfirm();
    await new Promise((r) => setTimeout(r, 0));

    expect(ipc.unenroll).toHaveBeenCalledWith('h1');
    expect(ipc.del).toHaveBeenCalledWith('h1');
    expect(appState.preferences.activeHostId).toBeUndefined();
  });

  it('the trailing + opens Settings → Hosts (the add-host wizard section)', async () => {
    init();
    document.getElementById('host-tabs-add')!.click();
    expect(showPreferencesModal).toHaveBeenCalledWith('hosts');
  });
});
